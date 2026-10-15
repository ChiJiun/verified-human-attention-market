import { keccak256, stringToBytes, type Hex } from "viem";

import { decodeCampaignManagerLog, FUNCTION_SELECTORS } from "../chain/abi.js";
import { DEFAULT_CONFIRMATIONS } from "../chain/config.js";
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

/**
 * The draft's reference passed to `createCampaign` (ADR-0011). The contract
 * records one campaign per (advertiser, draftRef) and rejects a second, so a
 * retried, concurrent or lost-response create can never make two campaigns,
 * and a creation can never be attributed to a different draft.
 */
export function draftRefFor(campaignId: string): Hex {
  return keccak256(stringToBytes(`vham-draft:${campaignId}`));
}

/**
 * Reads `campaignIdByDraft(advertiser, draftRef)` at `block` (default
 * latest); null when none exists.
 */
export async function readCampaignIdByDraft(
  rpc: Pick<ChainRpc, "call">,
  contractAddress: string,
  advertiser: string,
  draftRef: string,
  block?: bigint,
): Promise<string | null> {
  const result = await rpc.call(
    contractAddress,
    `${FUNCTION_SELECTORS.campaignIdByDraft}${advertiser.slice(2).toLowerCase().padStart(64, "0")}${draftRef.slice(2).toLowerCase()}`,
    block,
  );
  const body = result.startsWith("0x") ? result.slice(2) : result;

  // No code at `block` (the contract was deployed later): nothing exists yet.
  // Startup already verified that the configured contract has this function.
  if (body === "") {
    return null;
  }

  if (body.length !== 64 || !/^[0-9a-f]+$/.test(body)) {
    throw new RpcError("campaignIdByDraft returned malformed data");
  }

  const id = BigInt(`0x${body}`);
  return id === 0n ? null : id.toString();
}

/** Reads `campaigns(id)` via eth_call (10 static words). */
export async function readOnchainCampaign(
  rpc: Pick<ChainRpc, "call">,
  contractAddress: string,
  onchainCampaignId: string,
  block?: bigint,
): Promise<OnchainCampaign | null> {
  const result = await rpc.call(
    contractAddress,
    `${FUNCTION_SELECTORS.campaigns}${word(BigInt(onchainCampaignId))}`,
    block,
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

/** `CampaignManager.CampaignStatus.Active`. */
const ONCHAIN_STATUS_ACTIVE = 1;

export type LiveCampaignState =
  /** Canonical creation for this draft, funded, open and within its window. */
  | "payable"
  /** The id now belongs to another draft, or the parameters differ. */
  | "mismatch"
  /** Canonical, but closed, not funded, outside its window or full. */
  | "not_payable"
  /** The RPC failed; nothing can be decided. */
  | "unavailable";

/**
 * Reads the campaign's current on-chain state directly (not the indexed
 * copy, which lags by the confirmation depth): a completion is accepted
 * only while the contract would actually pay it (ADR-0011, #13).
 */
export async function checkLiveCampaign(
  rpc: Pick<ChainRpc, "call">,
  contractAddress: string,
  campaign: CampaignRecord,
  now: Date,
): Promise<LiveCampaignState> {
  try {
    const canonicalId = await readCampaignIdByDraft(
      rpc,
      contractAddress,
      campaign.advertiserAddress,
      draftRefFor(campaign.id),
    );

    if (canonicalId === null || canonicalId !== campaign.onchainCampaignId) {
      return "mismatch";
    }

    const onchain = await readOnchainCampaign(
      rpc,
      contractAddress,
      canonicalId,
    );

    if (!onchain || !matchesDraft(campaign, onchain)) {
      return "mismatch";
    }

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const remaining =
      BigInt(onchain.fundedBudget) - BigInt(onchain.paidRewards);
    const payable =
      onchain.status === ONCHAIN_STATUS_ACTIVE &&
      onchain.closedAt === 0 &&
      remaining >= BigInt(onchain.rewardPerCompletion) &&
      onchain.paidCompletions < onchain.maxCompletions &&
      nowSeconds >= onchain.startTime &&
      nowSeconds < onchain.endTime;

    return payable ? "payable" : "not_payable";
  } catch {
    return "unavailable";
  }
}

export interface OnchainDependencies {
  campaigns: CampaignRepository;
  rpc: ChainRpc;
  chain: ChainScope & { usdcAddress: string };
  now: () => Date;
  /**
   * Blocks a creation must be buried under before it is linked, so a
   * shallow reorg can never leave a permanent link to a creation that is no
   * longer canonical (ADR-0011). Defaults to DEFAULT_CONFIRMATIONS.
   */
  confirmations?: number;
}

/** Highest block considered final, or null before enough blocks exist. */
async function confirmedHead(
  dependencies: OnchainDependencies,
): Promise<bigint | null> {
  const head = await dependencies.rpc.blockNumber();
  const confirmed =
    head - BigInt(dependencies.confirmations ?? DEFAULT_CONFIRMATIONS);
  return confirmed < 0n ? null : confirmed;
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
          draftRef: draftRefFor(campaign.id),
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
    // Report the createCampaign tx hash here, or POST without one to link by
    // draft reference; success is always verified on-chain.
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
  | "DRAFT_MISMATCH"
  | "NOT_CREATED_YET"
  | "TX_UNCONFIRMED"
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

  if (
    campaign.onchainCampaignId !== null &&
    campaign.publishTxHash === txHash
  ) {
    // The same hash on an earlier deployment is not this contract's creation.
    return campaign.onchainContractAddress ===
      dependencies.chain.contractAddress
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

    if (created.draftRef !== draftRefFor(campaign.id)) {
      return { ok: false, status: 422, code: "DRAFT_MISMATCH" };
    }

    // Already linked another way (by draft reference or the indexer): the
    // same creation is idempotent, anything else is a conflict.
    if (campaign.onchainCampaignId !== null) {
      return campaign.onchainCampaignId === created.campaignId &&
        campaign.onchainContractAddress === dependencies.chain.contractAddress
        ? { ok: true, campaign }
        : { ok: false, status: 409, code: "ALREADY_LINKED" };
    }

    // Only a creation buried under the confirmation depth is linked.
    const confirmed = await confirmedHead(dependencies);

    if (confirmed === null || receipt.blockNumber > confirmed) {
      return { ok: false, status: 202, code: "TX_UNCONFIRMED" };
    }

    // A load-balanced RPC can return a receipt from a stale fork: the
    // receipt's block must be the canonical block at that height, and at the
    // same confirmed height the contract must map this draft to the event's
    // id. Inconsistent answers are "reconciling", never a link.
    const canonicalBlock = await dependencies.rpc.getBlock(receipt.blockNumber);

    if (!canonicalBlock || canonicalBlock.hash !== receipt.blockHash) {
      return { ok: false, status: 202, code: "TX_UNCONFIRMED" };
    }

    const mapped = await readCampaignIdByDraft(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      campaign.advertiserAddress,
      draftRefFor(campaign.id),
      confirmed,
    );

    if (mapped !== created.campaignId) {
      return mapped === null
        ? { ok: false, status: 202, code: "TX_UNCONFIRMED" }
        : { ok: false, status: 422, code: "DRAFT_MISMATCH" };
    }

    const onchain = await readOnchainCampaign(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      created.campaignId,
      confirmed,
    );

    if (!onchain || !matchesDraft(campaign, onchain)) {
      return { ok: false, status: 422, code: "PARAMETERS_MISMATCH" };
    }

    const linked = await dependencies.campaigns.linkOnchain(campaign.id, {
      onchainCampaignId: created.campaignId,
      contractAddress: dependencies.chain.contractAddress,
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

/**
 * Links a draft without a transaction hash: the contract's
 * `campaignIdByDraft(advertiser, draftRef)` says whether this draft's
 * campaign exists. Used after a lost RPC response or by another tab.
 * "Not created yet" is reported as pending, never as a failure.
 */
export async function linkCampaignByDraft(
  dependencies: OnchainDependencies,
  input: { campaignId: string },
): Promise<LinkOutcome> {
  const campaign = await dependencies.campaigns.getById(input.campaignId);

  if (!campaign) {
    return { ok: false, status: 404, code: "CAMPAIGN_NOT_FOUND" };
  }

  if (campaign.chainId !== dependencies.chain.chainId) {
    return { ok: false, status: 409, code: "WRONG_CHAIN" };
  }

  if (campaign.onchainCampaignId !== null) {
    // Linked on another deployment (before a redeploy): never reuse it.
    return campaign.onchainContractAddress ===
      dependencies.chain.contractAddress
      ? { ok: true, campaign }
      : { ok: false, status: 409, code: "ALREADY_LINKED" };
  }

  try {
    // Read at the confirmed block: an unconfirmed creation is not linked yet.
    const confirmed = await confirmedHead(dependencies);
    const onchainCampaignId =
      confirmed === null
        ? null
        : await readCampaignIdByDraft(
            dependencies.rpc,
            dependencies.chain.contractAddress,
            campaign.advertiserAddress,
            draftRefFor(campaign.id),
            confirmed,
          );

    if (!onchainCampaignId) {
      return { ok: false, status: 202, code: "NOT_CREATED_YET" };
    }

    const onchain = await readOnchainCampaign(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      onchainCampaignId,
      confirmed!,
    );

    if (!onchain || !matchesDraft(campaign, onchain)) {
      return { ok: false, status: 422, code: "PARAMETERS_MISMATCH" };
    }

    const linked = await dependencies.campaigns.linkOnchain(campaign.id, {
      onchainCampaignId,
      contractAddress: dependencies.chain.contractAddress,
      publishTxHash: null,
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
  /**
   * Links whose confirmed CampaignCreated names another draft or advertiser
   * (only possible after a reorg deeper than the link's confirmation). Their
   * status is never synced; autoLinkCreatedCampaigns relinks them.
   */
  orphanedLinks: string[];
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
  const result: StatusSyncResult = {
    updated: [],
    accountingViolations: [],
    orphanedLinks: [],
  };

  for (const campaign of await dependencies.campaigns.listLinked(
    dependencies.chain.chainId,
    dependencies.chain.contractAddress,
  )) {
    const events = await dependencies.events.listCampaignEvents(
      dependencies.chain,
      campaign.onchainCampaignId!,
    );

    // The canonical creation for this id must be this draft's (ADR-0011);
    // otherwise the events belong to another campaign.
    const creation = events.find(
      (stored) =>
        stored.status === "confirmed" &&
        stored.event.name === "CampaignCreated",
    )?.event;

    if (
      creation?.name === "CampaignCreated" &&
      (creation.draftRef !== draftRefFor(campaign.id) ||
        creation.advertiser !== campaign.advertiserAddress)
    ) {
      result.orphanedLinks.push(campaign.id);
      continue;
    }

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
 * unlinked draft whose draft reference it carries (ADR-0011), after checking
 * the economics. Events without a matching draft are ignored; `ambiguous`
 * stays for events whose economics contradict their draft.
 *
 * A confirmed creation is canonical. If its id is linked to a different
 * draft (a link to a creation that a reorg removed), that link is released
 * (`relinked`) so the draft the event names can be linked instead.
 */
export async function autoLinkCreatedCampaigns(
  dependencies: OnchainDependencies & { events: ChainEventRepository },
): Promise<{ linked: string[]; ambiguous: string[]; relinked: string[] }> {
  const linked: string[] = [];
  const ambiguous: string[] = [];
  const relinked: string[] = [];
  const createdEvents = await dependencies.events.listConfirmedCreations(
    dependencies.chain,
  );

  for (const created of createdEvents) {
    const existing = await dependencies.campaigns.findByOnchainId(
      dependencies.chain.chainId,
      dependencies.chain.contractAddress,
      created.onchainCampaignId,
    );

    if (existing) {
      if (
        draftRefFor(existing.id) === created.draftRef &&
        existing.advertiserAddress === created.advertiser
      ) {
        continue;
      }

      // Orphaned: the canonical creation for this id belongs to another
      // draft. Release the stale link; that draft may create again.
      if (
        await dependencies.campaigns.unlinkOnchain(
          existing.id,
          {
            onchainCampaignId: created.onchainCampaignId,
            contractAddress: dependencies.chain.contractAddress,
          },
          dependencies.now(),
        )
      ) {
        relinked.push(existing.id);
      }
    }

    const drafts = await dependencies.campaigns.listUnlinkedDrafts(
      dependencies.chain.chainId,
      created.advertiser,
    );

    if (drafts.length === 0) {
      continue;
    }

    const draft = drafts.find(
      (candidate) => draftRefFor(candidate.id) === created.draftRef,
    );

    if (!draft) {
      continue;
    }

    const onchain = await readOnchainCampaign(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      created.onchainCampaignId,
    );

    if (!onchain || !matchesDraft(draft, onchain)) {
      // The event names this draft but the economics differ: never guess.
      ambiguous.push(created.onchainCampaignId);
      continue;
    }

    try {
      await dependencies.campaigns.linkOnchain(draft.id, {
        onchainCampaignId: created.onchainCampaignId,
        contractAddress: dependencies.chain.contractAddress,
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

  return { linked, ambiguous, relinked };
}
