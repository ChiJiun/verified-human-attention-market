import { decodeCampaignManagerLog } from "./abi.js";
import type {
  ChainEventRepository,
  IndexedEvent,
} from "./events-repository.js";
import type { BlockHeader, ChainRpc, RawLog } from "./rpc.js";

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
 * The committed block `number` must still have `hash`. Another hash is a
 * reorg deeper than the confirmation depth. No block at all is a node that
 * has not reached it yet (lagging behind a load balancer), not a reorg:
 * retried, so a lagging node never causes a halt that needs an operator.
 */
async function expectCommitted(rpc: ChainRpc, number: bigint, hash: string) {
  const block = await rpc.getBlock(number);

  if (!block) {
    throw new InconsistentChainReadError(number);
  }

  if (block.hash !== hash) {
    throw new ReorgBeyondConfirmationsError(number);
  }
}

/** Header reads in flight at once while checking a range's chain. */
const HEADER_CONCURRENCY = 8;

/**
 * The headers of `from`..`top.number` as one chain ending at `top`: each
 * header must be the parent of the next by hash, so headers that different
 * nodes answered from different forks never pass as one chain (a missing
 * header or a broken link is an InconsistentChainReadError). Read by number
 * with bounded concurrency rather than by walking `parentHash`, which could
 * only be sequential. Cost: one eth_getBlockByNumber per block of the range,
 * i.e. up to INDEXER_MAX_BLOCK_RANGE per batch on a backfill and a few per
 * pass once caught up.
 */
async function linkedHeaders(
  rpc: ChainRpc,
  from: bigint,
  top: BlockHeader,
): Promise<Map<bigint, BlockHeader>> {
  const headers = new Map<bigint, BlockHeader>([[top.number, top]]);
  const numbers: bigint[] = [];

  for (let number = from; number < top.number; number += 1n) {
    numbers.push(number);
  }

  for (let start = 0; start < numbers.length; start += HEADER_CONCURRENCY) {
    const chunk = numbers.slice(start, start + HEADER_CONCURRENCY);
    const read = await Promise.all(chunk.map((number) => rpc.getBlock(number)));
    read.forEach((header, index) => {
      if (!header) {
        throw new InconsistentChainReadError(chunk[index]!);
      }
      headers.set(chunk[index]!, header);
    });
  }

  for (let number = top.number; number > from; number -= 1n) {
    if (headers.get(number)!.parentHash !== headers.get(number - 1n)!.hash) {
      throw new InconsistentChainReadError(number - 1n);
    }
  }

  return headers;
}

/**
 * One idempotent indexing pass (issue #17).
 *
 * - Confirmed ranges are committed batch by batch together with the cursor,
 *   so a crash or RPC failure resumes from the last committed batch without
 *   losing or duplicating events: (chain, tx, logIndex) is the identity.
 * - The cursor stores the hash of the last confirmed block; if it changes,
 *   the pass stops with ReorgBeyondConfirmationsError instead of guessing.
 * - The committed index is one hash-linked chain (issue #76): a batch's
 *   headers must link to each other by hash up to the range end, its first
 *   block's parent must be the last committed block, and every log must
 *   carry the hash of its block in that chain. A deeper reorg during the
 *   pass is therefore a halt too, and a batch whose reads came from
 *   different forks or nodes is retried; neither is ever committed. Any
 *   later rewrite of a committed block changes the cursor block's hash.
 * - A confirmed batch is committed only if the hash of its last block is the
 *   same before and after eth_getLogs, so logs read across a reorg or a
 *   provider node switch are never stored under a block hash they do not
 *   belong to.
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
  // Hash of the last committed block, which the next batch must extend.
  let committedHash = cursor?.latestConfirmedBlockHash ?? null;
  // Every write names the cursor it extends, so a write that would land on
  // an index reset during this pass is refused instead of leaving a gap.
  let storedCursor = cursor?.latestConfirmedBlock ?? null;

  if (cursor?.latestConfirmedBlockHash) {
    await expectCommitted(
      rpc,
      cursor.latestConfirmedBlock,
      cursor.latestConfirmedBlockHash,
    );
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

    // Header, logs, the range's chain, header again: if the chain
    // reorganizes between these calls (or a load-balanced RPC answers from
    // different forks), logs of a stale fork could be committed under the
    // new fork's block hash and never be detected later. Every log must sit
    // in the hash-linked chain that ends at the range end, that chain must
    // extend the committed one, and the range end must not move while
    // reading.
    const toBlock = await rpc.getBlock(to);

    if (!toBlock) {
      break;
    }

    const logs = await rpc.getLogs({
      address: scope.contractAddress,
      fromBlock: from,
      toBlock: to,
    });
    const headers = await linkedHeaders(rpc, from, toBlock);

    // The range must extend the committed chain. If it does not, the last
    // committed block is re-read: replaced means a reorg deeper than the
    // confirmation depth (halt, as at the start of the pass); unchanged or
    // missing means the reads came from different nodes (retry).
    if (
      committedHash !== null &&
      headers.get(from)!.parentHash !== committedHash
    ) {
      await expectCommitted(rpc, confirmedThrough, committedHash);
      throw new InconsistentChainReadError(from);
    }

    for (const log of logs) {
      if (headers.get(log.blockNumber)?.hash !== log.blockHash.toLowerCase()) {
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
      { from, to, toBlockHash: toBlock.hash, expectedCursor: storedCursor },
      events,
    );

    confirmedEvents += events.length;
    skippedLogs += skipped;
    confirmedThrough = to;
    committedHash = toBlock.hash;
    storedCursor = to;
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
      { from: tailFrom, to: head, expectedCursor: storedCursor },
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
