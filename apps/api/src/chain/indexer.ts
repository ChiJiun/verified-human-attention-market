import { decodeCampaignManagerLog } from "./abi.js";
import type {
  ChainEventRepository,
  IndexedEvent,
} from "./events-repository.js";
import type { ChainRpc, RawLog } from "./rpc.js";

export interface IndexerConfig {
  chainId: number;
  contractAddress: string;
  /** Block the contract was deployed in; indexing starts here. */
  deployBlock: bigint;
  /**
   * Finality policy: a block is confirmed once `confirmations` newer blocks
   * exist. Events in newer blocks are stored as "observed" (pending).
   */
  confirmations: number;
  /** Max blocks per eth_getLogs request. */
  maxBlockRange: bigint;
}

export interface IndexResult {
  head: bigint;
  confirmedThrough: bigint;
  confirmedEvents: number;
  observedEvents: number;
  skippedLogs: number;
}

/** A confirmed block changed: the confirmation depth was too shallow. */
export class ReorgBeyondConfirmationsError extends Error {
  constructor(readonly blockNumber: bigint) {
    super(
      `Confirmed block ${blockNumber} is no longer canonical; manual reconciliation required`,
    );
    this.name = "ReorgBeyondConfirmationsError";
  }
}

/**
 * The chain changed between reads of one range (or the RPC answered from
 * different forks). Transient: nothing was committed; the next pass retries.
 */
export class InconsistentChainReadError extends Error {
  constructor(readonly blockNumber: bigint) {
    super(`Inconsistent chain read at block ${blockNumber}; retrying`);
    this.name = "InconsistentChainReadError";
  }
}

function decode(
  logs: RawLog[],
  contractAddress: string,
): { events: IndexedEvent[]; skipped: number } {
  const events: IndexedEvent[] = [];
  let skipped = 0;

  for (const log of logs) {
    if (log.removed || log.address !== contractAddress) {
      skipped += 1;
      continue;
    }

    const event = decodeCampaignManagerLog(log);

    if (!event) {
      skipped += 1;
      continue;
    }

    events.push({
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      event,
    });
  }

  return { events, skipped };
}

/**
 * One idempotent indexing pass (issue #17).
 *
 * - Confirmed ranges are committed batch by batch together with the cursor,
 *   so a crash or RPC failure resumes from the last committed batch without
 *   losing or duplicating events: (chain, tx, logIndex) is the identity.
 * - The cursor stores the hash of the last confirmed block; if it changes,
 *   the pass stops with ReorgBeyondConfirmationsError instead of guessing.
 * - The unconfirmed tail is re-read on every pass; events that disappear in
 *   a shallow reorg are marked "orphaned" and never count as settlement.
 */
export async function indexOnce(
  rpc: ChainRpc,
  repository: ChainEventRepository,
  config: IndexerConfig,
): Promise<IndexResult> {
  const scope = {
    chainId: config.chainId,
    contractAddress: config.contractAddress.toLowerCase(),
  };
  const head = await rpc.blockNumber();
  const safeHead = head - BigInt(config.confirmations);
  const cursor = await repository.getCursor(scope);
  let confirmedThrough =
    cursor?.latestConfirmedBlock ?? config.deployBlock - 1n;

  if (cursor?.latestConfirmedBlockHash) {
    const block = await rpc.getBlock(cursor.latestConfirmedBlock);

    if (!block || block.hash !== cursor.latestConfirmedBlockHash) {
      throw new ReorgBeyondConfirmationsError(cursor.latestConfirmedBlock);
    }
  }

  let confirmedEvents = 0;
  let observedEvents = 0;
  let skippedLogs = 0;

  while (confirmedThrough < safeHead) {
    const from = confirmedThrough + 1n;
    const to =
      from + config.maxBlockRange - 1n < safeHead
        ? from + config.maxBlockRange - 1n
        : safeHead;

    // Header, logs, header again: if the chain reorganizes between these
    // calls (or a load-balanced RPC answers from different forks), logs of
    // a stale fork could be committed under the new fork's block hash and
    // never be detected later. Every log must sit in the canonical block of
    // its height, and the range end must not move while reading.
    const toBlock = await rpc.getBlock(to);

    if (!toBlock) {
      break;
    }

    const logs = await rpc.getLogs({
      address: scope.contractAddress,
      fromBlock: from,
      toBlock: to,
    });
    const canonicalHashes = new Map<bigint, string>([[to, toBlock.hash]]);

    for (const log of logs) {
      if (!canonicalHashes.has(log.blockNumber)) {
        const block = await rpc.getBlock(log.blockNumber);
        canonicalHashes.set(log.blockNumber, block?.hash ?? "");
      }
      if (
        canonicalHashes.get(log.blockNumber) !== log.blockHash.toLowerCase()
      ) {
        throw new InconsistentChainReadError(log.blockNumber);
      }
    }

    const toBlockAgain = await rpc.getBlock(to);

    if (!toBlockAgain || toBlockAgain.hash !== toBlock.hash) {
      throw new InconsistentChainReadError(to);
    }

    const { events, skipped } = decode(logs, scope.contractAddress);
    await repository.commitConfirmedRange(
      scope,
      { from, to, toBlockHash: toBlock.hash },
      events,
    );

    confirmedEvents += events.length;
    skippedLogs += skipped;
    confirmedThrough = to;
  }

  const tailFrom =
    confirmedThrough + 1n > config.deployBlock
      ? confirmedThrough + 1n
      : config.deployBlock;

  if (head >= tailFrom) {
    const logs = await rpc.getLogs({
      address: scope.contractAddress,
      fromBlock: tailFrom,
      toBlock: head,
    });
    const { events, skipped } = decode(logs, scope.contractAddress);
    await repository.replaceObservedTail(
      scope,
      { from: tailFrom, to: head },
      events,
    );
    observedEvents = events.length;
    skippedLogs += skipped;
  }

  return {
    head,
    confirmedThrough,
    confirmedEvents,
    observedEvents,
    skippedLogs,
  };
}
