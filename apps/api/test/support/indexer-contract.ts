import { expect, it } from "vitest";

import { reconcileCampaignEvents } from "../../src/chain/campaign-state.js";
import type { ChainEventRepository } from "../../src/chain/events-repository.js";
import {
  indexOnce,
  ReorgBeyondConfirmationsError,
  type IndexerConfig,
} from "../../src/chain/indexer.js";
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
}
