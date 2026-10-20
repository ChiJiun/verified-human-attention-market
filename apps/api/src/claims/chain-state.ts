import { campaignManagerAbi } from "@vham/shared/contracts";
import { decodeFunctionResult, encodeFunctionData, type Address } from "viem";

import type { ChainRpc } from "../chain/rpc.js";

export async function readClaimedWallet(
  rpc: Pick<ChainRpc, "call">,
  contractAddress: Address,
  onchainCampaignId: string,
  claimant: Address,
): Promise<boolean> {
  const result = await rpc.call(
    contractAddress,
    encodeFunctionData({
      abi: campaignManagerAbi,
      functionName: "claimedWallet",
      args: [BigInt(onchainCampaignId), claimant],
    }),
  );

  return decodeFunctionResult({
    abi: campaignManagerAbi,
    functionName: "claimedWallet",
    data: result as `0x${string}`,
  });
}
