import { expect, it } from "vitest";

import { reconcileCampaignEvents } from "../../src/chain/campaign-state.js";
import {
  IndexCursorMovedError,
  type ChainEventRepository,
} from "../../src/chain/events-repository.js";
import {
  InconsistentChainReadError,
  indexOnce,
  ReorgBeyondConfirmationsError,
  type IndexerConfig,
} from "../../src/chain/indexer.js";
import type { ChainRpc } from "../../src/chain/rpc.js";
import { FakeChain, logs } from "./fake-chain.js";

const ADVERTISER = "0x" + "a".repeat(40);
const CLAIMANT = "0x" + "c".repeat(40);
const OTHER_CONTRACT = "0x" + "e".repeat(40);
const USDC = 1_000_000n;

export interface IndexerHarness {
  /** A fresh repository; contract addresses are unique per test. */
  repository: () => ChainEventRepository;
}

let contractCounter = 0;

function setup(harness: IndexerHarness) {
  contractCounter += 1;
  const contract = `0x${contractCounter.toString(16).padStart(40, "0")}`;
  const chain = new FakeChain(contract, 10);
  const config: IndexerConfig = {
    chainId: 31337,
    contractAddress: contract,
    deployBlock: 5n,
    confirmations: 3,
    maxBlockRange: 4n,
  };
  const repository = harness.repository();
  const scope = { chainId: 31337, contractAddress: contract };
  const state = async (campaignId = "1") =>
    reconcileCampaignEvents(
      await repository.listCampaignEvents(scope, campaignId),
    );

  return { chain, config, repository, scope, state };
}

/**
 * Indexer behaviour required by issue #17, run against every
 * ChainEventRepository implementation.
 */
export function defineIndexerContract(harness: IndexerHarness) {
  it("backfills in batches, confirms behind the head and keeps a pending tail", async () => {
    const { chain, config, repository, scope, state } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 10n * USDC)]);
    chain.mine(12);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 1)]);

    const result = await indexOnce(chain, repository, config);

    expect(result.head).toBe(chain.head);
    expect(result.confirmedThrough).toBe(chain.head - 3n);
    expect((await repository.getCursor(scope))?.latestConfirmedBlock).toBe(
      chain.head - 3n,
    );

    const { confirmed, pending, hasUnconfirmedEvents } = await state();
    expect(confirmed).toMatchObject({
      status: "active",
      advertiser: ADVERTISER,
      funded: "10000000",
      paidRewards: "0",
    });
    expect(pending).toMatchObject({
      paidRewards: "1000000",
      paidCompletions: 1,
    });
    expect(hasUnconfirmedEvents).toBe(true);
  });

  it("is idempotent when the same range is processed again", async () => {
    const { chain, config, repository, scope } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 5n * USDC)]);
    chain.mine(10);

    await indexOnce(chain, repository, config);
    await indexOnce(chain, repository, config);
    await indexOnce(chain, repository, config);

    const events = await repository.listCampaignEvents(scope, "1");
    expect(events.map((event) => event.event.name)).toEqual([
      "CampaignCreated",
      "CampaignFunded",
    ]);
  });

  it("resumes after a provider failure without losing or duplicating events", async () => {
    const { chain, config, repository, scope, state } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 10n * USDC)]);
    chain.mine(6);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 1)]);
    chain.mine(10);

    chain.failGetLogsAfter = 1;
    await expect(indexOnce(chain, repository, config)).rejects.toThrow(
      /simulated provider outage/,
    );
    const partial = await repository.getCursor(scope);
    expect(partial?.latestConfirmedBlock).toBe(8n);

    chain.failGetLogsAfter = null;
    await indexOnce(chain, repository, config);

    const { confirmed } = await state();
    expect(confirmed).toMatchObject({
      funded: "10000000",
      paidRewards: "1000000",
      paidCompletions: 1,
      remaining: "9000000",
    });
  });

  it("orphans tail events removed by a shallow reorg and re-confirms re-included ones", async () => {
    const { chain, config, repository, state } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 10n * USDC)]);
    chain.mine(5);
    const claimBlock = chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 7)]);

    await indexOnce(chain, repository, config);
    expect((await state()).pending.paidCompletions).toBe(1);

    // The claim block is replaced; the claim has not been re-included yet.
    chain.reorg(claimBlock, Number(claimBlock) + 1);
    await indexOnce(chain, repository, config);
    expect((await state()).pending.paidCompletions).toBe(0);

    // Re-included two blocks later, then confirmed.
    chain.mine(1);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 8)]);
    chain.mine(5);
    await indexOnce(chain, repository, config);

    const { confirmed, pending } = await state();
    expect(confirmed.paidCompletions).toBe(1);
    expect(pending.paidCompletions).toBe(1);
  });

  it("stops on a reorg deeper than the confirmation depth", async () => {
    const { chain, config, repository, scope } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER)]);
    chain.mine(10);
    await indexOnce(chain, repository, config);
    const cursor = await repository.getCursor(scope);

    chain.reorg(cursor!.latestConfirmedBlock - 1n);
    chain.mine(5);

    await expect(indexOnce(chain, repository, config)).rejects.toBeInstanceOf(
      ReorgBeyondConfirmationsError,
    );
    expect(await repository.getCursor(scope)).toEqual(cursor);
  });

  it("ignores logs from other contracts and malformed logs", async () => {
    const { chain, config, repository, scope } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER)]);
    chain.mine(1, [logs.funded(1, 999n * USDC)], OTHER_CONTRACT);
    chain.mine(1, [{ topics: [logs.funded(1, 1n).topics[0]!], data: "0x" }]);
    chain.mine(10);

    await indexOnce(chain, repository, config);

    const events = await repository.listCampaignEvents(scope, "1");
    expect(events.map((event) => event.event.name)).toEqual([
      "CampaignCreated",
    ]);
  });

  it("derives settled state after close and refund", async () => {
    const { chain, config, repository, state } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 10n * USDC)]);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 1)]);
    chain.mine(1, [logs.closed(1)]);
    chain.mine(1, [logs.refunded(1, 9n * USDC)]);
    chain.mine(10);

    await indexOnce(chain, repository, config);

    expect((await state()).confirmed).toEqual({
      status: "settled",
      advertiser: ADVERTISER,
      funded: "10000000",
      paidRewards: "1000000",
      refunded: "9000000",
      remaining: "0",
      paidCompletions: 1,
      accountingViolation: false,
    });
  });

  it("keeps a reorg halt through resetIndex until it is cleared (ADR-0011)", async () => {
    const { chain, config, repository, scope } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 10n * USDC)]);
    chain.mine(10);
    await indexOnce(chain, repository, config);
    expect(await repository.getHalt(scope)).toBeNull();

    const at = new Date("2026-10-15T00:00:00.000Z");
    await repository.haltForReorg(scope, 12n, at);
    expect(await repository.getHalt(scope)).toEqual({
      block: 12n,
      at,
      recoveryAppliedAt: null,
    });

    // Recovery drops events and cursor, never the halt.
    await repository.resetIndex(scope);
    expect(await repository.getCursor(scope)).toBeNull();
    expect(await repository.listCampaignEvents(scope, "1")).toEqual([]);
    const applied = new Date("2026-10-15T00:05:00.000Z");
    expect(await repository.markRecoveryApplied(scope, applied)).toBe(true);
    expect(await repository.getHalt(scope)).toEqual({
      block: 12n,
      at,
      recoveryAppliedAt: applied,
    });

    // A new deep reorg during recovery starts over: the rebuild that the
    // earlier application allowed can no longer clear it (#77).
    await repository.haltForReorg(scope, 13n, applied);
    expect((await repository.getHalt(scope))?.recoveryAppliedAt).toBeNull();
    const reapplied = new Date("2026-10-15T00:10:00.000Z");
    expect(await repository.markRecoveryApplied(scope, reapplied)).toBe(true);

    // Not before the rebuilt index reaches the verified block.
    const verified = { recoveryAppliedAt: reapplied, indexedThrough: 17n };
    expect(await repository.clearHalt(scope, verified)).toBe(false);

    // Rebuild from the deploy block, then clear the current application.
    await indexOnce(chain, repository, config);
    expect((await repository.getCursor(scope))?.latestConfirmedBlock).toBe(17n);
    expect(
      (await repository.listCampaignEvents(scope, "1")).map(
        (stored) => stored.event.name,
      ),
    ).toEqual(["CampaignCreated", "CampaignFunded"]);
    expect(
      await repository.clearHalt(scope, { ...verified, indexedThrough: 18n }),
    ).toBe(false);
    expect(
      await repository.clearHalt(scope, {
        ...verified,
        recoveryAppliedAt: applied,
      }),
    ).toBe(false);
    expect(await repository.getHalt(scope)).not.toBeNull();
    expect(await repository.clearHalt(scope, verified)).toBe(true);
    expect(await repository.getHalt(scope)).toBeNull();
    expect(await repository.markRecoveryApplied(scope, applied)).toBe(false);
  });

  it("never lets a batch read before an index reset land after it (#77)", async () => {
    const { chain, config, repository, scope } = setup(harness);
    chain.mine(1, [logs.created(1, ADVERTISER), logs.funded(1, 10n * USDC)]);
    chain.mine(4);
    await indexOnce(chain, repository, config);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 1)]);
    chain.mine(10);

    // `reorg:recover --apply` resets the index between two batches of a pass.
    const readLogs = chain.getLogs.bind(chain);
    let calls = 0;
    chain.getLogs = async (query) => {
      const result = await readLogs(query);
      calls += 1;
      if (calls === 2) await repository.resetIndex(scope);
      return result;
    };

    await expect(indexOnce(chain, repository, config)).rejects.toBeInstanceOf(
      IndexCursorMovedError,
    );
    // The batch did not land: no cursor past a gap, no stray events.
    expect(await repository.getCursor(scope)).toBeNull();
    expect(await repository.listCampaignEvents(scope, "1")).toEqual([]);

    // A writer that read the old cursor cannot write the tail either.
    await expect(
      repository.replaceObservedTail(
        scope,
        { from: chain.head, to: chain.head, expectedCursor: 11n },
        [],
      ),
    ).rejects.toBeInstanceOf(IndexCursorMovedError);

    // The next pass rebuilds from the deploy block.
    chain.getLogs = readLogs;
    await indexOnce(chain, repository, config);
    expect(
      (await repository.listCampaignEvents(scope, "1")).map(
        (stored) => stored.event.name,
      ),
    ).toEqual(["CampaignCreated", "CampaignFunded", "RewardClaimed"]);
  });

  it("lets one process at a time hold a deployment (#77)", async () => {
    const { repository, scope } = setup(harness);
    const other = { ...scope, contractAddress: OTHER_CONTRACT };
    expect(await repository.isDeploymentLocked(scope)).toBe(false);

    const worker = await repository.lockDeployment(scope);
    expect(worker).not.toBeNull();
    expect(await worker!.isHeld()).toBe(true);
    expect(await repository.isDeploymentLocked(scope)).toBe(true);
    expect(await repository.lockDeployment(scope)).toBeNull();
    // Looking does not take it.
    expect(await worker!.isHeld()).toBe(true);

    expect(await repository.isDeploymentLocked(other)).toBe(false);
    const elsewhere = await repository.lockDeployment(other);
    expect(elsewhere).not.toBeNull();
    await elsewhere!.release();

    await worker!.release();
    await worker!.release();
    expect(await worker!.isHeld()).toBe(false);
    expect(await repository.isDeploymentLocked(scope)).toBe(false);
    const recovery = await repository.lockDeployment(scope);
    expect(recovery).not.toBeNull();
    await recovery!.release();
  });

  it("never commits logs read across a reorg (ADR-0011)", async () => {
    const { chain, config, repository, scope } = setup(harness);
    const creationBlock = chain.mine(1, [logs.created(1, ADVERTISER)]);
    chain.mine(10);

    // The chain reorganizes right after the logs of the range holding the
    // creation are read, before the range end's hash is read.
    const readLogs = chain.getLogs.bind(chain);
    let reorged = false;
    chain.getLogs = async (query) => {
      const result = await readLogs(query);
      if (
        !reorged &&
        query.fromBlock <= creationBlock &&
        query.toBlock >= creationBlock
      ) {
        reorged = true;
        chain.reorg(creationBlock);
      }
      return result;
    };

    await expect(indexOnce(chain, repository, config)).rejects.toBeInstanceOf(
      InconsistentChainReadError,
    );
    expect(await repository.listCampaignEvents(scope, "1")).toEqual([]);

    // The next pass reads the new fork consistently: no creation there.
    await indexOnce(chain, repository, config);
    expect(await repository.listCampaignEvents(scope, "1")).toEqual([]);
  });

  /** Indexes a creation, then mines `more` blocks for the next pass. */
  async function indexedWithMoreBlocks(
    fixture: ReturnType<typeof setup>,
    more: number,
  ) {
    const { chain, config, repository, scope } = fixture;
    chain.mine(1, [logs.created(1, ADVERTISER)]);
    chain.mine(10);
    await indexOnce(chain, repository, config);
    chain.mine(more);
    return (await repository.getCursor(scope))!;
  }

  /** Runs `act` once, just before the first getBlock call `when` accepts. */
  function onGetBlock(
    chain: FakeChain,
    when: (number: bigint, call: number) => boolean,
    act: () => void,
  ) {
    const getBlock = chain.getBlock.bind(chain);
    let calls = 0;
    let done = false;
    chain.getBlock = async (number) => {
      calls += 1;
      if (!done && when(number, calls)) {
        done = true;
        act();
      }
      return getBlock(number);
    };
  }

  const reorgError = async (pass: Promise<unknown>) => {
    const error = await pass.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReorgBeyondConfirmationsError);
    return (error as ReorgBeyondConfirmationsError).blockNumber;
  };

  it("halts on a deeper reorg between the cursor check and the first batch (issue #76)", async () => {
    const fixture = setup(harness);
    const { chain, config, repository, scope } = fixture;
    const cursor = await indexedWithMoreBlocks(fixture, 6);

    // The pass has just checked the cursor's hash when the reorg lands.
    onGetBlock(
      chain,
      (_number, call) => call === 2,
      () => chain.reorg(cursor.latestConfirmedBlock - 1n),
    );

    expect(await reorgError(indexOnce(chain, repository, config))).toBe(
      cursor.latestConfirmedBlock,
    );
    expect(await repository.getCursor(scope)).toEqual(cursor);
  });

  it("halts on a deeper reorg between two batches of a pass (issue #76)", async () => {
    const fixture = setup(harness);
    const { chain, config, repository, scope } = fixture;
    const cursor = await indexedWithMoreBlocks(fixture, 12);
    const firstBatchEnd = cursor.latestConfirmedBlock + config.maxBlockRange;

    // The first batch is committed, then a reorg replaces its last blocks.
    onGetBlock(
      chain,
      (number) => number > firstBatchEnd,
      () => chain.reorg(firstBatchEnd - 1n),
    );

    expect(await reorgError(indexOnce(chain, repository, config))).toBe(
      firstBatchEnd,
    );
    expect((await repository.getCursor(scope))?.latestConfirmedBlock).toBe(
      firstBatchEnd,
    );
  });

  it("retries, without a halt, a batch whose first block came from another fork (issue #76)", async () => {
    const fixture = setup(harness);
    const { chain, config, repository, scope } = fixture;
    const cursor = await indexedWithMoreBlocks(fixture, 6);
    const from = cursor.latestConfirmedBlock + 1n;

    // A load-balanced node answers the batch's first header from another
    // fork; the committed block itself is unchanged.
    const getBlock = chain.getBlock.bind(chain);
    let forged = false;
    chain.getBlock = async (number) => {
      const header = await getBlock(number);
      if (!forged && number === from && header) {
        forged = true;
        return { ...header, parentHash: "0x" + "ee".repeat(32) };
      }
      return header;
    };

    await expect(indexOnce(chain, repository, config)).rejects.toBeInstanceOf(
      InconsistentChainReadError,
    );
    expect(await repository.getCursor(scope)).toEqual(cursor);
    expect((await indexOnce(chain, repository, config)).confirmedThrough).toBe(
      chain.head - 3n,
    );
  });

  it("retries, without a halt, when a lagging node lacks the committed block", async () => {
    const fixture = setup(harness);
    const { chain, config, repository, scope } = fixture;
    const cursor = await indexedWithMoreBlocks(fixture, 6);
    const getBlock = chain.getBlock.bind(chain);
    let lagging = true;
    chain.getBlock = async (number) =>
      lagging && number === cursor.latestConfirmedBlock
        ? null
        : getBlock(number);

    await expect(indexOnce(chain, repository, config)).rejects.toBeInstanceOf(
      InconsistentChainReadError,
    );
    expect(await repository.getCursor(scope)).toEqual(cursor);

    lagging = false;
    expect((await indexOnce(chain, repository, config)).confirmedThrough).toBe(
      chain.head - 3n,
    );
  });

  /**
   * A load-balanced RPC: header reads `staleAt` and, with `staleLogs`, the
   * logs come from a node still on another fork; the rest is canonical.
   */
  function balanced(
    canonical: FakeChain,
    stale: FakeChain,
    staleAt: (number: bigint) => boolean,
    staleLogs = false,
  ): ChainRpc {
    return {
      blockNumber: () => canonical.blockNumber(),
      getBlock: (number) =>
        (staleAt(number) ? stale : canonical).getBlock(number),
      getLogs: (query) => (staleLogs ? stale : canonical).getLogs(query),
      getTransactionReceipt: (hash) => canonical.getTransactionReceipt(hash),
      call: (to, data, block) => canonical.call(to, data, block),
    };
  }

  it("never commits a range whose headers came from two forks (issue #76)", async () => {
    const fixture = setup(harness);
    const { chain, config, repository, scope } = fixture;
    // A node that missed the reorg below keeps the old fork.
    const stale = new FakeChain(chain.contract, 10);
    for (const node of [chain, stale]) {
      node.mine(1, [logs.created(1, ADVERTISER)]);
      node.mine(10);
    }
    await indexOnce(chain, repository, config);
    const cursor = (await repository.getCursor(scope))!;

    // The canonical chain replaces the committed block; the stale node does
    // not. It answers the cursor check and the batch's first header, so the
    // first block's parent is still the committed block.
    chain.reorg(cursor.latestConfirmedBlock - 1n);
    chain.mine(6);
    stale.mine(6);
    const mixed = balanced(
      chain,
      stale,
      (number) => number <= cursor.latestConfirmedBlock + 1n,
    );

    await expect(indexOnce(mixed, repository, config)).rejects.toBeInstanceOf(
      InconsistentChainReadError,
    );
    expect(await repository.getCursor(scope)).toEqual(cursor);

    // Read consistently, the replaced block is a halt.
    expect(await reorgError(indexOnce(chain, repository, config))).toBe(
      cursor.latestConfirmedBlock,
    );
  });

  it("never commits logs from another fork inside a range (issue #76)", async () => {
    const fixture = setup(harness);
    const { chain, config, repository, scope, state } = fixture;
    const stale = new FakeChain(chain.contract, 10);
    chain.mine(1, [logs.created(1, ADVERTISER)]);
    stale.mine(1, [logs.created(1, ADVERTISER)]);
    const fork = chain.head + 1n;

    // From here the chains differ: the stale node's fork funds the campaign.
    chain.reorg(fork);
    chain.mine(3);
    await indexOnce(chain, repository, config);
    const cursor = (await repository.getCursor(scope))!;
    expect(cursor.latestConfirmedBlock).toBe(fork - 1n);
    chain.mine(5);
    stale.mine(1, [logs.funded(1, 10n * USDC)]);
    stale.mine(7);

    // Its logs, and the header of the block holding them, come from the
    // stale node; the range end is canonical.
    const mixed = balanced(chain, stale, (number) => number === fork, true);

    await expect(indexOnce(mixed, repository, config)).rejects.toBeInstanceOf(
      InconsistentChainReadError,
    );
    expect(await repository.getCursor(scope)).toEqual(cursor);
    expect((await state()).confirmed.funded).toBe("0");

    // The canonical chain alone: no funding was ever confirmed.
    await indexOnce(chain, repository, config);
    expect((await state()).confirmed.funded).toBe("0");
  });
}
