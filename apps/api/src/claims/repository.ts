import { and, count, eq, isNotNull } from "drizzle-orm";
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
      | "AUTHORIZATION_EXPIRED",
  ) {
    super(code);
  }
}

export interface ClaimIssueInput {
  submissionId: string;
  campaignId: string;
  now: Date;
  canIssue: boolean;
  sign: () => Promise<SignedClaim>;
}

export interface ClaimIssueResult {
  claim: SignedClaim;
  created: boolean;
}

export interface ClaimRepository {
  issueOnce(input: ClaimIssueInput): Promise<ClaimIssueResult>;
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

function restoreClaim(
  row: typeof submissions.$inferSelect,
  campaign: typeof campaigns.$inferSelect,
  now: Date,
): SignedClaim | null {
  const claim = storedClaim(row);
  if (!claim) return null;
  if (row.claimExpiresAt!.getTime() <= now.getTime()) {
    throw new ClaimIssueError("AUTHORIZATION_EXPIRED");
  }
  if (!campaign.onchainCampaignId) {
    throw new ClaimIssueError("CAMPAIGN_NOT_ACTIVE");
  }
  claim.payload.campaignId = BigInt(campaign.onchainCampaignId);
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

      if (!input.canIssue || campaign.status !== "active") {
        throw new ClaimIssueError("CAMPAIGN_NOT_ACTIVE");
      }

      const [issued] = await tx
        .select({ value: count() })
        .from(submissions)
        .where(
          and(
            eq(submissions.campaignId, input.campaignId),
            isNotNull(submissions.claimNonce),
          ),
        );

      if ((issued?.value ?? 0) >= campaign.maxCompletions) {
        throw new ClaimIssueError("CAMPAIGN_CAP_REACHED");
      }

      const claim = await input.sign();
      if (
        claim.payload.campaignId !== BigInt(campaign.onchainCampaignId) ||
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
}

/** Test/local repository with the same one-time issuance and cap behavior. */
export class InMemoryClaimRepository implements ClaimRepository {
  private readonly records = new Map<string, SignedClaim>();
  private readonly counts = new Map<string, number>();
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
      const existing = this.records.get(input.submissionId);
      if (existing) {
        if (Number(existing.payload.expiresAt) * 1000 <= input.now.getTime()) {
          throw new ClaimIssueError("AUTHORIZATION_EXPIRED");
        }
        return { claim: existing, created: false };
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
      if ((this.counts.get(input.campaignId) ?? 0) >= campaign.maxCompletions) {
        throw new ClaimIssueError("CAMPAIGN_CAP_REACHED");
      }
      const claim = await input.sign();
      this.records.set(input.submissionId, claim);
      this.counts.set(
        input.campaignId,
        (this.counts.get(input.campaignId) ?? 0) + 1,
      );
      return { claim, created: true };
    } finally {
      release();
    }
  }
}
