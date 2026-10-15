import type { Address, Hash } from "viem";

/**
 * Safe `createCampaign` sending with recovery from a lost RPC response (#13).
 *
 * `writeContract` returns the hash only after the node answers, so a timeout
 * after broadcast leaves the client without a hash, and a blind retry would
 * create a second campaign. A single RPC observation can never prove that a
 * transaction was *not* broadcast (it may sit in another node's mempool), so:
 *
 * 1. Before sending, the intent (sender, next nonce, block, expected campaign
 *    parameters) is saved and read back. If it cannot be saved, nothing is sent.
 * 2. While an intent exists, the client never sends again. It only looks for
 *    a confirmed `CampaignCreated` from the sender, at or after the recorded
 *    nonce, whose on-chain parameters equal the draft's. Anything else is
 *    "unresolved": wait, and let the indexer auto-link (API_SPEC) do the rest.
 * 3. The intent is cleared only when the API has linked the campaign, the
 *    transaction reverted, or the wallet rejected the request before sending.
 *
 * Only `createCampaign` needs this. Funding, approving and claiming are
 * idempotent on-chain (a second fund or claim reverts).
 */

export interface CampaignParameters {
  rewardPerCompletion: string;
  maxCompletions: number;
  startTime: string;
  endTime: string;
}

/** Persisted before broadcasting; JSON-safe. */
export interface BroadcastIntent {
  from: Address;
  nonce: number;
  /** Block number before the broadcast, as a decimal string. */
  fromBlock: string;
  expected: CampaignParameters;
}

export type BroadcastResolution =
  /** A confirmed creation with the draft's parameters. Link it. */
  | { kind: "created"; txHash: Hash; onchainCampaignId: bigint }
  /** Not (yet) provable either way. Wait; never resend. */
  | { kind: "unresolved"; reason: "pending" | "not-found" };

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

export const campaignsGetter = [
  {
    type: "function",
    name: "campaigns",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "advertiser", type: "address" },
      { name: "fundedBudget", type: "uint128" },
      { name: "paidRewards", type: "uint128" },
      { name: "rewardPerCompletion", type: "uint96" },
      { name: "maxCompletions", type: "uint32" },
      { name: "paidCompletions", type: "uint32" },
      { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" },
      { name: "closedAt", type: "uint64" },
      { name: "status", type: "uint8" },
    ],
  },
] as const;

type CampaignTuple = readonly [
  Address,
  bigint,
  bigint,
  bigint,
  number,
  number,
  bigint,
  bigint,
  bigint,
  number,
];

/** The read-only calls needed; satisfied by a viem `PublicClient`. */
export interface BroadcastRecoveryClient {
  getTransactionCount(args: {
    address: Address;
    blockTag: "latest" | "pending";
  }): Promise<number>;
  /** Called with `cacheTime: 0`: viem caches the block number for seconds. */
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
  }): Promise<
    {
      transactionHash: Hash | null;
      args: { campaignId?: bigint | undefined };
    }[]
  >;
  readContract(args: {
    address: Address;
    abi: typeof campaignsGetter;
    functionName: "campaigns";
    args: readonly [bigint];
  }): Promise<CampaignTuple>;
}

/** Durable storage for one draft's intent. Methods may throw. */
export interface IntentStore {
  load(): BroadcastIntent | null;
  save(intent: BroadcastIntent): void;
  clear(): void;
}

export class IntentNotSavedError extends Error {
  constructor() {
    super(
      "This browser could not save the transaction progress (site storage is blocked or full). Nothing was sent. Allow storage for this site and try again.",
    );
    this.name = "IntentNotSavedError";
  }
}

/** Public RPCs cap eth_getLogs ranges (Base Sepolia: 200 blocks). */
const LOG_RANGE = 200n;

export async function prepareBroadcast(
  client: BroadcastRecoveryClient,
  from: Address,
  expected: CampaignParameters,
): Promise<BroadcastIntent> {
  const [nonce, block] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: "pending" }),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);

  return { from, nonce, fromBlock: block.toString(), expected };
}

function sameParameters(
  onchain: CampaignTuple,
  expected: CampaignParameters,
): boolean {
  return (
    onchain[3] === BigInt(expected.rewardPerCompletion) &&
    onchain[4] === expected.maxCompletions &&
    onchain[6] === BigInt(expected.startTime) &&
    onchain[7] === BigInt(expected.endTime)
  );
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

  if (mined > intent.nonce) {
    // The wallet chooses the nonce and may have used a later one; the same
    // wallet may also have created other campaigns. Only a creation from
    // this sender at or after the nonce WITH the draft's parameters counts;
    // the lowest such nonce wins.
    const head = await client.getBlockNumber({ cacheTime: 0 });
    let best: {
      txHash: Hash;
      onchainCampaignId: bigint;
      nonce: number;
    } | null = null;

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
        const campaignId = log.args.campaignId;
        if (!log.transactionHash || campaignId === undefined) continue;
        const tx = await client.getTransaction({ hash: log.transactionHash });

        if (
          tx.from.toLowerCase() !== intent.from.toLowerCase() ||
          tx.nonce < intent.nonce ||
          (best !== null && tx.nonce >= best.nonce)
        ) {
          continue;
        }

        const onchain = await client.readContract({
          address: input.campaignManager,
          abi: campaignsGetter,
          functionName: "campaigns",
          args: [campaignId],
        });

        if (sameParameters(onchain, intent.expected)) {
          best = {
            txHash: log.transactionHash,
            onchainCampaignId: campaignId,
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
  }

  return {
    kind: "unresolved",
    reason: pending > mined ? "pending" : "not-found",
  };
}

export type CreateOutcome =
  /** Newly broadcast; the hash is known. */
  | { kind: "sent"; txHash: Hash }
  /** An earlier broadcast was found on-chain. */
  | { kind: "recovered"; txHash: Hash; onchainCampaignId: bigint }
  /** An earlier attempt cannot be resolved yet. Nothing was sent. */
  | { kind: "unresolved"; reason: "pending" | "not-found" };

/** EIP-1193 4001: the user rejected the request, so nothing was broadcast. */
function isUserRejection(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 10;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    const candidate = current as { code?: unknown; name?: unknown };
    if (
      candidate.code === 4001 ||
      candidate.name === "UserRejectedRequestError"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Sends `createCampaign` at most once per draft. `send` must broadcast the
 * transaction and return its hash. The caller clears the store after the API
 * has linked the campaign, or after the transaction reverted.
 */
export async function createCampaignOnce(input: {
  client: BroadcastRecoveryClient;
  store: IntentStore;
  from: Address;
  campaignManager: Address;
  expected: CampaignParameters;
  send: () => Promise<Hash>;
}): Promise<CreateOutcome> {
  const earlier = input.store.load();

  if (earlier) {
    const resolution = await resolveCreateBroadcast(input.client, {
      intent: earlier,
      campaignManager: input.campaignManager,
    });

    return resolution.kind === "created"
      ? {
          kind: "recovered",
          txHash: resolution.txHash,
          onchainCampaignId: resolution.onchainCampaignId,
        }
      : resolution;
  }

  const intent = await prepareBroadcast(
    input.client,
    input.from,
    input.expected,
  );

  try {
    input.store.save(intent);
  } catch {
    throw new IntentNotSavedError();
  }

  const saved = (() => {
    try {
      return input.store.load();
    } catch {
      return null;
    }
  })();

  if (
    !saved ||
    saved.nonce !== intent.nonce ||
    saved.fromBlock !== intent.fromBlock ||
    saved.from.toLowerCase() !== intent.from.toLowerCase()
  ) {
    throw new IntentNotSavedError();
  }

  try {
    return { kind: "sent", txHash: await input.send() };
  } catch (error) {
    // Rejected in the wallet: provably never broadcast, so a retry is safe.
    // Any other failure may have happened after broadcast: keep the intent.
    if (isUserRejection(error)) {
      input.store.clear();
    }
    throw error;
  }
}
