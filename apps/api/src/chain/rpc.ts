/**
 * Minimal JSON-RPC client for the indexer and reconciliation (issue #17).
 * Only read methods; the API never broadcasts transactions.
 */

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  removed: boolean;
}

export interface BlockHeader {
  number: bigint;
  hash: string;
  parentHash: string;
  /** 256-byte bloom of the block's log addresses and topics, 0x hex. */
  logsBloom: string;
  /** Transactions in the block; null if the node did not list them. */
  transactionCount: number | null;
}

export interface TransactionReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  logs: RawLog[];
}

/** One receipt of eth_getBlockReceipts: what it says about its block. */
export interface BlockReceipt {
  transactionIndex: number;
  blockNumber: bigint;
  blockHash: string;
  logs: RawLog[];
}

/**
 * A block number, or a block hash (EIP-1898): a read by hash is the state of
 * exactly that block whichever node answers, and fails on a node that does
 * not have it on its canonical chain (`requireCanonical`) or no longer keeps
 * its state (a full node prunes all but recent blocks).
 */
export type BlockRef = bigint | { blockHash: string };

export interface ChainRpc {
  blockNumber(): Promise<bigint>;
  getBlock(number: bigint): Promise<BlockHeader | null>;
  getLogs(query: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]>;
  /**
   * eth_getBlockReceipts of exactly one block, by its hash: every receipt,
   * so every log, of that block whichever node answers (the hash fixes
   * them). Null when the node does not have the block. A node that has the
   * header but not (all) the receipts may answer fewer; the caller checks
   * them against the header.
   */
  getBlockReceipts(blockHash: string): Promise<BlockReceipt[] | null>;
  getTransactionReceipt(hash: string): Promise<TransactionReceipt | null>;
  /** eth_call at `block` (default: latest). */
  call(to: string, data: string, block?: BlockRef): Promise<string>;
}

/** Transport or provider failure. Always safe to retry: reads only. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

const toHex = (value: bigint) => `0x${value.toString(16)}`;

function parseLog(raw: Record<string, unknown>): RawLog {
  return {
    address: String(raw.address).toLowerCase(),
    topics: (raw.topics as string[]).map((topic) => topic.toLowerCase()),
    data: String(raw.data).toLowerCase(),
    blockNumber: BigInt(String(raw.blockNumber)),
    blockHash: String(raw.blockHash).toLowerCase(),
    transactionHash: String(raw.transactionHash).toLowerCase(),
    logIndex: Number(BigInt(String(raw.logIndex))),
    removed: raw.removed === true,
  };
}

export class JsonRpcClient implements ChainRpc {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
    /** Called before every request, e.g. to count requests by method. */
    private readonly onRequest?: (method: string) => void,
  ) {}

  private async request(method: string, params: unknown[]): Promise<unknown> {
    let response: Response;
    this.onRequest?.(method);

    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextId++,
          method,
          params,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RpcError(
        `${method} failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    }

    if (!response.ok) {
      throw new RpcError(`${method} returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };

    if (body.error) {
      throw new RpcError(`${method} error: ${body.error.message ?? "unknown"}`);
    }

    return body.result ?? null;
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(String(await this.request("eth_blockNumber", [])));
  }

  async getBlock(number: bigint): Promise<BlockHeader | null> {
    const block = (await this.request("eth_getBlockByNumber", [
      toHex(number),
      false,
    ])) as Record<string, unknown> | null;

    if (!block) {
      return null;
    }

    return {
      number: BigInt(String(block.number)),
      hash: String(block.hash).toLowerCase(),
      parentHash: String(block.parentHash).toLowerCase(),
      // Both validated where they are used: the indexer refuses a flagged
      // block without a valid bloom or a transaction list.
      logsBloom: String(block.logsBloom ?? "").toLowerCase(),
      transactionCount: Array.isArray(block.transactions)
        ? block.transactions.length
        : null,
    };
  }

  async getLogs(query: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    const logs = await this.request("eth_getLogs", [
      {
        address: query.address,
        fromBlock: toHex(query.fromBlock),
        toBlock: toHex(query.toBlock),
      },
    ]);

    // `null` is not "no logs".
    if (!Array.isArray(logs)) {
      throw new RpcError("eth_getLogs returned no log list");
    }

    return (logs as Record<string, unknown>[]).map(parseLog);
  }

  async getBlockReceipts(blockHash: string): Promise<BlockReceipt[] | null> {
    const receipts = await this.request("eth_getBlockReceipts", [blockHash]);

    if (receipts === null) {
      return null;
    }

    if (!Array.isArray(receipts)) {
      throw new RpcError("eth_getBlockReceipts returned no receipt list");
    }

    return (receipts as Record<string, unknown>[]).map((receipt) => ({
      transactionIndex: Number(BigInt(String(receipt.transactionIndex))),
      blockNumber: BigInt(String(receipt.blockNumber)),
      blockHash: String(receipt.blockHash).toLowerCase(),
      logs: (receipt.logs as Record<string, unknown>[]).map(parseLog),
    }));
  }

  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    const receipt = (await this.request("eth_getTransactionReceipt", [
      hash,
    ])) as Record<string, unknown> | null;

    if (!receipt) {
      return null;
    }

    return {
      status: BigInt(String(receipt.status)) === 1n ? "success" : "reverted",
      blockNumber: BigInt(String(receipt.blockNumber)),
      blockHash: String(receipt.blockHash).toLowerCase(),
      logs: (receipt.logs as Record<string, unknown>[]).map(parseLog),
    };
  }

  async call(to: string, data: string, block?: BlockRef): Promise<string> {
    return String(
      await this.request("eth_call", [
        { to, data },
        block === undefined
          ? "latest"
          : typeof block === "bigint"
            ? toHex(block)
            : // The answering node itself must hold the block as canonical,
              // not only know it from a side fork (EIP-1898).
              { blockHash: block.blockHash, requireCanonical: true },
      ]),
    ).toLowerCase();
  }
}
