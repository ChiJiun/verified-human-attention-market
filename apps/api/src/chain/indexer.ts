import { decodeCampaignManagerLog, EVENT_TOPICS } from "./abi.js";
import { bloomMatcher, parseBloom } from "./bloom.js";
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
  /**
   * eth_getLogs requests by block hash this pass made to prove committed
   * ranges complete: one per block whose bloom may hold an event (#102).
   */
  blockLogQueries: number;
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
  constructor(
    readonly blockNumber: bigint,
    /** What disagreed, when it is more than a header or log hash. */
    readonly reason?: string,
  ) {
    super(
      `Inconsistent chain read at block ${blockNumber}${reason ? `: ${reason}` : ""}; retrying`,
    );
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

/** First topics of every event the indexer decodes. */
const EVENT_TOPIC_LIST: readonly string[] = Object.values(EVENT_TOPICS);
const EVENT_TOPIC_SET = new Set(EVENT_TOPIC_LIST);

/** A log of `contract` whose first topic is one of the indexed events. */
const isEventLog = (log: RawLog, contract: string) =>
  log.address === contract && EVENT_TOPIC_SET.has(log.topics[0] ?? "");

/** Identity and content: two answers for one block must agree on both. */
const logKey = (log: RawLog) =>
  `${log.transactionHash}:${log.logIndex}:${log.topics.join(",")}:${log.data}`;

/** eth_getLogs-by-hash requests in flight at once. */
const BLOCK_LOGS_CONCURRENCY = 8;

/**
 * The range's eth_getLogs answer must hold every event of the range (issue
 * #102). Hash links cannot show that: a node behind the others (or whose log
 * index lags) answers the range with fewer logs while the headers, read from
 * another node, still link.
 *
 * Each header's logsBloom, tested locally, tells which blocks may hold an
 * event of the contract. Every such block is read again with eth_getLogs by
 * its hash (EIP-234), whose answer is that block's logs whichever node gives
 * it (a node without the block fails), and the range answer must hold
 * exactly those events for it. A block whose bloom rules the events out must
 * have none in the range answer. Any difference is an
 * InconsistentChainReadError: nothing is committed, the next pass retries.
 *
 * Cost: no request for a block whose bloom rules the events out; one
 * eth_getLogs per block that may hold one (blocks with events, and bloom
 * false positives). Returns that number.
 */
async function expectCompleteLogs(
  rpc: ChainRpc,
  contract: string,
  headers: Map<bigint, BlockHeader>,
  range: { from: bigint; to: bigint },
  logs: RawLog[],
): Promise<number> {
  const read = new Map<bigint, RawLog[]>();

  for (const log of logs) {
    if (!log.removed && isEventLog(log, contract)) {
      read.set(log.blockNumber, [...(read.get(log.blockNumber) ?? []), log]);
    }
  }

  const mayHoldEvents = bloomMatcher(contract, EVENT_TOPIC_LIST);
  const flagged: BlockHeader[] = [];

  for (let number = range.from; number <= range.to; number += 1n) {
    const header = headers.get(number)!;
    // A header without a valid bloom proves nothing: read the block.
    const bloom = parseBloom(header.logsBloom);

    if (bloom === null || mayHoldEvents(bloom)) {
      flagged.push(header);
    } else if (read.has(number)) {
      throw new InconsistentChainReadError(
        number,
        "eth_getLogs returned an event that the block's logsBloom rules out",
      );
    }
  }

  for (let start = 0; start < flagged.length; start += BLOCK_LOGS_CONCURRENCY) {
    const chunk = flagged.slice(start, start + BLOCK_LOGS_CONCURRENCY);
    const answers = await Promise.all(
      chunk.map((header) =>
        rpc.getBlockLogs({
          blockHash: header.hash,
          address: contract,
          topics: [EVENT_TOPIC_LIST],
        }),
      ),
    );

    answers.forEach((answer, index) => {
      const header = chunk[index]!;

      if (
        answer.some(
          (log) =>
            log.blockHash.toLowerCase() !== header.hash ||
            log.blockNumber !== header.number,
        )
      ) {
        throw new InconsistentChainReadError(
          header.number,
          "eth_getLogs by block hash answered for another block",
        );
      }

      const held = new Set(
        answer.filter((log) => isEventLog(log, contract)).map(logKey),
      );
      const returned = new Set((read.get(header.number) ?? []).map(logKey));
      const omitted = [...held].filter((key) => !returned.has(key)).length;

      if (omitted > 0) {
        throw new InconsistentChainReadError(
          header.number,
          `eth_getLogs for blocks ${range.from}-${range.to} omitted ${omitted} event(s) of this block that eth_getLogs by its hash returns`,
        );
      }

      if ([...returned].some((key) => !held.has(key))) {
        throw new InconsistentChainReadError(
          header.number,
          "eth_getLogs returned an event that eth_getLogs by the block's hash does not",
        );
      }
    });
  }

  return flagged.length;
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
 * - A batch is committed only with every event of its blocks (issue #102):
 *   each block whose logsBloom may hold one is read again by hash, so a
 *   getLogs answer that left events out (a lagging node) is retried too.
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
  let blockLogQueries = 0;

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

    // Logs that are there belong to the chain; now none may be missing.
    blockLogQueries += await expectCompleteLogs(
      rpc,
      scope.contractAddress,
      headers,
      { from, to },
      logs,
    );

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
    blockLogQueries,
  };
}
