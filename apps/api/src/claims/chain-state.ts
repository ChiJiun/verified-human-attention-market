import { campaignManagerAbi } from "@vham/shared/contracts";
import { decodeFunctionResult, encodeFunctionData, type Address } from "viem";

import { readOnchainCampaign } from "../campaigns/onchain.js";
import type { ChainRpc } from "../chain/rpc.js";

export interface ClaimChainState {
  /** RewardClaimed count already settled on-chain. */
  paidCompletions: number;
  maxCompletions: number;
  /** Non-zero once the advertiser closed the campaign on-chain. */
  closedAt: number;
  endTime: number;
  /** The claimant wallet was already paid for this campaign. */
  alreadyClaimed: boolean;
}

/**
 * Live contract state read immediately before signing. Unlike indexed
 * events it has no confirmation lag, so a just-closed campaign stops
 * issuance at once and paid completions free their slots precisely.
 */
export async function readClaimChainState(
  rpc: Pick<ChainRpc, "call">,
  contractAddress: Address,
  onchainCampaignId: string,
  claimant: Address,
): Promise<ClaimChainState | null> {
  const campaign = await readOnchainCampaign(
    rpc,
    contractAddress,
    onchainCampaignId,
  );

  if (!campaign) {
    return null;
  }

  const result = await rpc.call(
    contractAddress,
    encodeFunctionData({
      abi: campaignManagerAbi,
      functionName: "claimedWallet",
      args: [BigInt(onchainCampaignId), claimant],
    }),
  );

  return {
    paidCompletions: campaign.paidCompletions,
    maxCompletions: campaign.maxCompletions,
    closedAt: campaign.closedAt,
    endTime: campaign.endTime,
    alreadyClaimed: decodeFunctionResult({
      abi: campaignManagerAbi,
      functionName: "claimedWallet",
      data: result as `0x${string}`,
    }),
  };
}
