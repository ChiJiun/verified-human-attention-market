import { EVENT_TOPICS, FUNCTION_SELECTORS } from "../../src/chain/abi.js";
import {
  RpcError,
  type BlockHeader,
  type ChainRpc,
  type RawLog,
  type TransactionReceipt,
} from "../../src/chain/rpc.js";

export const word = (value: bigint | number) =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}`;

export const addressWord = (address: string) =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

type LogSpec = { topics: string[]; data: string };

export const logs = {
  /** `draftRef` defaults to a non-zero placeholder (ADR-0011). */
  created: (
    campaignId: number,
    advertiser: string,
    draftRef: string = word(0xd0000 + campaignId),
  ): LogSpec => ({
    topics: [
      EVENT_TOPICS.CampaignCreated,
      word(campaignId),
      addressWord(advertiser),
      draftRef,
    ],
    data: "0x",
  }),
  funded: (campaignId: number, amount: bigint): LogSpec => ({
    topics: [EVENT_TOPICS.CampaignFunded, word(campaignId)],
    data: word(amount),
  }),
  claimed: (
    campaignId: number,
    claimant: string,
    amount: bigint,
    nonce: number,
  ): LogSpec => ({
    topics: [
      EVENT_TOPICS.RewardClaimed,
      word(campaignId),
      addressWord(claimant),
    ],
    data: `${word(amount)}${word(nonce).slice(2)}`,
  }),
  closed: (campaignId: number): LogSpec => ({
    topics: [EVENT_TOPICS.CampaignClosed, word(campaignId)],
    data: "0x",
  }),
  refunded: (campaignId: number, amount: bigint): LogSpec => ({
    topics: [EVENT_TOPICS.CampaignRefunded, word(campaignId)],
    data: word(amount),
  }),
};

interface FakeBlock {
  number: bigint;
  hash: string;
  logs: (LogSpec & { address: string; txHash: string })[];
}

/**
 * In-memory chain with deterministic block hashes, log batching and
 * controllable failures / reorgs for indexer tests.
 */
export class FakeChain implements ChainRpc {
  private blocks: FakeBlock[] = [];
  private fork = 0;
  private txCounter = 0;
  failGetLogsAfter: number | null = null;
  getLogsCalls = 0;
  /** Simulates an unreachable provider for receipts / calls. */
  rpcDown = false;
  readonly revertedTxs = new Set<string>();
  /**
   * On-chain `campaignIdByDraft(advertiser, draftRef)` storage, keyed
   * `${advertiser}:${draftRef}`, with the block that wrote it (eth_call at an
   * earlier block sees nothing; a reorg below it removes it).
   */
  readonly campaignIdByDraft = new Map<string, { id: number; block: bigint }>();
  /** On-chain `campaigns(id)` storage returned by eth_call. */
  readonly campaignStructs = new Map<
    string,
    {
      advertiser: string;
      fundedBudget?: bigint;
      rewardPerCompletion: bigint;
      maxCompletions: number;
      startTime: number;
      endTime: number;
    }
  >();

  constructor(
    readonly contract: string,
    genesisBlocks = 1,
  ) {
    this.mine(genesisBlocks);
  }

  /** Unique per contract, like real transaction hashes across tests. */
  private txHash(counter: number): string {
    return `0x${this.contract.slice(2).toLowerCase()}${counter
      .toString(16)
      .padStart(24, "0")}`;
  }

  /** Hash of the most recently created transaction. */
  get lastTxHash(): string {
    return this.txHash(this.txCounter);
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  private hashFor(number: number) {
    return `0x${this.fork.toString(16).padStart(8, "0")}${number
      .toString(16)
      .padStart(56, "0")}`;
  }

  /** Mines `count` blocks; `specs` go into the first new block. */
  mine(count = 1, specs: LogSpec[] = [], address = this.contract): bigint {
    for (let index = 0; index < count; index += 1) {
      const number = this.blocks.length;
      this.blocks.push({
        number: BigInt(number),
        hash: this.hashFor(number),
        logs:
          index === 0
            ? specs.map((spec) => ({
                ...spec,
                address,
                txHash: this.txHash(++this.txCounter),
              }))
            : [],
      });
    }

    return this.head;
  }

  /** Replaces all blocks from `fromBlock` with empty blocks on a new fork. */
  reorg(fromBlock: bigint, newLength = this.blocks.length) {
    this.fork += 1;
    this.blocks = this.blocks.slice(0, Number(fromBlock));
    for (const [key, entry] of this.campaignIdByDraft) {
      if (entry.block >= fromBlock) this.campaignIdByDraft.delete(key);
    }
    while (this.blocks.length < newLength) {
      const number = this.blocks.length;
      this.blocks.push({
        number: BigInt(number),
        hash: this.hashFor(number),
        logs: [],
      });
    }
  }

  async blockNumber(): Promise<bigint> {
    return this.head;
  }

  async getBlock(number: bigint): Promise<BlockHeader | null> {
    const block = this.blocks[Number(number)];
    return block
      ? {
          number: block.number,
          hash: block.hash,
          parentHash: this.blocks[Number(number) - 1]?.hash ?? word(0),
        }
      : null;
  }

  private rawLogs(block: FakeBlock): RawLog[] {
    return block.logs.map((log, logIndex) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      blockNumber: block.number,
      blockHash: block.hash,
      transactionHash: log.txHash,
      logIndex,
      removed: false,
    }));
  }

  async getLogs(query: {
    address: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]> {
    this.getLogsCalls += 1;

    if (
      this.failGetLogsAfter !== null &&
      this.getLogsCalls > this.failGetLogsAfter
    ) {
      throw new RpcError("simulated provider outage");
    }

    return this.blocks
      .filter(
        (block) =>
          block.number >= query.fromBlock && block.number <= query.toBlock,
      )
      .flatMap((block) => this.rawLogs(block))
      .filter((log) => log.address === query.address.toLowerCase());
  }

  async getTransactionReceipt(
    hash: string,
  ): Promise<TransactionReceipt | null> {
    if (this.rpcDown) {
      throw new RpcError("simulated provider outage");
    }

    if (this.revertedTxs.has(hash)) {
      const block = this.blocks[this.blocks.length - 1]!;
      return {
        status: "reverted",
        blockNumber: block.number,
        blockHash: block.hash,
        logs: [],
      };
    }

    for (const block of this.blocks) {
      const logsInTx = this.rawLogs(block).filter(
        (log) => log.transactionHash === hash,
      );
      if (logsInTx.length > 0) {
        return {
          status: "success",
          blockNumber: block.number,
          blockHash: block.hash,
          logs: logsInTx,
        };
      }
    }
    return null;
  }

  async call(to: string, data: string, block?: bigint): Promise<string> {
    if (this.rpcDown) {
      throw new RpcError("simulated provider outage");
    }

    if (
      to === this.contract &&
      data.startsWith(FUNCTION_SELECTORS.campaignIdByDraft)
    ) {
      const advertiser = `0x${data.slice(10 + 24, 10 + 64)}`;
      const draftRef = `0x${data.slice(10 + 64, 10 + 128)}`;
      const entry = this.campaignIdByDraft.get(`${advertiser}:${draftRef}`);
      return word(
        entry && (block === undefined || entry.block <= block) ? entry.id : 0,
      );
    }

    if (
      to !== this.contract ||
      !data.startsWith(FUNCTION_SELECTORS.campaigns)
    ) {
      throw new RpcError("eth_call not simulated");
    }

    const id = BigInt(`0x${data.slice(10)}`).toString();
    const struct = this.campaignStructs.get(id);

    if (!struct) {
      return `0x${"0".repeat(640)}`;
    }

    return [
      addressWord(struct.advertiser),
      word(struct.fundedBudget ?? 0n),
      word(0),
      word(struct.rewardPerCompletion),
      word(struct.maxCompletions),
      word(0),
      word(struct.startTime),
      word(struct.endTime),
      word(0),
      word(0),
    ]
      .map((value, index) => (index === 0 ? value : value.slice(2)))
      .join("");
  }
}
