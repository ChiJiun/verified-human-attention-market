import { describe, expect, it } from "vitest";

import {
  prepareBroadcast,
  resolveCreateBroadcast,
  type BroadcastRecoveryClient,
} from "../src/broadcast-recovery.js";

const ADVERTISER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const MANAGER = "0x3333333333333333333333333333333333333333";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

interface FakeTx {
  hash: `0x${string}`;
  from: `0x${string}`;
  nonce: number;
  block: bigint;
  campaignId?: bigint;
}

function fakeChain(state: {
  mined: FakeTx[];
  pendingNonce: number;
  head: bigint;
}): BroadcastRecoveryClient & {
  logQueries: [bigint, bigint][];
  blockNumberCacheTimes: number[];
} {
  const logQueries: [bigint, bigint][] = [];
  const blockNumberCacheTimes: number[] = [];
  return {
    logQueries,
    blockNumberCacheTimes,
    async getTransactionCount({ blockTag }) {
      const minedCount = state.mined.filter(
        (t) => t.from === ADVERTISER,
      ).length;
      return blockTag === "latest" ? minedCount : state.pendingNonce;
    },
    async getBlockNumber({ cacheTime }) {
      blockNumberCacheTimes.push(cacheTime);
      return state.head;
    },
    async getTransaction({ hash: h }) {
      const tx = state.mined.find((t) => t.hash === h)!;
      return { from: tx.from, nonce: tx.nonce };
    },
    async getContractEvents({ args, fromBlock, toBlock }) {
      logQueries.push([fromBlock, toBlock]);
      return state.mined
        .filter(
          (t) =>
            t.campaignId !== undefined &&
            t.from === args.advertiser &&
            t.block >= fromBlock &&
            t.block <= toBlock,
        )
        .map((t) => ({
          transactionHash: t.hash,
          args: { campaignId: t.campaignId },
        }));
    },
  };
}

describe("createCampaign broadcast recovery", () => {
  it("records the next pending nonce and the current block", async () => {
    const client = fakeChain({ mined: [], pendingNonce: 4, head: 100n });

    await expect(prepareBroadcast(client, ADVERTISER)).resolves.toEqual({
      from: ADVERTISER,
      nonce: 4,
      fromBlock: "100",
    });
  });

  it("never reads a cached block number (viem caches it for seconds)", async () => {
    const client = fakeChain({
      mined: [{ hash: hash(9), from: ADVERTISER, nonce: 0, block: 101n }],
      pendingNonce: 1,
      head: 120n,
    });

    await prepareBroadcast(client, ADVERTISER);
    await resolveCreateBroadcast(client, {
      intent: { from: ADVERTISER, nonce: 0, fromBlock: "100" },
      campaignManager: MANAGER,
    });
    expect(client.blockNumberCacheTimes).toEqual([0, 0]);
  });

  const intent = { from: ADVERTISER, nonce: 0, fromBlock: "100" } as const;

  it("finds the campaign created by the lost broadcast, so it is not resent", async () => {
    const client = fakeChain({
      mined: [
        {
          hash: hash(2),
          from: ADVERTISER,
          nonce: 0,
          block: 101n,
          campaignId: 7n,
        },
      ],
      pendingNonce: 1,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({
      kind: "created",
      txHash: hash(2),
      onchainCampaignId: 7n,
    });
  });

  it("reports not-sent when the nonce never reached the node", async () => {
    const client = fakeChain({ mined: [], pendingNonce: 0, head: 120n });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "not-sent" });
  });

  it("waits while the nonce is still pending", async () => {
    const client = fakeChain({ mined: [], pendingNonce: 1, head: 120n });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "pending" });
  });

  it("finds the campaign when the wallet used a later nonce than recorded", async () => {
    const client = fakeChain({
      mined: [
        // Another dapp's transaction took nonce 0 first...
        { hash: hash(6), from: ADVERTISER, nonce: 0, block: 101n },
        // ...so the wallet sent the create with nonce 1.
        {
          hash: hash(7),
          from: ADVERTISER,
          nonce: 1,
          block: 103n,
          campaignId: 11n,
        },
      ],
      pendingNonce: 2,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({
      kind: "created",
      txHash: hash(7),
      onchainCampaignId: 11n,
    });
  });

  it("waits, rather than resending, while any later transaction is still queued", async () => {
    const client = fakeChain({
      mined: [{ hash: hash(8), from: ADVERTISER, nonce: 0, block: 101n }],
      // Nonce 1 (possibly the create) is still in the mempool.
      pendingNonce: 2,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "pending" });
  });

  it("ignores another sender's campaign and reports the nonce as used elsewhere", async () => {
    const client = fakeChain({
      mined: [
        // The advertiser's nonce 0 was a plain transfer...
        { hash: hash(3), from: ADVERTISER, nonce: 0, block: 101n },
        // ...and someone else created a campaign meanwhile.
        { hash: hash(4), from: OTHER, nonce: 0, block: 102n, campaignId: 8n },
      ],
      pendingNonce: 1,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "nonce-used-elsewhere" });
  });

  it("splits the log search into ranges a public RPC accepts", async () => {
    const client = fakeChain({
      mined: [
        {
          hash: hash(5),
          from: ADVERTISER,
          nonce: 0,
          block: 650n,
          campaignId: 9n,
        },
      ],
      pendingNonce: 1,
      head: 700n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toMatchObject({ kind: "created", onchainCampaignId: 9n });
    expect(client.logQueries).toEqual([
      [100n, 299n],
      [300n, 499n],
      [500n, 699n],
    ]);
    expect(
      client.logQueries.every(([from, to]) => to - from + 1n <= 200n),
    ).toBe(true);
  });
});
