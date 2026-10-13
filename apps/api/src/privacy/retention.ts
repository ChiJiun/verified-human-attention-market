import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../db/client.js";

/**
 * Retention enforcement (#22, docs/privacy/DATA_RETENTION.md).
 *
 * Every step is idempotent: scrubbed values are derived deterministically
 * from the row id, so re-running changes nothing. Settlement facts (campaign
 * rows, accepted submissions, claim nonces, chain events) are never deleted;
 * the chain is authoritative and those rows back advertiser analytics and
 * disputes.
 */

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionPolicy {
  /** Days after campaign end before answers are deleted. */
  answersDays: number;
  /** Days after campaign end before participant keys are retired. */
  participantKeyDays: number;
  /** Days after campaign end before unpaid wallet links are pseudonymized. */
  unpaidWalletDays: number;
  /** Days after expiry before SIWE nonces are deleted. */
  authNonceDays: number;
  /** Days after expiry or revocation before SIWE sessions are deleted. */
  authSessionDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  answersDays: 30,
  participantKeyDays: 30,
  unpaidWalletDays: 30,
  authNonceDays: 1,
  authSessionDays: 30,
};

/**
 * Claim authorizations cannot be issued after campaign end and expire within
 * this TTL (contract MAX_AUTHORIZATION_TTL), so after end + TTL no flow
 * needs the participant key or an unpaid wallet link any more.
 */
export const ISSUANCE_SETTLED_MS = 15 * 60_000;

export interface RetentionResult {
  answersDeleted: number;
  participantKeysRetired: number;
  walletLinksPseudonymized: number;
  authNoncesDeleted: number;
  authSessionsDeleted: number;
}

const retiredKey = (idColumn: SQL) =>
  sql`encode(sha256(convert_to('vham:retired-participant:' || ${idColumn}::text, 'UTF8')), 'hex')`;

const retiredWallet = (eligibilityIdColumn: SQL) =>
  sql`'0x' || substr(encode(sha256(convert_to('vham:retired-wallet:' || ${eligibilityIdColumn}::text, 'UTF8')), 'hex'), 1, 40)`;

type Executor = Pick<Database, "execute">;

/** Raw `sql` does not serialize Date params with postgres-js: cast an ISO string. */
const at = (date: Date) => sql`${date.toISOString()}::timestamptz`;

async function count(db: Executor, query: SQL): Promise<number> {
  const rows = await db.execute(query);
  return rows.length;
}

async function scrubCampaignData(
  db: Database,
  cutoffs: { answers: Date; participantKeys: Date; unpaidWallets: Date },
  wallet: string | null,
) {
  const walletFilter = (column: SQL) =>
    wallet === null ? sql`` : sql`AND ${column} = ${wallet}`;

  // Wallets that were paid (accepted) stay: they match public on-chain
  // Claimed events and back disputes. Unpaid wallet ↔ campaign links exist
  // only here, so they are replaced by an unlinkable placeholder address.
  const targets = sql`SELECT e.id FROM eligibility e
      JOIN campaigns c ON c.id = e.campaign_id
      WHERE c.end_at < ${at(cutoffs.unpaidWallets)}
        ${walletFilter(sql`e.claimant_address`)}
        AND NOT EXISTS (
          SELECT 1 FROM submissions s
          WHERE s.eligibility_id = e.id AND s.result = 'accepted'
        )`;

  return db.transaction(async (tx) => {
    const answersDeleted = await count(
      tx,
      sql`DELETE FROM answers a
        USING submissions s, campaigns c
        WHERE a.submission_id = s.id
          AND s.campaign_id = c.id
          AND c.end_at < ${at(cutoffs.answers)}
          ${walletFilter(sql`s.claimant_address`)}
        RETURNING a.id`,
    );

    const participantKeysRetired = await count(
      tx,
      sql`UPDATE eligibility e
        SET participant_key = ${retiredKey(sql`e.id`)}
        FROM campaigns c
        WHERE e.campaign_id = c.id
          AND c.end_at < ${at(cutoffs.participantKeys)}
          AND e.participant_key <> ${retiredKey(sql`e.id`)}
          ${walletFilter(sql`e.claimant_address`)}
        RETURNING e.id`,
    );

    await tx.execute(
      sql`UPDATE submissions s
          SET claimant_address = ${retiredWallet(sql`s.eligibility_id`)}
          WHERE s.eligibility_id IN (${targets})
            AND s.claimant_address <> ${retiredWallet(sql`s.eligibility_id`)}`,
    );
    const walletLinksPseudonymized = await count(
      tx,
      sql`UPDATE eligibility e
          SET claimant_address = ${retiredWallet(sql`e.id`)}
          WHERE e.id IN (${targets})
            AND e.claimant_address <> ${retiredWallet(sql`e.id`)}
          RETURNING e.id`,
    );

    return {
      answersDeleted,
      participantKeysRetired,
      walletLinksPseudonymized,
    };
  });
}

/** Scheduled enforcement of the retention policy. */
export async function applyRetention(
  db: Database,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<RetentionResult> {
  const daysAgo = (days: number) =>
    new Date(now.getTime() - ISSUANCE_SETTLED_MS - days * DAY_MS);

  const scrubbed = await scrubCampaignData(
    db,
    {
      answers: daysAgo(policy.answersDays),
      participantKeys: daysAgo(policy.participantKeyDays),
      unpaidWallets: daysAgo(policy.unpaidWalletDays),
    },
    null,
  );

  const authNoncesDeleted = await count(
    db,
    sql`DELETE FROM auth_nonces
        WHERE expires_at < ${at(new Date(now.getTime() - policy.authNonceDays * DAY_MS))}
        RETURNING nonce`,
  );
  const authSessionsDeleted = await count(
    db,
    sql`DELETE FROM auth_sessions
        WHERE LEAST(COALESCE(revoked_at, expires_at), expires_at)
          < ${at(new Date(now.getTime() - policy.authSessionDays * DAY_MS))}
        RETURNING id`,
  );

  return { ...scrubbed, authNoncesDeleted, authSessionsDeleted };
}

export interface ErasureResult extends RetentionResult {
  /** Campaigns still issuing claims; handled by scheduled retention later. */
  campaignsStillOpen: number;
}

/**
 * Erasure request for one wallet. Applies the campaign scrubbing at once for
 * every campaign whose claim issuance has settled, and signs the wallet out.
 * Paid wallets stay on settlement records (and are public on-chain anyway).
 */
export async function eraseWallet(
  db: Database,
  address: string,
  now: Date,
): Promise<ErasureResult> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("address must be a 20-byte hex address");
  }

  const wallet = address.toLowerCase();
  const settled = new Date(now.getTime() - ISSUANCE_SETTLED_MS);

  const scrubbed = await scrubCampaignData(
    db,
    { answers: settled, participantKeys: settled, unpaidWallets: settled },
    wallet,
  );
  const authSessionsDeleted = await count(
    db,
    sql`DELETE FROM auth_sessions WHERE address = ${wallet} RETURNING id`,
  );
  const campaignsStillOpen = await count(
    db,
    sql`SELECT DISTINCT e.campaign_id FROM eligibility e
        JOIN campaigns c ON c.id = e.campaign_id
        WHERE e.claimant_address = ${wallet} AND c.end_at >= ${at(settled)}`,
  );

  return {
    ...scrubbed,
    authNoncesDeleted: 0,
    authSessionsDeleted,
    campaignsStillOpen,
  };
}
