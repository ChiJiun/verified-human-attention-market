import type { Address } from "viem";
import { toFunctionSelector } from "viem";

import type { CampaignRepository } from "../campaigns/repository.js";
import type { ChainRpc } from "../chain/rpc.js";
import type { EligibilityRepository } from "../eligibility/repository.js";
import type { SubmissionRepository } from "../submissions/repository.js";
import { readClaimChainState } from "./chain-state.js";
import { ClaimIssueError, type ClaimRepository } from "./repository.js";
import {
  SignerUnavailableError,
  type ClaimSigner,
  type SignedClaim,
} from "./signer.js";

export interface ClaimDependencies {
  campaigns: Pick<CampaignRepository, "getById">;
  eligibility: Pick<EligibilityRepository, "getById">;
  submissions: Pick<SubmissionRepository, "getById">;
  claims: ClaimRepository;
  signer: ClaimSigner | null;
  chain: {
    chainId: number;
    contractAddress: Address;
    rpc: Pick<ChainRpc, "call">;
  } | null;
  now: () => Date;
  /** Global 24 h liability limit in token atomic units; null = none. */
  dailyPayoutLimitAtomic?: bigint | null;
}

export type ClaimOutcome =
  | { ok: true; claim: SignedClaim; created: boolean }
  | { ok: false; status: number; code: string };

const SIGNER_SELECTOR = toFunctionSelector("authorizedSigner()");

export async function authorizeClaim(
  dependencies: ClaimDependencies,
  input: { campaignId: string; submissionId: string; eligibilityToken: string },
): Promise<ClaimOutcome> {
  const { signer, chain } = dependencies;
  if (!signer || !chain) {
    return { ok: false, status: 503, code: "AUTHORIZATION_UNAVAILABLE" };
  }

  const [campaign, submission, eligibility] = await Promise.all([
    dependencies.campaigns.getById(input.campaignId),
    dependencies.submissions.getById(input.submissionId),
    dependencies.eligibility.getById(input.eligibilityToken),
  ]);

  if (!campaign || !submission || submission.campaignId !== campaign.id) {
    return { ok: false, status: 404, code: "SUBMISSION_NOT_FOUND" };
  }

  if (
    !eligibility ||
    eligibility.id !== submission.eligibilityId ||
    eligibility.campaignId !== campaign.id ||
    eligibility.claimantAddress !== submission.claimantAddress
  ) {
    return { ok: false, status: 403, code: "INVALID_ELIGIBILITY" };
  }

  if (submission.result !== "accepted") {
    return { ok: false, status: 409, code: "SUBMISSION_NOT_ACCEPTED" };
  }

  const now = dependencies.now();
  if (
    campaign.onchainCampaignId === null ||
    campaign.chainId !== chain.chainId
  ) {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
  }

  // A configured key must match the contract's current signer. RPC failures
  // fail closed; no authorization is issued on stale or guessed chain state.
  let onchainSigner: string;
  try {
    const word = await chain.rpc.call(chain.contractAddress, SIGNER_SELECTOR);
    if (!/^0x[0-9a-fA-F]{64}$/.test(word)) {
      throw new Error("Malformed authorizedSigner result");
    }
    onchainSigner = `0x${word.slice(-40)}`.toLowerCase();
  } catch {
    return { ok: false, status: 503, code: "CHAIN_UNAVAILABLE" };
  }

  if (onchainSigner !== signer.address.toLowerCase()) {
    return { ok: false, status: 503, code: "SIGNER_MISMATCH" };
  }

  // Live contract state: paid completions, close status and whether this
  // wallet was already paid. Indexed events lag by the confirmation depth.
  let chainState: Awaited<ReturnType<typeof readClaimChainState>>;
  try {
    chainState = await readClaimChainState(
      chain.rpc,
      chain.contractAddress,
      campaign.onchainCampaignId,
      submission.claimantAddress as Address,
    );
  } catch {
    return { ok: false, status: 503, code: "CHAIN_UNAVAILABLE" };
  }

  if (!chainState) {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);

  try {
    const result = await dependencies.claims.issueOnce({
      submissionId: submission.id,
      campaignId: campaign.id,
      now,
      canIssue:
        campaign.status === "active" &&
        now >= campaign.startAt &&
        now < campaign.endAt &&
        // The contract rejects authorizations issued after close/end.
        chainState.closedAt === 0 &&
        nowSeconds < chainState.endTime,
      alreadyClaimed: chainState.alreadyClaimed,
      dailyLimit:
        dependencies.dailyPayoutLimitAtomic == null
          ? null
          : {
              limitAtomic: dependencies.dailyPayoutLimitAtomic,
              rewardAtomic: BigInt(campaign.rewardAtomic),
            },
      onchainPaidCompletions: chainState.paidCompletions,
      sign: () =>
        signer.sign({
          campaignId: BigInt(campaign.onchainCampaignId!),
          claimant: submission.claimantAddress as Address,
          amount: BigInt(campaign.rewardAtomic),
          chainId: chain.chainId,
          contractAddress: chain.contractAddress,
          issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
        }),
    });

    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof ClaimIssueError) {
      return {
        ok: false,
        status: error.code === "DAILY_LIMIT_REACHED" ? 503 : 409,
        code: error.code,
      };
    }
    if (error instanceof SignerUnavailableError) {
      return { ok: false, status: 503, code: "SIGNER_UNAVAILABLE" };
    }
    throw error;
  }
}
