import { decodeCampaignManagerLog, FUNCTION_SELECTORS } from "../chain/abi.js";
import {
  reconcileCampaignEvents,
  type OnchainCampaignStatus,
} from "../chain/campaign-state.js";
import type {
  ChainEventRepository,
  ChainScope,
} from "../chain/events-repository.js";
import { RpcError, type ChainRpc } from "../chain/rpc.js";
import {
  CampaignLinkConflictError,
  type CampaignRepository,
} from "./repository.js";
import type { CampaignRecord, CampaignStatus } from "./types.js";

/** On-chain campaign struct as returned by `campaigns(uint256)`. */
export interface OnchainCampaign {
  advertiser: string;
  fundedBudget: string;
  paidRewards: string;
  rewardPerCompletion: string;
  maxCompletions: number;
  paidCompletions: number;
  startTime: number;
  endTime: number;
  closedAt: number;
  status: number;
}

const word = (value: bigint) => value.toString(16).padStart(64, "0");

/** Reads `campaigns(id)` via eth_call (10 static words). */
export async function readOnchainCampaign(
  rpc: Pick<ChainRpc, "call">,
  contractAddress: string,
  onchainCampaignId: string,
): Promise<OnchainCampaign | null> {
  const result = await rpc.call(
    contractAddress,
    `${FUNCTION_SELECTORS.campaigns}${word(BigInt(onchainCampaignId))}`,
  );
  const body = result.startsWith("0x") ? result.slice(2) : result;

  if (body.length !== 64 * 10 || !/^[0-9a-f]+$/.test(body)) {
    return null;
  }

  const words = Array.from({ length: 10 }, (_unused, index) =>
    BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`),
  );
  const [
    advertiser,
    fundedBudget,
    paidRewards,
    rewardPerCompletion,
    maxCompletions,
    paidCompletions,
    startTime,
    endTime,
    closedAt,
    status,
  ] = words as [
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
  ];

  if (advertiser === 0n) {
    return null;
  }

  return {
    advertiser: `0x${advertiser.toString(16).padStart(40, "0")}`,
    fundedBudget: fundedBudget.toString(),
    paidRewards: paidRewards.toString(),
    rewardPerCompletion: rewardPerCompletion.toString(),
    maxCompletions: Number(maxCompletions),
    paidCompletions: Number(paidCompletions),
    startTime: Number(startTime),
    endTime: Number(endTime),
    closedAt: Number(closedAt),
    status: Number(status),
  };
}

const unixSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** True when the on-chain campaign has exactly the draft's economics. */
export function matchesDraft(
  draft: CampaignRecord,
  onchain: OnchainCampaign,
): boolean {
  return (
    onchain.advertiser === draft.advertiserAddress &&
    onchain.rewardPerCompletion === draft.rewardAtomic &&
    onchain.maxCompletions === draft.maxCompletions &&
    onchain.startTime === unixSeconds(draft.startAt) &&
    onchain.endTime === unixSeconds(draft.endAt)
  );
}

export interface OnchainDependencies {
  campaigns: CampaignRepository;
  rpc: ChainRpc;
  chain: ChainScope & { usdcAddress: string };
  now: () => Date;
}

/** Transaction intent for the advertiser's wallet (issue #16 / #11). */
export function publishIntent(
  campaign: CampaignRecord,
  chain: OnchainDependencies["chain"],
) {
  const budget = (
    BigInt(campaign.rewardAtomic) * BigInt(campaign.maxCompletions)
  ).toString();

  return {
    chainId: chain.chainId,
    campaignManager: chain.contractAddress,
    steps: [
      {
        contract: chain.contractAddress,
        function: "createCampaign",
        args: {
          rewardPerCompletion: campaign.rewardAtomic,
          maxCompletions: campaign.maxCompletions,
          startTime: unixSeconds(campaign.startAt),
          endTime: unixSeconds(campaign.endAt),
        },
      },
      {
        contract: chain.usdcAddress,
        function: "approve",
        args: { spender: chain.contractAddress, amount: budget },
      },
      {
        contract: chain.contractAddress,
        function: "fundCampaign",
        args: { campaignId: "<from CampaignCreated>", amount: budget },
      },
    ],
    // Report the createCampaign tx hash here; success is verified on-chain.
    linkEndpoint: `/v1/campaigns/${campaign.id}/onchain`,
  };
}

export type LinkFailureCode =
  | "CAMPAIGN_NOT_FOUND"
  | "WRONG_CHAIN"
  | "TX_PENDING"
  | "RPC_UNAVAILABLE"
  | "TX_REVERTED"
  | "NO_CAMPAIGN_CREATED_EVENT"
  | "ADVERTISER_MISMATCH"
  | "PARAMETERS_MISMATCH"
  | "ALREADY_LINKED"
  | "ONCHAIN_CAMPAIGN_ALREADY_LINKED";

export type LinkOutcome =
  | { ok: true; campaign: CampaignRecord }
  | { ok: false; status: number; code: LinkFailureCode };

/**
 * Links a draft to the on-chain campaign created by `txHash`.
 *
 * The client's claim that the transaction succeeded is never trusted: the
 * receipt, emitting contract, CampaignCreated event, advertiser and on-chain
 * economics are all verified over RPC. A missing receipt or RPC failure is
 * reported as pending (retry later), never as a failure that would prompt
 * the advertiser to create and fund a duplicate campaign.
 */
export async function linkCampaignByTransaction(
  dependencies: OnchainDependencies,
  input: { campaignId: string; txHash: string },
): Promise<LinkOutcome> {
  const campaign = await dependencies.campaigns.getById(input.campaignId);

  if (!campaign) {
    return { ok: false, status: 404, code: "CAMPAIGN_NOT_FOUND" };
  }

  if (campaign.chainId !== dependencies.chain.chainId) {
    return { ok: false, status: 409, code: "WRONG_CHAIN" };
  }

  const txHash = input.txHash.toLowerCase();

  if (campaign.onchainCampaignId !== null) {
    return campaign.publishTxHash === txHash
      ? { ok: true, campaign }
      : { ok: false, status: 409, code: "ALREADY_LINKED" };
  }

  try {
    const receipt = await dependencies.rpc.getTransactionReceipt(txHash);

    if (!receipt) {
      return { ok: false, status: 202, code: "TX_PENDING" };
    }

    if (receipt.status !== "success") {
      return { ok: false, status: 422, code: "TX_REVERTED" };
    }

    const created = receipt.logs
      .filter((log) => log.address === dependencies.chain.contractAddress)
      .map((log) => decodeCampaignManagerLog(log))
      .find((event) => event?.name === "CampaignCreated");

    if (!created || created.name !== "CampaignCreated") {
      return { ok: false, status: 422, code: "NO_CAMPAIGN_CREATED_EVENT" };
    }

    if (created.advertiser !== campaign.advertiserAddress) {
      return { ok: false, status: 422, code: "ADVERTISER_MISMATCH" };
    }

    const onchain = await readOnchainCampaign(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      created.campaignId,
    );

    if (!onchain || !matchesDraft(campaign, onchain)) {
      return { ok: false, status: 422, code: "PARAMETERS_MISMATCH" };
    }

    const linked = await dependencies.campaigns.linkOnchain(campaign.id, {
      onchainCampaignId: created.campaignId,
      publishTxHash: txHash,
      status: "pending_onchain",
      updatedAt: dependencies.now(),
    });

    return { ok: true, campaign: linked };
  } catch (error) {
    if (error instanceof RpcError) {
      return { ok: false, status: 503, code: "RPC_UNAVAILABLE" };
    }

    if (error instanceof CampaignLinkConflictError) {
      return { ok: false, status: 409, code: error.code };
    }

    throw error;
  }
}

const STATUS_MAP: Record<OnchainCampaignStatus, CampaignStatus | null> = {
  not_found: null,
  created: "pending_onchain",
  active: "active",
  closed: "closed",
  settled: "settled",
  cancelled: "cancelled",
};

export interface StatusSyncResult {
  updated: { campaignId: string; from: CampaignStatus; to: CampaignStatus }[];
  /** paid + refunded > funded on-chain: must alert an operator. */
  accountingViolations: string[];
}

/**
 * Mirrors confirmed on-chain lifecycle into the campaigns table so the
 * verifier only accepts completions for funded, active campaigns.
 */
export async function syncCampaignStatuses(dependencies: {
  campaigns: CampaignRepository;
  events: ChainEventRepository;
  chain: ChainScope;
  now: () => Date;
}): Promise<StatusSyncResult> {
  const result: StatusSyncResult = { updated: [], accountingViolations: [] };

  for (const campaign of await dependencies.campaigns.listLinked(
    dependencies.chain.chainId,
  )) {
    const events = await dependencies.events.listCampaignEvents(
      dependencies.chain,
      campaign.onchainCampaignId!,
    );
    const { confirmed } = reconcileCampaignEvents(events);

    if (confirmed.accountingViolation) {
      result.accountingViolations.push(campaign.id);
    }

    const next = STATUS_MAP[confirmed.status];

    if (next && next !== campaign.status) {
      await dependencies.campaigns.updateStatus(
        campaign.id,
        next,
        dependencies.now(),
      );
      result.updated.push({
        campaignId: campaign.id,
        from: campaign.status,
        to: next,
      });
    }
  }

  return result;
}

/**
 * Recovery for lost transaction hashes (e.g. the browser closed after
 * broadcast): links a confirmed CampaignCreated event to the advertiser's
 * single unlinked draft with identical economics. Ambiguous matches are left
 * for manual resolution rather than guessed.
 */
export async function autoLinkCreatedCampaigns(
  dependencies: OnchainDependencies & { events: ChainEventRepository },
): Promise<{ linked: string[]; ambiguous: string[] }> {
  const linked: string[] = [];
  const ambiguous: string[] = [];
  const createdEvents = await dependencies.events.listConfirmedCreations(
    dependencies.chain,
  );

  for (const created of createdEvents) {
    if (
      await dependencies.campaigns.findByOnchainId(
        dependencies.chain.chainId,
        created.onchainCampaignId,
      )
    ) {
      continue;
    }

    const drafts = await dependencies.campaigns.listUnlinkedDrafts(
      dependencies.chain.chainId,
      created.advertiser,
    );

    if (drafts.length === 0) {
      continue;
    }

    const onchain = await readOnchainCampaign(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      created.onchainCampaignId,
    );
    const matches = onchain
      ? drafts.filter((draft) => matchesDraft(draft, onchain))
      : [];

    if (matches.length !== 1) {
      if (matches.length > 1) {
        ambiguous.push(created.onchainCampaignId);
      }
      continue;
    }

    try {
      await dependencies.campaigns.linkOnchain(matches[0]!.id, {
        onchainCampaignId: created.onchainCampaignId,
        publishTxHash: null,
        status: "pending_onchain",
        updatedAt: dependencies.now(),
      });
      linked.push(created.onchainCampaignId);
    } catch (error) {
      if (!(error instanceof CampaignLinkConflictError)) {
        throw error;
      }
    }
  }

  return { linked, ambiguous };
}
