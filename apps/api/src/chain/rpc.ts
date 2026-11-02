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
}

export interface TransactionReceipt {
  status: "success" | "reverted";
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
   * eth_getLogs of exactly one block, by its hash (EIP-234): the answer is
   * that block's logs whichever node gives it, since a block's logs are fixed
   * by its hash, and a node that does not have the block fails instead of
   * answering for another one. `topics` is the eth_getLogs topic filter
   * (each position: one topic, alternatives, or null for any).
   */
  getBlockLogs(query: {
    blockHash: string;
    address: string;
    topics: readonly (string | readonly string[] | null)[];
  }): Promise<RawLog[]>;
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
  ) {}

  private async request(method: string, params: unknown[]): Promise<unknown> {
    let response: Response;

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
      // Validated where it is used: the indexer reads a malformed or missing
      // bloom as "may hold anything".
      logsBloom: String(block.logsBloom ?? "").toLowerCase(),
    };
  }

  private async logs(filter: Record<string, unknown>): Promise<RawLog[]> {
    const logs = await this.request("eth_getLogs", [filter]);

    // `null` (e.g. for an unknown block hash) is not "no logs".
    if (!Array.isArray(logs)) {
      throw new RpcError("eth_getLogs returned no log list");
    }

    return (logs as Record<string, unknown>[]).map(parseLog);
  }

  async getLogs(query: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    return this.logs({
      address: query.address,
      fromBlock: toHex(query.fromBlock),
      toBlock: toHex(query.toBlock),
    });
  }

  async getBlockLogs(query: {
    blockHash: string;
    address: string;
    topics: readonly (string | readonly string[] | null)[];
  }): Promise<RawLog[]> {
    return this.logs({
      blockHash: query.blockHash,
      address: query.address,
      topics: query.topics,
    });
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
