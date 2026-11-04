import type { Address } from "viem";
import { expect, it } from "vitest";

import { draftRefFor } from "../../src/campaigns/onchain.js";
import type {
  ClaimIssueInput,
  ClaimRepository,
} from "../../src/claims/repository.js";
import { createClaimSigner } from "../../src/claims/signer.js";

export interface ClaimHarness {
  claims: ClaimRepository;
  /**
   * An active campaign (1 USDC reward, 10 completions) on chain 84532, linked
   * to an on-chain id that no other campaign of the store uses.
   */
  linkedCampaign(): Promise<{
    campaignId: string;
    onchainCampaignId: string;
    contractAddress: Address;
  }>;
  /** An accepted submission in that campaign by a wallet no other test uses. */
  acceptedSubmission(
    campaignId: string,
  ): Promise<{ submissionId: string; claimant: Address }>;
  /** A rejected submission (COMPREHENSION_FAILED), like `acceptedSubmission`. */
  rejectedSubmission(
    campaignId: string,
  ): Promise<{ submissionId: string; claimant: Address }>;
}

const SIGNER = createClaimSigner(`0x${"11".repeat(32)}`);
const NOW = new Date("2026-10-05T10:31:00.000Z");
/** Past the 15 minute lifetime of an authorization signed at NOW. */
const EXPIRED = new Date("2026-10-05T10:47:00.000Z");

/**
 * Issuance rules every claim repository must satisfy. Registered once per
 * implementation so the in-memory store cannot drift from PostgreSQL.
 */
export function defineClaimRepositoryContract(harness: () => ClaimHarness) {
  async function participant(
    campaign?: Awaited<ReturnType<ClaimHarness["linkedCampaign"]>>,
    result: "accepted" | "rejected" = "accepted",
  ) {
    const { claims, linkedCampaign, acceptedSubmission, rejectedSubmission } =
      harness();
    const linked = campaign ?? (await linkedCampaign());
    const { submissionId, claimant } = await (
      result === "accepted" ? acceptedSubmission : rejectedSubmission
    )(linked.campaignId);
    let signatures = 0;
    const issue = (overrides: Partial<ClaimIssueInput> = {}) => {
      const now = overrides.now ?? NOW;
      return claims.issueOnce({
        campaignId: linked.campaignId,
        submissionId,
        now,
        canIssue: true,
        alreadyClaimed: false,
        onchainPaidCompletions: 0,
        sign: () => {
          signatures += 1;
          return SIGNER.sign({
            campaignId: BigInt(linked.onchainCampaignId),
            draftRef: draftRefFor(linked.campaignId),
            claimant,
            amount: 1_000_000n,
            chainId: 84532,
            contractAddress: linked.contractAddress,
            issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
          });
        },
        ...overrides,
      });
    };
    return {
      claims,
      campaign: linked,
      claimant,
      issue,
      signatures: () => signatures,
    };
  }

  it("replays the unexpired authorization of a wallet that was not paid", async () => {
    const { issue, signatures } = await participant();
    const first = await issue();

    const replay = await issue();

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.claim.signature).toBe(first.claim.signature);
    expect(signatures()).toBe(1);
  });

  it("replays until the millisecond before expiresAt and reissues from expiresAt on", async () => {
    const { issue, signatures } = await participant();
    const first = await issue();
    const expiresAtMs = Number(first.claim.payload.expiresAt) * 1000;

    const lastReplay = await issue({ now: new Date(expiresAtMs - 1) });
    expect(lastReplay.created).toBe(false);
    expect(lastReplay.claim.signature).toBe(first.claim.signature);

    const reissued = await issue({ now: new Date(expiresAtMs) });
    expect(reissued.created).toBe(true);
    expect(reissued.claim.payload.nonce).not.toBe(first.claim.payload.nonce);
    expect(signatures()).toBe(2);
  });

  it("answers ALREADY_CLAIMED, not the stored authorization, once the wallet was paid (#82)", async () => {
    const { claims, campaign, claimant, issue, signatures } =
      await participant();
    const first = await issue();

    // Before and after the stored authorization expires: the contract would
    // revert a replay (NonceAlreadyUsed) and a reissue (WalletAlreadyClaimed).
    for (const now of [NOW, EXPIRED]) {
      await expect(
        issue({ now, alreadyClaimed: true, onchainPaidCompletions: 1 }),
      ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    }

    expect(signatures()).toBe(1);
    expect(await claims.listIssuedClaims(campaign.campaignId)).toEqual([
      {
        claimant: claimant.toLowerCase(),
        nonce: first.claim.payload.nonce.toLowerCase(),
      },
    ]);
  });

  it("answers ALREADY_CLAIMED when the stored nonce is a confirmed payout (#82)", async () => {
    const { issue, signatures } = await participant();
    const first = await issue();
    const redeemedNonces = new Set([first.claim.payload.nonce.toLowerCase()]);

    for (const now of [NOW, EXPIRED]) {
      await expect(
        issue({ now, redeemedNonces, onchainPaidCompletions: 1 }),
      ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    }
    expect(signatures()).toBe(1);
  });

  it("refuses in one order: not accepted, then paid, then not active", async () => {
    const rejected = await participant(undefined, "rejected");
    await expect(
      rejected.issue({ alreadyClaimed: true, canIssue: false }),
    ).rejects.toMatchObject({ code: "SUBMISSION_NOT_ACCEPTED" });

    // A paid wallet hears "already paid" after the close too, not "closed".
    const paid = await participant();
    await paid.issue();
    await expect(
      paid.issue({ now: EXPIRED, alreadyClaimed: true, canIssue: false }),
    ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    await expect(
      paid.issue({ now: EXPIRED, canIssue: false }),
    ).rejects.toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE" });
    expect(rejected.signatures() + paid.signatures()).toBe(1);
  });

  it("still replays when only another submission's nonce was paid", async () => {
    const paid = await participant();
    const other = await participant(paid.campaign);
    const paidClaim = await paid.issue();
    const otherClaim = await other.issue();

    const replay = await other.issue({
      redeemedNonces: new Set([paidClaim.claim.payload.nonce.toLowerCase()]),
      onchainPaidCompletions: 1,
    });

    expect(replay.created).toBe(false);
    expect(replay.claim.signature).toBe(otherClaim.claim.signature);
  });
}
