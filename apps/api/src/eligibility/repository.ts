import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { eligibility } from "../db/schema.js";
import { PARTICIPANT_KEY_PATTERN } from "../privacy/participant-key.js";

export interface EligibilityRecord {
  id: string;
  campaignId: string;
  participantKey: string;
  claimantAddress: string;
  provider: string;
  verifiedAt: Date;
  expiresAt: Date;
}

export type NewEligibility = EligibilityRecord;

export interface IdempotentEligibilityResult {
  eligibility: EligibilityRecord;
  created: boolean;
}

export type EligibilityConflictCode =
  /** The same human already bound a different wallet in this campaign. */
  | "PARTICIPANT_WALLET_MISMATCH"
  /** The wallet is already bound to a different human in this campaign. */
  | "WALLET_ALREADY_BOUND";

export class EligibilityConflictError extends Error {
  constructor(readonly code: EligibilityConflictCode) {
    super(`Eligibility conflict: ${code}`);
    this.name = "EligibilityConflictError";
  }
}

export interface EligibilityRepository {
  /**
   * Records that a verified human may participate in a campaign with exactly
   * one payout wallet. Replaying the same (participant, wallet) pair is
   * idempotent and returns the original record.
   */
  recordIdempotent(input: NewEligibility): Promise<IdempotentEligibilityResult>;
  getById(id: string): Promise<EligibilityRecord | null>;
}

const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

function normalize(input: NewEligibility): NewEligibility {
  const claimantAddress = input.claimantAddress.toLowerCase();

  if (!PARTICIPANT_KEY_PATTERN.test(input.participantKey)) {
    // Guards against persisting raw identity-provider identifiers.
    throw new Error("participantKey must be a derived 32-byte hex key");
  }

  if (!EVM_ADDRESS_PATTERN.test(claimantAddress)) {
    throw new Error("claimantAddress must be an EVM address");
  }

  if (input.expiresAt <= input.verifiedAt) {
    throw new Error("expiresAt must be after verifiedAt");
  }

  return { ...input, claimantAddress };
}

function resolveExisting(
  input: NewEligibility,
  byParticipant: EligibilityRecord | null,
  byWallet: EligibilityRecord | null,
): IdempotentEligibilityResult {
  if (byParticipant) {
    if (byParticipant.claimantAddress !== input.claimantAddress) {
      throw new EligibilityConflictError("PARTICIPANT_WALLET_MISMATCH");
    }

    return { eligibility: byParticipant, created: false };
  }

  if (byWallet) {
    throw new EligibilityConflictError("WALLET_ALREADY_BOUND");
  }

  throw new Error("Eligibility insert conflicted but no record was found");
}

export class PostgresEligibilityRepository implements EligibilityRepository {
  constructor(private readonly db: Database) {}

  async recordIdempotent(
    rawInput: NewEligibility,
  ): Promise<IdempotentEligibilityResult> {
    const input = normalize(rawInput);

    const [inserted] = await this.db
      .insert(eligibility)
      .values(input)
      .onConflictDoNothing()
      .returning();

    if (inserted) {
      return { eligibility: inserted, created: true };
    }

    const [byParticipant] = await this.db
      .select()
      .from(eligibility)
      .where(
        and(
          eq(eligibility.campaignId, input.campaignId),
          eq(eligibility.participantKey, input.participantKey),
        ),
      )
      .limit(1);

    const [byWallet] = await this.db
      .select()
      .from(eligibility)
      .where(
        and(
          eq(eligibility.campaignId, input.campaignId),
          eq(eligibility.claimantAddress, input.claimantAddress),
        ),
      )
      .limit(1);

    return resolveExisting(input, byParticipant ?? null, byWallet ?? null);
  }

  async getById(id: string): Promise<EligibilityRecord | null> {
    const [row] = await this.db
      .select()
      .from(eligibility)
      .where(eq(eligibility.id, id))
      .limit(1);

    return row ?? null;
  }
}

export class InMemoryEligibilityRepository implements EligibilityRepository {
  private readonly records = new Map<string, EligibilityRecord>();

  async recordIdempotent(
    rawInput: NewEligibility,
  ): Promise<IdempotentEligibilityResult> {
    const input = normalize(rawInput);
    const sameCampaign = [...this.records.values()].filter(
      (record) => record.campaignId === input.campaignId,
    );
    const byParticipant =
      sameCampaign.find(
        (record) => record.participantKey === input.participantKey,
      ) ?? null;
    const byWallet =
      sameCampaign.find(
        (record) => record.claimantAddress === input.claimantAddress,
      ) ?? null;

    if (byParticipant || byWallet) {
      return resolveExisting(input, byParticipant, byWallet);
    }

    const record = { ...input };
    this.records.set(record.id, record);

    return { eligibility: record, created: true };
  }

  async getById(id: string): Promise<EligibilityRecord | null> {
    return this.records.get(id) ?? null;
  }
}
