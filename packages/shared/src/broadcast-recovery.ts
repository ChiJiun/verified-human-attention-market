import type { Address, Hash } from "viem";

/**
 * Recovery for a `createCampaign` broadcast whose RPC response was lost
 * (#13). `writeContract` only returns the hash after the node answers, so a
 * timeout after broadcast leaves the client without a hash. Retrying blindly
 * would create a second campaign. Instead the sender records its next nonce
 * before broadcasting and later resolves what happened since: a mined
 * CampaignCreated from the sender, a transaction still queued, or nothing.
 * When in doubt it answers "pending", never "safe to resend".
 *
 * Only `createCampaign` needs this. Funding, approving and claiming are
 * idempotent on-chain (a second fund or claim reverts).
 */

/** Recorded before broadcasting; JSON-safe so it can be persisted. */
export interface BroadcastIntent {
  from: Address;
  nonce: number;
  /** Block number before the broadcast, as a decimal string. */
  fromBlock: string;
}

export type BroadcastResolution =
  /** The intent's transaction created this campaign. Link it; never resend. */
  | { kind: "created"; txHash: Hash; onchainCampaignId: bigint }
  /** The nonce is still in the mempool. Wait; never resend. */
  | { kind: "pending" }
  /** Nothing with this nonce reached the node. Safe to send again. */
  | { kind: "not-sent" }
  /** The nonce was used by an unrelated transaction. Safe to send again. */
  | { kind: "nonce-used-elsewhere" };

interface CampaignCreatedLog {
  transactionHash: Hash | null;
  args: { campaignId?: bigint | undefined };
}

/** The read-only calls needed; satisfied by a viem `PublicClient`. */
export interface BroadcastRecoveryClient {
  getTransactionCount(args: {
    address: Address;
    blockTag: "latest" | "pending";
  }): Promise<number>;
  /** `cacheTime: 0`: viem caches the block number for a few seconds. */
  getBlockNumber(args: { cacheTime: number }): Promise<bigint>;
  getTransaction(args: {
    hash: Hash;
  }): Promise<{ from: Address; nonce: number }>;
  getContractEvents(args: {
    address: Address;
    abi: typeof campaignCreatedEvent;
    eventName: "CampaignCreated";
    args: { advertiser: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<CampaignCreatedLog[]>;
}

export const campaignCreatedEvent = [
  {
    type: "event",
    name: "CampaignCreated",
    inputs: [
      { name: "campaignId", type: "uint256", indexed: true },
      { name: "advertiser", type: "address", indexed: true },
    ],
  },
] as const;

/** Public RPCs cap eth_getLogs ranges (Base Sepolia: 200 blocks). */
const LOG_RANGE = 200n;

export async function prepareBroadcast(
  client: BroadcastRecoveryClient,
  from: Address,
): Promise<BroadcastIntent> {
  const [nonce, block] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);

  return { from, nonce, fromBlock: block.toString() };
}

export async function resolveCreateBroadcast(
  client: BroadcastRecoveryClient,
  input: { intent: BroadcastIntent; campaignManager: Address },
): Promise<BroadcastResolution> {
  const { intent } = input;
  const [mined, pending] = await Promise.all([
    client.getTransactionCount({ address: intent.from, blockTag: "latest" }),
    client.getTransactionCount({ address: intent.from, blockTag: "pending" }),
  ]);

  if (mined <= intent.nonce) {
    return pending > intent.nonce ? { kind: "pending" } : { kind: "not-sent" };
  }

  // A browser wallet picks the nonce itself and may have used a later one
  // (another transaction was queued first). Any CampaignCreated by this
  // sender at or after the recorded nonce counts; the exact nonce wins. The
  // API still checks the campaign parameters before linking.
  const head = await client.getBlockNumber({ cacheTime: 0 });
  let best: { txHash: Hash; onchainCampaignId: bigint; nonce: number } | null =
    null;

  for (
    let fromBlock = BigInt(intent.fromBlock);
    fromBlock <= head && best?.nonce !== intent.nonce;
    fromBlock += LOG_RANGE
  ) {
    const toBlock =
      fromBlock + LOG_RANGE - 1n < head ? fromBlock + LOG_RANGE - 1n : head;
    const logs = await client.getContractEvents({
      address: input.campaignManager,
      abi: campaignCreatedEvent,
      eventName: "CampaignCreated",
      args: { advertiser: intent.from },
      fromBlock,
      toBlock,
    });

    for (const log of logs) {
      if (!log.transactionHash || log.args.campaignId === undefined) continue;
      const tx = await client.getTransaction({ hash: log.transactionHash });

      if (
        tx.from.toLowerCase() === intent.from.toLowerCase() &&
        tx.nonce >= intent.nonce &&
        (best === null || tx.nonce < best.nonce)
      ) {
        best = {
          txHash: log.transactionHash,
          onchainCampaignId: log.args.campaignId,
          nonce: tx.nonce,
        };
      }
    }
  }

  if (best) {
    return {
      kind: "created",
      txHash: best.txHash,
      onchainCampaignId: best.onchainCampaignId,
    };
  }

  // Something from this sender is still queued: it may be the create.
  return pending > mined
    ? { kind: "pending" }
    : { kind: "nonce-used-elsewhere" };
}
