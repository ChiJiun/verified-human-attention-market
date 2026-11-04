import { toFunctionSelector } from "viem";

import { EVENT_TOPICS, FUNCTION_SELECTORS } from "../../src/chain/abi.js";
import { logsBloom } from "../../src/chain/bloom.js";
import {
  RpcError,
  type BlockHeader,
  type BlockReceipt,
  type BlockRef,
  type ChainRpc,
  type RawLog,
  type TransactionReceipt,
} from "../../src/chain/rpc.js";

export const word = (value: bigint | number) =>
  `0x${BigInt(value).toString(16).padStart(64, "0")}`;

export const addressWord = (address: string) =>
  `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;

/** `CampaignManager.campaigns(uint256)` fields, in the contract's order. */
export interface CampaignStructFields {
  advertiser: string;
  fundedBudget: bigint | number;
  paidRewards: bigint | number;
  rewardPerCompletion: bigint | number;
  maxCompletions: bigint | number;
  paidCompletions: bigint | number;
  startTime: bigint | number;
  endTime: bigint | number;
  closedAt: bigint | number;
  /** CampaignStatus: Draft 0, Active 1, Closed 2. */
  status: bigint | number;
}

/** The eth_call answer of `campaigns(uint256)`: ten 32-byte words. */
export function encodeCampaignStruct(fields: CampaignStructFields): string {
  return `0x${[
    addressWord(fields.advertiser),
    word(fields.fundedBudget),
    word(fields.paidRewards),
    word(fields.rewardPerCompletion),
    word(fields.maxCompletions),
    word(fields.paidCompletions),
    word(fields.startTime),
    word(fields.endTime),
    word(fields.closedAt),
    word(fields.status),
  ]
    .map((value) => value.slice(2))
    .join("")}`;
}

const AUTHORIZED_SIGNER_SELECTOR = toFunctionSelector("authorizedSigner()");
const CLAIMED_WALLET_SELECTOR = toFunctionSelector(
  "claimedWallet(uint256,address)",
);

/** `address` puts the log on another contract than the block's default. */
type LogSpec = { topics: string[]; data: string; address?: string };

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

interface CampaignStruct {
  advertiser: string;
  fundedBudget?: bigint;
  /** Unix seconds; non-zero once closed. */
  closedAt?: number;
  rewardPerCompletion: bigint;
  maxCompletions: number;
  startTime: number;
  endTime: number;
  /** Block that wrote this version (default: always there). */
  since?: bigint;
  /** The version before `since`. */
  previous?: CampaignStruct;
}

interface FakeBlock {
  number: bigint;
  hash: string;
  logs: (LogSpec & { address: string; txHash: string })[];
  /** The bloom of `logs`, as a real node computes it. */
  logsBloom: string;
}

/**
 * In-memory chain with deterministic block hashes, real logs blooms, log
 * batching and controllable failures / reorgs for indexer tests.
 */
export class FakeChain implements ChainRpc {
  private blocks: FakeBlock[] = [];
  private fork = 0;
  private txCounter = 0;
  failGetLogsAfter: number | null = null;
  getLogsCalls = 0;
  /** eth_getBlockReceipts requests. */
  receiptsCalls = 0;
  /** Simulates an unreachable provider for receipts / calls. */
  rpcDown = false;
  /** eth_call requests, counted when sent (also while `rpcDown`). */
  ethCalls = 0;
  readonly revertedTxs = new Set<string>();
  /**
   * On-chain `campaignIdByDraft(advertiser, draftRef)` storage, keyed
   * `${advertiser}:${draftRef}`, with the block that wrote it (eth_call at an
   * earlier block sees nothing; a reorg below it removes it).
   */
  readonly campaignIdByDraft = new Map<string, { id: number; block: bigint }>();
  signer: string | null = null;
  /** On-chain `claimedWallet(id, wallet)`, keyed `${id}:${lowercase wallet}`. */
  readonly claimedWallets = new Set<string>();
  /**
   * On-chain `campaigns(id)` storage returned by eth_call. With `since`, an
   * eth_call at an earlier block sees `previous` (or no campaign).
   */
  readonly campaignStructs = new Map<string, CampaignStruct>();

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
    // Mirror the contract's storage for funding and closing, like the real
    // CampaignManager would (not fork-aware: tests reset it explicitly).
    if (address === this.contract) {
      for (const spec of specs) {
        if ((spec.address ?? address) !== this.contract) continue;
        const struct = spec.topics[1]
          ? this.campaignStructs.get(BigInt(spec.topics[1]).toString())
          : undefined;
        if (!struct) continue;
        if (spec.topics[0] === EVENT_TOPICS.CampaignFunded) {
          struct.fundedBudget = (struct.fundedBudget ?? 0n) + BigInt(spec.data);
        }
        if (spec.topics[0] === EVENT_TOPICS.CampaignClosed) {
          struct.closedAt = this.blocks.length;
        }
      }
    }

    for (let index = 0; index < count; index += 1) {
      const number = this.blocks.length;
      const blockLogs =
        index === 0
          ? specs.map((spec) => ({
              ...spec,
              address: spec.address ?? address,
              txHash: this.txHash(++this.txCounter),
            }))
          : [];
      this.blocks.push({
        number: BigInt(number),
        hash: this.hashFor(number),
        logs: blockLogs,
        logsBloom: logsBloom(blockLogs),
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
        logsBloom: logsBloom([]),
      });
    }
  }

  /**
   * A node that stops following the chain here: the same blocks so far,
   * and it mines the same blocks again only when told to.
   */
  copy(): FakeChain {
    const node = new FakeChain(this.contract, 0);
    node.blocks = this.blocks.map((block) => ({ ...block }));
    node.fork = this.fork;
    node.txCounter = this.txCounter;
    return node;
  }

  /** Replaces a block's header bloom with a wrong or invalid one. */
  setLogsBloom(number: bigint, bloom: string) {
    this.blocks[Number(number)]!.logsBloom = bloom;
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
          logsBloom: block.logsBloom,
          // One transaction per log.
          transactionCount: block.logs.length,
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

  /**
   * eth_getBlockReceipts by hash: one receipt per transaction (here, one
   * per log). Like geth, null for a block this node does not have.
   */
  async getBlockReceipts(blockHash: string): Promise<BlockReceipt[] | null> {
    this.receiptsCalls += 1;
    const block = this.blocks.find((candidate) => candidate.hash === blockHash);

    return block
      ? this.rawLogs(block).map((log, transactionIndex) => ({
          transactionIndex,
          blockNumber: block.number,
          blockHash: block.hash,
          logs: [log],
        }))
      : null;
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

  /**
   * EIP-1898: a node fails for a block hash it does not have (here: one of
   * another fork) instead of answering from its own chain.
   */
  private numberOf(blockHash: string): bigint {
    const block = this.blocks.find((candidate) => candidate.hash === blockHash);
    if (!block) throw new RpcError(`header not found: ${blockHash}`);
    return block.number;
  }

  async call(to: string, data: string, at?: BlockRef): Promise<string> {
    this.ethCalls += 1;
    if (this.rpcDown) {
      throw new RpcError("simulated provider outage");
    }

    const block = typeof at === "object" ? this.numberOf(at.blockHash) : at;

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
      to === this.contract &&
      data === AUTHORIZED_SIGNER_SELECTOR &&
      this.signer !== null
    ) {
      return addressWord(this.signer);
    }

    if (to === this.contract && data.startsWith(CLAIMED_WALLET_SELECTOR)) {
      const id = BigInt(`0x${data.slice(10, 10 + 64)}`).toString();
      const wallet = `0x${data.slice(10 + 64 + 24, 10 + 128)}`;
      return word(this.claimedWallets.has(`${id}:${wallet}`) ? 1 : 0);
    }

    if (
      to !== this.contract ||
      !data.startsWith(FUNCTION_SELECTORS.campaigns)
    ) {
      throw new RpcError("eth_call not simulated");
    }

    const id = BigInt(`0x${data.slice(10)}`).toString();
    let struct = this.campaignStructs.get(id);

    while (
      struct?.since !== undefined &&
      block !== undefined &&
      struct.since > block
    ) {
      struct = struct.previous;
    }

    if (!struct) {
      return `0x${"0".repeat(640)}`;
    }

    return encodeCampaignStruct({
      advertiser: struct.advertiser,
      fundedBudget: struct.fundedBudget ?? 0n,
      paidRewards: 0,
      rewardPerCompletion: struct.rewardPerCompletion,
      maxCompletions: struct.maxCompletions,
      paidCompletions: 0,
      startTime: struct.startTime,
      endTime: struct.endTime,
      closedAt: struct.closedAt ?? 0,
      status: struct.closedAt ? 2 : struct.fundedBudget ? 1 : 0,
    });
  }
}
