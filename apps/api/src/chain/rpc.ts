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
}

export interface TransactionReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: string;
  logs: RawLog[];
}

export interface ChainRpc {
  blockNumber(): Promise<bigint>;
  getBlock(number: bigint): Promise<BlockHeader | null>;
  getLogs(query: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]>;
  getTransactionReceipt(hash: string): Promise<TransactionReceipt | null>;
  call(to: string, data: string): Promise<string>;
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
    };
  }

  async getLogs(query: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    const logs = (await this.request("eth_getLogs", [
      {
        address: query.address,
        fromBlock: toHex(query.fromBlock),
        toBlock: toHex(query.toBlock),
      },
    ])) as Record<string, unknown>[];

    return logs.map(parseLog);
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

  async call(to: string, data: string): Promise<string> {
    return String(
      await this.request("eth_call", [{ to, data }, "latest"]),
    ).toLowerCase();
  }
}
