import {
  parseContractCampaignStatus,
  type SettlementReading,
} from "@vham/shared";
import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  isFundingTarget,
  type Deployment,
  type FundingTargetExpectation,
} from "@vham/shared/deployment";
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  type Hash,
} from "viem";

import type { Wallet } from "./wallet";

/** The draft as the API describes it, plus the reference the contract maps to its id. */
export interface SettlementTarget extends FundingTargetExpectation {
  draftRef: Hash;
}

export interface ChainSettlement {
  reading: SettlementReading;
  /** Local clock when the block was read. Only the countdown uses it. */
  readAtMs: number;
}

export type SettlementAction = "close" | "refund";

/** The CampaignManager function each action calls, and how the status card names it. */
export const SETTLEMENT_CALLS = {
  close: {
    functionName: "closeCampaign",
    label: "Close campaign",
    done: "Campaign closed",
  },
  refund: {
    functionName: "refundUnusedBudget",
    label: "Refund unused budget",
    done: "Unused budget refunded",
  },
} as const;

export function formatRemaining(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

/** MAX_AUTHORIZATION_TTL is a constant, so one read per contract is enough. */
const ttlByContract = new Map<string, bigint>();

/**
 * Reads, through the wallet's own chain view, what CampaignManager will judge
 * a close or refund by. Close and refund carry only the campaign id, and after
 * a deep reorg an id can belong to another draft of the same advertiser, so
 * the id must still map to this draft with its parameters (ADR-0011) before
 * anything read here is trusted.
 */
export async function readSettlement(
  wallet: Wallet,
  deployment: Deployment,
  target: SettlementTarget,
): Promise<ChainSettlement> {
  const { publicClient } = wallet;
  if ((await publicClient.getChainId()) !== deployment.chainId) {
    throw new Error("Switch your wallet to the campaign's network first.");
  }

  const contract = {
    address: getAddress(deployment.contractAddress),
    abi: campaignManagerAbi,
  } as const;
  const ttlKey = `${deployment.chainId}:${contract.address}`;
  let ttl = ttlByContract.get(ttlKey);
  if (ttl === undefined) {
    ttl = await publicClient.readContract({
      ...contract,
      functionName: "MAX_AUTHORIZATION_TTL",
    });
    ttlByContract.set(ttlKey, ttl);
  }

  const [mappedCampaignId, onchain, paused, block] = await Promise.all([
    publicClient.readContract({
      ...contract,
      functionName: "campaignIdByDraft",
      args: [wallet.address, target.draftRef],
    }),
    publicClient.readContract({
      ...contract,
      functionName: "campaigns",
      args: [BigInt(target.onchainCampaignId)],
    }),
    publicClient.readContract({ ...contract, functionName: "paused" }),
    publicClient.getBlock(),
  ]);

  if (
    !isFundingTarget(
      {
        mappedCampaignId,
        onchain: {
          rewardPerCompletion: onchain[3],
          maxCompletions: onchain[4],
          startTime: onchain[6],
          endTime: onchain[7],
        },
      },
      target,
    )
  ) {
    throw new Error(
      "The on-chain campaign does not match this draft, so nothing was sent. Refresh the page; if it persists, the chain may be recovering.",
    );
  }

  return {
    reading: {
      status: parseContractCampaignStatus(onchain[9]),
      endTime: onchain[7],
      closedAt: onchain[8],
      ttl,
      paused,
      now: block.timestamp,
    },
    readAtMs: Date.now(),
  };
}

/** viem's one-line message; its full `message` adds docs links and versions. */
export function describeChainError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : "Unexpected error";
}

/**
 * One line for a failed simulation. CampaignManager reverts with custom
 * errors (RefundNotAvailable, CampaignAlreadyEnded, Paused, ...); naming the
 * error tells the advertiser what the contract objects to.
 */
export function describeSimulationFailure(error: unknown): string {
  const reverted =
    error instanceof BaseError
      ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
      : null;
  const name =
    reverted instanceof ContractFunctionRevertedError
      ? reverted.data?.errorName
      : undefined;

  return name
    ? `The contract would reject this transaction (${name}), so nothing was sent.`
    : `${describeChainError(error)} Nothing was sent.`;
}
