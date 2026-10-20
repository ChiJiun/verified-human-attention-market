import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  isDraftCampaign,
  type Deployment,
  type DraftCampaignExpectation,
} from "@vham/shared/deployment";
import {
  parseClosedAt,
  parseStoredCampaignStatus,
  type SettlementReading,
} from "@vham/shared/settlement";
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  type Hash,
} from "viem";

import type { Wallet } from "./wallet";

export interface SettlementTarget extends DraftCampaignExpectation {
  draftRef: Hash;
}

export interface ChainSettlement {
  reading: SettlementReading;
  readAtMs: number;
}

export type SettlementAction = "close" | "refund";

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

const ttlByContract = new Map<string, bigint>();

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
    !isDraftCampaign(
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
      storedStatus: parseStoredCampaignStatus(onchain[9]),
      endTime: onchain[7],
      closedAt: parseClosedAt(onchain[8]),
      maxAuthorizationTtl: ttl,
      paused,
      blockTimestamp: block.timestamp,
    },
    readAtMs: Date.now(),
  };
}

export function describeChainError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : "Unexpected error";
}

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
