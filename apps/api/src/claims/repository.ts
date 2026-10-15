import { draftRefFor } from "../campaigns/onchain.js";
import { and, count, eq, gt, isNotNull, ne, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";

import type { Database } from "../db/client.js";
import { campaigns, submissions } from "../db/schema.js";
import type { SignedClaim } from "./signer.js";

export class ClaimIssueError extends Error {
  constructor(
    readonly code:
      | "SUBMISSION_NOT_ACCEPTED"
      | "CAMPAIGN_NOT_ACTIVE"
      | "CAMPAIGN_CAP_REACHED"
      | "ALREADY_CLAIMED"
      | "DAILY_LIMIT_REACHED",
  ) {
    super(code);
  }
}

export interface ClaimIssueInput {
  submissionId: string;
  campaignId: string;
  now: Date;
  canIssue: boolean;
  /** Live `claimedWallet(campaignId, claimant)`: this wallet was paid. */
  alreadyClaimed: boolean;
  /** Live on-chain paid completions for the campaign. */
  onchainPaidCompletions: number;
  sign: () => Promise<SignedClaim>;
  /**
   * Global 24 h payout-liability circuit breaker (#23): rewards of all
   * authorizations issued in the last 24 h, plus this one, must stay within
   * `limitAtomic`. Serialized with an advisory lock in PostgreSQL.
   */
  dailyLimit?: { limitAtomic: bigint; rewardAtomic: bigint } | null;
}

export const DAY_MS = 24 * 60 * 60_000;

export interface ClaimIssueResult {
  claim: SignedClaim;
  created: boolean;
}

export interface IssuedClaim {
  claimant: string;
  nonce: string;
}

export interface ClaimRepository {
  issueOnce(input: ClaimIssueInput): Promise<ClaimIssueResult>;
  /** Latest authorization per accepted submission (for reconciliation). */
  listIssuedClaims(campaignId: string): Promise<IssuedClaim[]>;
}

function storedClaim(row: typeof submissions.$inferSelect): SignedClaim | null {
  if (
    !row.claimNonce ||
    !row.claimSignature ||
    !row.claimIssuedAt ||
    !row.claimExpiresAt ||
    !row.claimContractAddress ||
    !row.claimChainId
  ) {
    return null;
  }

  return {
    payload: {
      campaignId: 0n, // Filled with the campaign's canonical on-chain id below.
      draftRef: "0x", // Filled with the campaign's draft reference below.
      claimant: row.claimantAddress as Address,
      amount: 0n, // Filled with the campaign reward below.
      nonce: row.claimNonce as Hex,
      issuedAt: BigInt(Math.floor(row.claimIssuedAt.getTime() / 1000)),
      expiresAt: BigInt(Math.floor(row.claimExpiresAt.getTime() / 1000)),
    },
    signature: row.claimSignature as Hex,
    chainId: row.claimChainId,
    contractAddress: row.claimContractAddress as Address,
  };
}

/** Unexpired stored authorization, or null if none / expired. */
function restoreClaim(
  row: typeof submissions.$inferSelect,
  campaign: typeof campaigns.$inferSelect,
  now: Date,
): SignedClaim | null {
  const claim = storedClaim(row);
  if (!claim) return null;
  if (row.claimExpiresAt!.getTime() <= now.getTime()) {
    return null;
  }
  if (!campaign.onchainCampaignId) {
    throw new ClaimIssueError("CAMPAIGN_NOT_ACTIVE");
  }
  claim.payload.campaignId = BigInt(campaign.onchainCampaignId);
  claim.payload.draftRef = draftRefFor(campaign.id);
  claim.payload.amount = BigInt(campaign.rewardAtomic);
  return claim;
}

/** Campaign-row lock serializes issuance and bounds signed liabilities. */
export class PostgresClaimRepository implements ClaimRepository {
  constructor(private readonly db: Database) {}

  async issueOnce(input: ClaimIssueInput): Promise<ClaimIssueResult> {
    return this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .select()
        .from(campaigns)
        .where(eq(campaigns.id, input.campaignId))
        .for("update")
        .limit(1);

      if (!campaign || !campaign.onchainCampaignId) {
        throw new ClaimIssueError("CAMPAIGN_NOT_ACTIVE");
      }

      const [row] = await tx
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.id, input.submissionId),
            eq(submissions.campaignId, input.campaignId),
          ),
        )
        .limit(1);

      if (!row || row.result !== "accepted") {
        throw new ClaimIssueError("SUBMISSION_NOT_ACCEPTED");
      }

      const prior = restoreClaim(row, campaign, input.now);
      if (prior) return { claim: prior, created: false };

      // Reissue only if no earlier authorization was redeemed: the contract
      // pays each wallet once, so a new nonce cannot cause a second payout.
      if (input.alreadyClaimed) {
        throw new ClaimIssueError("ALREADY_CLAIMED");
      }

      if (!input.canIssue || campaign.status !== "active") {
        throw new ClaimIssueError("CAMPAIGN_NOT_ACTIVE");
      }

      // Every unexpired authorization must stay redeemable:
      // paid on-chain + outstanding (unexpired, other submissions) < cap.
      const [outstanding] = await tx
        .select({ value: count() })
        .from(submissions)
        .where(
          and(
            eq(submissions.campaignId, input.campaignId),
            gt(submissions.claimExpiresAt, input.now),
            ne(submissions.id, input.submissionId),
          ),
        );

      if (
        (outstanding?.value ?? 0) + input.onchainPaidCompletions >=
        campaign.maxCompletions
      ) {
        throw new ClaimIssueError("CAMPAIGN_CAP_REACHED");
      }

      if (input.dailyLimit) {
        // One global lock: concurrent issuances cannot overshoot the limit.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('vham:daily-payout-limit'))`,
        );
        const since = new Date(input.now.getTime() - DAY_MS).toISOString();
        const [issued] = await tx.execute<{ total: string }>(
          sql`SELECT COALESCE(SUM(c.reward_atomic), 0)::text AS total
              FROM submissions s JOIN campaigns c ON c.id = s.campaign_id
              WHERE s.claim_issued_at > ${since}::timestamptz
                AND s.id <> ${input.submissionId}`,
        );

        if (
          BigInt(issued?.total ?? "0") + input.dailyLimit.rewardAtomic >
          input.dailyLimit.limitAtomic
        ) {
          throw new ClaimIssueError("DAILY_LIMIT_REACHED");
        }
      }

      const claim = await input.sign();
      if (
        claim.payload.campaignId !== BigInt(campaign.onchainCampaignId) ||
        claim.payload.draftRef !== draftRefFor(campaign.id) ||
        claim.payload.claimant.toLowerCase() !== row.claimantAddress ||
        claim.payload.amount !== BigInt(campaign.rewardAtomic) ||
        claim.chainId !== campaign.chainId ||
        claim.payload.issuedAt >
          BigInt(Math.floor(input.now.getTime() / 1000)) ||
        claim.payload.expiresAt <= claim.payload.issuedAt ||
        claim.payload.expiresAt - claim.payload.issuedAt > 900n
      ) {
        throw new Error("Claim signer returned an invalid authorization");
      }
      await tx
        .update(submissions)
        .set({
          claimNonce: claim.payload.nonce,
          claimSignature: claim.signature,
          claimContractAddress: claim.contractAddress.toLowerCase(),
          claimChainId: claim.chainId,
          claimIssuedAt: new Date(Number(claim.payload.issuedAt) * 1000),
          claimExpiresAt: new Date(Number(claim.payload.expiresAt) * 1000),
          updatedAt: input.now,
        })
        .where(eq(submissions.id, input.submissionId));

      return { claim, created: true };
    });
  }

  async listIssuedClaims(campaignId: string): Promise<IssuedClaim[]> {
    const rows = await this.db
      .select({
        claimant: submissions.claimantAddress,
        nonce: submissions.claimNonce,
      })
      .from(submissions)
      .where(
        and(
          eq(submissions.campaignId, campaignId),
          eq(submissions.result, "accepted"),
          isNotNull(submissions.claimNonce),
        ),
      );
    return rows.map((row) => ({ claimant: row.claimant, nonce: row.nonce! }));
  }
}

/** Test/local repository with the same one-time issuance and cap behavior. */
export class InMemoryClaimRepository implements ClaimRepository {
  private readonly records = new Map<
    string,
    { campaignId: string; claim: SignedClaim }
  >();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly getSubmission: (
      id: string,
    ) => Promise<{ campaignId: string; result: string } | null>,
    private readonly getCampaign: (
      id: string,
    ) => Promise<{ status: string; maxCompletions: number } | null>,
  ) {}

  async issueOnce(input: ClaimIssueInput): Promise<ClaimIssueResult> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const unexpired = (claim: SignedClaim) =>
        Number(claim.payload.expiresAt) * 1000 > input.now.getTime();
      const existing = this.records.get(input.submissionId);
      if (existing && unexpired(existing.claim)) {
        return { claim: existing.claim, created: false };
      }
      if (input.alreadyClaimed) {
        throw new ClaimIssueError("ALREADY_CLAIMED");
      }

      const [submission, campaign] = await Promise.all([
        this.getSubmission(input.submissionId),
        this.getCampaign(input.campaignId),
      ]);
      if (
        !submission ||
        submission.campaignId !== input.campaignId ||
        submission.result !== "accepted"
      ) {
        throw new ClaimIssueError("SUBMISSION_NOT_ACCEPTED");
      }
      if (!campaign || !input.canIssue || campaign.status !== "active") {
        throw new ClaimIssueError("CAMPAIGN_NOT_ACTIVE");
      }
      const outstanding = [...this.records.entries()].filter(
        ([submissionId, record]) =>
          submissionId !== input.submissionId &&
          record.campaignId === input.campaignId &&
          unexpired(record.claim),
      ).length;
      if (
        outstanding + input.onchainPaidCompletions >=
        campaign.maxCompletions
      ) {
        throw new ClaimIssueError("CAMPAIGN_CAP_REACHED");
      }
      if (input.dailyLimit) {
        const since = BigInt(Math.floor((input.now.getTime() - DAY_MS) / 1000));
        const issued = [...this.records.entries()]
          .filter(
            ([submissionId, record]) =>
              submissionId !== input.submissionId &&
              record.claim.payload.issuedAt > since,
          )
          .reduce((sum, [, record]) => sum + record.claim.payload.amount, 0n);
        if (
          issued + input.dailyLimit.rewardAtomic >
          input.dailyLimit.limitAtomic
        ) {
          throw new ClaimIssueError("DAILY_LIMIT_REACHED");
        }
      }
      const claim = await input.sign();
      this.records.set(input.submissionId, {
        campaignId: input.campaignId,
        claim,
      });
      return { claim, created: true };
    } finally {
      release();
    }
  }

  async listIssuedClaims(campaignId: string): Promise<IssuedClaim[]> {
    return [...this.records.values()]
      .filter((record) => record.campaignId === campaignId)
      .map((record) => ({
        claimant: record.claim.payload.claimant.toLowerCase(),
        nonce: record.claim.payload.nonce.toLowerCase(),
      }));
  }
}
