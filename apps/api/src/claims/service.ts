import { campaignManagerAbi } from "@vham/shared/contracts";
import { encodeFunctionData, type Address } from "viem";

import type { CampaignRepository } from "../campaigns/repository.js";
import { draftRefFor, readCampaignIdByDraft } from "../campaigns/onchain.js";
import { isRetiredDeployment } from "../campaigns/types.js";
import type { ChainEventRepository } from "../chain/events-repository.js";
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
    /**
     * Indexed events: confirmed RewardClaimed nonces free their cap slot
     * before the authorization expires. Optional; without it the cap counts
     * every unexpired authorization (safe but slower to free slots).
     */
    events?: Pick<ChainEventRepository, "listCampaignEvents"> | null;
  } | null;
  now: () => Date;
  /** Global 24 h liability limit in token atomic units; null = none. */
  dailyPayoutLimitAtomic?: bigint | null;
  /**
   * True while the indexer worker has recorded a reorg deeper than the
   * confirmation depth: no participation until recovery (ADR-0011).
   */
  chainHalted: () => Promise<boolean>;
}

export type ClaimOutcome =
  | { ok: true; claim: SignedClaim; created: boolean }
  | { ok: false; status: number; code: string };

// Canonical ABI (#19): same interface as the contract and the web app.
const SIGNER_SELECTOR = encodeFunctionData({
  abi: campaignManagerAbi,
  functionName: "authorizedSigner",
});

export async function authorizeClaim(
  dependencies: ClaimDependencies,
  input: {
    campaignId: string;
    submissionId: string;
    eligibilityToken: string;
    /**
     * The submission when the caller already holds it, e.g. the row it just
     * inserted in a transaction that is not committed yet (ADR-0011).
     */
    submission?: Awaited<ReturnType<SubmissionRepository["getById"]>>;
  },
): Promise<ClaimOutcome> {
  const { signer, chain } = dependencies;
  if (!signer || !chain) {
    return { ok: false, status: 503, code: "AUTHORIZATION_UNAVAILABLE" };
  }

  const [campaign, submission, eligibility] = await Promise.all([
    dependencies.campaigns.getById(input.campaignId),
    input.submission && input.submission.id === input.submissionId
      ? input.submission
      : dependencies.submissions.getById(input.submissionId),
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

  // A recorded deep reorg stops all signing, including replays (ADR-0011).
  if (await dependencies.chainHalted()) {
    return { ok: false, status: 503, code: "CHAIN_HALTED" };
  }

  // A campaign linked on an earlier deployment has an id that may exist on
  // the current contract too: never sign for it there (ADR-0011).
  if (
    campaign.onchainCampaignId === null ||
    isRetiredDeployment(campaign, {
      chainId: chain.chainId,
      contractAddress: chain.contractAddress,
    })
  ) {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
  }

  // The link must still be this draft's canonical creation: the contract's
  // campaignIdByDraft(advertiser, draftRef) has to name exactly this id. A
  // link left behind by a reorg would otherwise sign against another
  // campaign's budget (ADR-0011).
  try {
    const canonicalId = await readCampaignIdByDraft(
      chain.rpc,
      chain.contractAddress,
      campaign.advertiserAddress,
      draftRefFor(campaign.id),
    );
    if (canonicalId !== campaign.onchainCampaignId) {
      return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
    }
  } catch {
    return { ok: false, status: 503, code: "CHAIN_UNAVAILABLE" };
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

  // Confirmed payouts are already in `paidCompletions`; their (possibly
  // unexpired) signatures must not be counted as outstanding as well,
  // otherwise paid slots stay blocked for up to MAX_AUTHORIZATION_TTL and a
  // verified human can be refused in a short campaign. Only confirmed events
  // count: an observed event could still be reorged out while the signature
  // remains redeemable.
  const redeemedNonces = new Set<string>();
  if (chain.events) {
    const events = await chain.events.listCampaignEvents(
      {
        chainId: chain.chainId,
        contractAddress: chain.contractAddress.toLowerCase(),
      },
      campaign.onchainCampaignId,
    );
    for (const stored of events) {
      if (
        stored.status === "confirmed" &&
        stored.event.name === "RewardClaimed"
      ) {
        redeemedNonces.add(stored.event.nonce.toLowerCase());
      }
    }
  }

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
      redeemedNonces,
      sign: () =>
        signer.sign({
          campaignId: BigInt(campaign.onchainCampaignId!),
          draftRef: draftRefFor(campaign.id),
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
