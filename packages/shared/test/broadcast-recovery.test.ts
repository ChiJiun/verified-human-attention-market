import { describe, expect, it, vi } from "vitest";

import {
  createCampaignOnce,
  IntentNotSavedError,
  prepareBroadcast,
  resolveCreateBroadcast,
  type BroadcastIntent,
  type BroadcastRecoveryClient,
  type CampaignParameters,
  type IntentStore,
} from "../src/broadcast-recovery.js";

const ADVERTISER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const MANAGER = "0x3333333333333333333333333333333333333333";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

const DRAFT: CampaignParameters = {
  rewardPerCompletion: "1000000",
  maxCompletions: 10,
  startTime: "1800000000",
  endTime: "1800003600",
};
const OTHER_DRAFT: CampaignParameters = { ...DRAFT, maxCompletions: 5 };

interface FakeTx {
  hash: `0x${string}`;
  from: `0x${string}`;
  nonce: number;
  block: bigint;
  /** Set when the transaction created a campaign. */
  campaign?: { id: bigint; parameters: CampaignParameters };
}

function fakeChain(state: {
  mined: FakeTx[];
  pendingNonce: number;
  head: bigint;
}) {
  const logQueries: [bigint, bigint][] = [];
  const blockNumberCacheTimes: number[] = [];
  const client: BroadcastRecoveryClient = {
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
            t.campaign &&
            t.from === args.advertiser &&
            t.block >= fromBlock &&
            t.block <= toBlock,
        )
        .map((t) => ({
          transactionHash: t.hash,
          args: { campaignId: t.campaign!.id },
        }));
    },
    async readContract({ args: [id] }) {
      const p = state.mined.find((t) => t.campaign?.id === id)!.campaign!
        .parameters;
      return [
        ADVERTISER,
        0n,
        0n,
        BigInt(p.rewardPerCompletion),
        p.maxCompletions,
        0,
        BigInt(p.startTime),
        BigInt(p.endTime),
        0n,
        0,
      ] as const;
    },
  };
  return { client, logQueries, blockNumberCacheTimes };
}

function memoryStore(initial: BroadcastIntent | null = null) {
  let value = initial;
  return {
    load: vi.fn(() => value),
    save: vi.fn((intent: BroadcastIntent) => {
      value = intent;
    }),
    clear: vi.fn(() => {
      value = null;
    }),
  } satisfies IntentStore;
}

const intent: BroadcastIntent = {
  from: ADVERTISER,
  nonce: 0,
  fromBlock: "100",
  expected: DRAFT,
};

describe("resolveCreateBroadcast", () => {
  it("finds the lost creation by sender, nonce and parameters", async () => {
    const { client } = fakeChain({
      mined: [
        {
          hash: hash(2),
          from: ADVERTISER,
          nonce: 0,
          block: 101n,
          campaign: { id: 7n, parameters: DRAFT },
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

  it("skips another campaign the same wallet created and picks the matching one", async () => {
    const { client } = fakeChain({
      mined: [
        // Same wallet, at the recorded nonce, but a different campaign.
        {
          hash: hash(3),
          from: ADVERTISER,
          nonce: 0,
          block: 101n,
          campaign: { id: 8n, parameters: OTHER_DRAFT },
        },
        {
          hash: hash(4),
          from: ADVERTISER,
          nonce: 1,
          block: 102n,
          campaign: { id: 9n, parameters: DRAFT },
        },
      ],
      pendingNonce: 2,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({
      kind: "created",
      txHash: hash(4),
      onchainCampaignId: 9n,
    });
  });

  it("is unresolved when only a different campaign exists, never 'safe to send'", async () => {
    const { client } = fakeChain({
      mined: [
        {
          hash: hash(5),
          from: ADVERTISER,
          nonce: 0,
          block: 101n,
          campaign: { id: 10n, parameters: OTHER_DRAFT },
        },
      ],
      pendingNonce: 1,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "unresolved", reason: "not-found" });
  });

  it("is unresolved while the nonce is pending", async () => {
    const { client } = fakeChain({ mined: [], pendingNonce: 1, head: 120n });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "unresolved", reason: "pending" });
  });

  it("is unresolved, not 'not sent', when the node shows nothing", async () => {
    // Another node may still hold the transaction in its mempool.
    const { client } = fakeChain({ mined: [], pendingNonce: 0, head: 120n });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toEqual({ kind: "unresolved", reason: "not-found" });
  });

  it("ignores another sender's campaign with the same parameters", async () => {
    const { client } = fakeChain({
      mined: [
        { hash: hash(6), from: ADVERTISER, nonce: 0, block: 101n },
        {
          hash: hash(7),
          from: OTHER,
          nonce: 0,
          block: 102n,
          campaign: { id: 11n, parameters: DRAFT },
        },
      ],
      pendingNonce: 1,
      head: 120n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toMatchObject({ kind: "unresolved" });
  });

  it("splits the log search into 200-block ranges and never uses a cached block number", async () => {
    const { client, logQueries, blockNumberCacheTimes } = fakeChain({
      mined: [
        {
          hash: hash(8),
          from: ADVERTISER,
          nonce: 0,
          block: 650n,
          campaign: { id: 12n, parameters: DRAFT },
        },
      ],
      pendingNonce: 1,
      head: 700n,
    });

    await expect(
      resolveCreateBroadcast(client, { intent, campaignManager: MANAGER }),
    ).resolves.toMatchObject({ kind: "created", onchainCampaignId: 12n });
    expect(logQueries).toEqual([
      [100n, 299n],
      [300n, 499n],
      [500n, 699n],
    ]);
    expect(blockNumberCacheTimes).toEqual([0]);
  });
});

describe("createCampaignOnce", () => {
  const base = (store: IntentStore, send = vi.fn(async () => hash(99))) => {
    const { client } = fakeChain({ mined: [], pendingNonce: 0, head: 100n });
    return {
      send,
      run: () =>
        createCampaignOnce({
          client,
          store,
          from: ADVERTISER,
          campaignManager: MANAGER,
          expected: DRAFT,
          send,
        }),
    };
  };

  it("saves the intent before sending", async () => {
    const store = memoryStore();
    const { run, send } = base(store);

    await expect(run()).resolves.toEqual({ kind: "sent", txHash: hash(99) });
    expect(store.save).toHaveBeenCalledBefore(send);
    expect(store.load()).toMatchObject({ nonce: 0, expected: DRAFT });
  });

  it("does not send when the intent cannot be saved", async () => {
    const store = memoryStore();
    store.save.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const { run, send } = base(store);

    await expect(run()).rejects.toBeInstanceOf(IntentNotSavedError);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send when the saved intent cannot be read back", async () => {
    const store = memoryStore();
    store.save.mockImplementation(() => undefined); // silently dropped
    const { run, send } = base(store);

    await expect(run()).rejects.toBeInstanceOf(IntentNotSavedError);
    expect(send).not.toHaveBeenCalled();
  });

  it("never sends again while an earlier intent is unresolved", async () => {
    const store = memoryStore(intent);
    const { run, send } = base(store);

    await expect(run()).resolves.toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
    expect(send).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("keeps the intent when sending fails for an unknown reason", async () => {
    const store = memoryStore();
    const { run } = base(
      store,
      vi.fn(async () => {
        throw new Error("timeout after broadcast");
      }),
    );

    await expect(run()).rejects.toThrow("timeout after broadcast");
    expect(store.load()).not.toBeNull();
  });

  it("clears the intent when the wallet rejected the request", async () => {
    const store = memoryStore();
    const rejection = Object.assign(new Error("wrapped"), {
      cause: { code: 4001 },
    });
    const { run } = base(
      store,
      vi.fn(async () => {
        throw rejection;
      }),
    );

    await expect(run()).rejects.toBe(rejection);
    expect(store.load()).toBeNull();
  });

  it("returns the recovered creation instead of sending", async () => {
    const store = memoryStore(intent);
    const { client } = fakeChain({
      mined: [
        {
          hash: hash(10),
          from: ADVERTISER,
          nonce: 0,
          block: 101n,
          campaign: { id: 13n, parameters: DRAFT },
        },
      ],
      pendingNonce: 1,
      head: 120n,
    });
    const send = vi.fn(async () => hash(99));

    await expect(
      createCampaignOnce({
        client,
        store,
        from: ADVERTISER,
        campaignManager: MANAGER,
        expected: DRAFT,
        send,
      }),
    ).resolves.toEqual({
      kind: "recovered",
      txHash: hash(10),
      onchainCampaignId: 13n,
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("prepareBroadcast", () => {
  it("records the next pending nonce, a fresh block number and the draft", async () => {
    const { client, blockNumberCacheTimes } = fakeChain({
      mined: [],
      pendingNonce: 4,
      head: 100n,
    });

    await expect(prepareBroadcast(client, ADVERTISER, DRAFT)).resolves.toEqual({
      from: ADVERTISER,
      nonce: 4,
      fromBlock: "100",
      expected: DRAFT,
    });
    expect(blockNumberCacheTimes).toEqual([0]);
  });
});
