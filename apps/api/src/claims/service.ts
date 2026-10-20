import { campaignManagerAbi } from "@vham/shared/contracts";
import { encodeFunctionData, type Address } from "viem";

import type { CampaignRepository } from "../campaigns/repository.js";
import { checkLiveCampaign, draftRefFor } from "../campaigns/onchain.js";
import {
  isRetiredDeployment,
  type CampaignRecord,
} from "../campaigns/types.js";
import type { ChainEventRepository } from "../chain/events-repository.js";
import type { ChainRpc } from "../chain/rpc.js";
import type { PersistenceScope } from "../db/client.js";
import type { EligibilityRepository } from "../eligibility/repository.js";
import type { SubmissionRepository } from "../submissions/repository.js";
import { readClaimedWallet } from "./chain-state.js";
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

/**
 * Signs and stores the authorization of an accepted submission inside
 * `scope` (the caller's transaction, or null for the root pool). Only the
 * campaign row lock, the cap and payout-limit counts, the signature and the
 * update run here; everything that waits on the chain was read beforehand.
 */
export type ClaimIssuer = (
  submissionId: string,
  scope: PersistenceScope,
) => Promise<ClaimOutcome>;

export type ClaimPreparation =
  | { ok: false; status: number; code: string }
  | {
      ok: true;
      /** The contract would pay a completion accepted now (ADR-0011, 12). */
      payable: boolean;
      /** null without a signer: the completion stays pending_authorization. */
      issue: ClaimIssuer | null;
    };

// Canonical ABI (#19): same interface as the contract and the web app.
const SIGNER_SELECTOR = encodeFunctionData({
  abi: campaignManagerAbi,
  functionName: "authorizedSigner",
});

/**
 * Reads everything an authorization depends on before any transaction
 * opens: the campaign live from the contract (this draft's canonical
 * creation, and whether it pays right now), the contract's signer, whether
 * the wallet was already paid, and the confirmed payouts from the index.
 * The returned issuer never waits for an RPC or the signing service's
 * network round trip beyond `sign` itself, so an acceptance holds its pool
 * connection for the database work and one signature. RPC failures fail
 * closed; no authorization is issued on stale or guessed chain state.
 */
export async function prepareClaim(
  dependencies: ClaimDependencies,
  campaign: CampaignRecord,
  claimant: string,
): Promise<ClaimPreparation> {
  const { signer, chain } = dependencies;
  if (!chain) {
    return { ok: false, status: 503, code: "AUTHORIZATION_UNAVAILABLE" };
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

  const now = dependencies.now();

  // The link must still be this draft's canonical creation with the draft's
  // parameters: a link left behind by a reorg would otherwise sign against
  // another campaign's budget (ADR-0011). Indexed events lag by the
  // confirmation depth; this reading does not.
  const live = await checkLiveCampaign(
    chain.rpc,
    chain.contractAddress,
    campaign,
    now,
  );
  if (live.state === "unavailable") {
    return { ok: false, status: 503, code: "CHAIN_UNAVAILABLE" };
  }
  if (live.state === "mismatch") {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
  }
  const payable = live.state === "payable";

  if (!signer) {
    return { ok: true, payable, issue: null };
  }

  // A configured key must match the contract's current signer.
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

  let alreadyClaimed: boolean;
  try {
    alreadyClaimed = await readClaimedWallet(
      chain.rpc,
      chain.contractAddress,
      campaign.onchainCampaignId,
      claimant as Address,
    );
  } catch {
    return { ok: false, status: 503, code: "CHAIN_UNAVAILABLE" };
  }

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

  const { onchain } = live;
  const onchainCampaignId = campaign.onchainCampaignId;
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const issue: ClaimIssuer = async (submissionId, scope) => {
    try {
      const result = await dependencies.claims.within(scope).issueOnce({
        submissionId,
        campaignId: campaign.id,
        now,
        canIssue:
          campaign.status === "active" &&
          now >= campaign.startAt &&
          now < campaign.endAt &&
          // The contract rejects authorizations issued after close/end.
          onchain.closedAt === 0 &&
          nowSeconds < onchain.endTime,
        alreadyClaimed,
        dailyLimit:
          dependencies.dailyPayoutLimitAtomic == null
            ? null
            : {
                limitAtomic: dependencies.dailyPayoutLimitAtomic,
                rewardAtomic: BigInt(campaign.rewardAtomic),
              },
        onchainPaidCompletions: onchain.paidCompletions,
        redeemedNonces,
        sign: () =>
          signer.sign({
            campaignId: BigInt(onchainCampaignId),
            draftRef: draftRefFor(campaign.id),
            claimant: claimant as Address,
            amount: BigInt(campaign.rewardAtomic),
            chainId: chain.chainId,
            contractAddress: chain.contractAddress,
            issuedAt: BigInt(nowSeconds),
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
  };

  return { ok: true, payable, issue };
}

/**
 * The authorization of an accepted completion on request: the stored
 * signature while it is valid for the campaign's current link, otherwise a
 * new one (replays, and acceptances recorded without a signer).
 */
export async function authorizeClaim(
  dependencies: ClaimDependencies,
  input: {
    campaignId: string;
    submissionId: string;
    eligibilityToken: string;
  },
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

  // A recorded deep reorg stops all signing, including replays (ADR-0011).
  if (await dependencies.chainHalted()) {
    return { ok: false, status: 503, code: "CHAIN_HALTED" };
  }

  const prepared = await prepareClaim(
    dependencies,
    campaign,
    submission.claimantAddress,
  );
  if (!prepared.ok) {
    return prepared;
  }

  return prepared.issue
    ? prepared.issue(submission.id, null)
    : { ok: false, status: 503, code: "AUTHORIZATION_UNAVAILABLE" };
}
