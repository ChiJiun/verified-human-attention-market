import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASSUME_DROPPED_AFTER_MS,
  cardFlipsToDone,
  observeSettlementTx,
  pollSettlementTx,
  resolveTxOutcome,
  settlementButton,
  settlementEffectVisible,
  unresolvedTxCheck,
  type SettlementAction,
  type SettlementTxObservation,
  type SettlementTxOutcome,
} from "../lib/settlement";

const HASH = `0x${"ab".repeat(32)}` as Hash;
const ADVERTISER = `0x${"aa".repeat(20)}` as const;
const CHAIN_ID = 84532;

const pending: SettlementTxObservation = {
  receipt: null,
  known: true,
  txNonce: 7,
  minedNonce: 7,
};

describe("settlement effect", () => {
  it.each([
    ["close", "closed", true],
    ["close", "settled", true],
    ["close", "active", false],
    ["refund", "settled", true],
    ["refund", "closed", false],
    ["refund", null, false],
  ] as const)("%s shows in status %s: %s", (action, status, visible) => {
    expect(settlementEffectVisible(action, status)).toBe(visible);
  });
});

describe("close and refund buttons", () => {
  const available = { kind: "available" };
  const idle = {
    awaitingEffect: null,
    maybeDropped: null,
    blocked: false,
  } as const;

  it("stay in place, disabled, while another action runs", () => {
    expect(
      settlementButton("close", available, { ...idle, blocked: true }),
    ).toEqual({ kind: "send", disabled: true });
    expect(
      settlementButton("refund", available, {
        ...idle,
        awaitingEffect: "close",
        blocked: true,
      }),
    ).toEqual({ kind: "send", disabled: true });
    expect(settlementButton("close", available, idle)).toEqual({
      kind: "send",
      disabled: false,
    });
  });

  it("are hidden only while not offered or awaiting their own effect", () => {
    expect(
      settlementButton("close", available, {
        ...idle,
        awaitingEffect: "close",
      }),
    ).toEqual({ kind: "hidden" });
    expect(settlementButton("refund", { kind: "waiting" }, idle)).toEqual({
      kind: "hidden",
    });
    expect(settlementButton("close", null, { ...idle, blocked: true })).toEqual(
      { kind: "hidden" },
    );
  });

  it("offer only the warned 'anyway' send for a transaction never seen", () => {
    const waiting = {
      ...idle,
      awaitingEffect: "close",
      maybeDropped: "close",
    } as const;

    expect(settlementButton("close", available, waiting)).toEqual({
      kind: "send-anyway",
      disabled: false,
    });
    // The chain no longer offers it (the first one landed): nothing.
    expect(settlementButton("close", { kind: "unavailable" }, waiting)).toEqual(
      { kind: "hidden" },
    );
  });
});

describe("resolving an unknown close or refund outcome", () => {
  /**
   * As the page's check does it: the effect is whether the stored status read
   * after the observation shows the action (settlementEffectVisible), and a
   * failed read (`storedStatus: null`) is unknown, never "no effect".
   */
  const resolve = (
    observation: SettlementTxObservation,
    {
      action = "close" as SettlementAction,
      storedStatus = "active" as string | null,
      elapsedMs = 0,
    } = {},
  ) =>
    resolveTxOutcome({
      effect:
        storedStatus === null
          ? null
          : settlementEffectVisible(action, storedStatus),
      observation,
      elapsedMs,
    });

  it("is done when the receipt arrives after the wait timed out", () => {
    expect(resolve(pending)).toBe("pending");
    expect(resolve({ ...pending, receipt: "success" })).toBe("done");
  });

  it("is done once the chain shows the effect, whichever transaction caused it", () => {
    // Sped up in the wallet: the replacement closed it, this hash never mines.
    expect(
      resolve({ ...pending, minedNonce: 8 }, { storedStatus: "closed" }),
    ).toBe("done");
    expect(
      resolve(pending, { action: "refund", storedStatus: "settled" }),
    ).toBe("done");
    expect(resolve(pending, { action: "refund", storedStatus: "closed" })).toBe(
      "pending",
    );
  });

  it("reports a reverted receipt", () => {
    expect(resolve({ ...pending, receipt: "reverted" })).toBe("reverted");
  });

  it("reports a transaction whose nonce another one used", () => {
    expect(resolve({ ...pending, minedNonce: 8 })).toBe("replaced");
    expect(resolve({ ...pending, txNonce: null, minedNonce: 8 })).toBe(
      "pending",
    );
  });

  it("never calls the campaign unchanged without reading it", () => {
    // The replacement may have closed it; the read failed, so wait.
    expect(resolve({ ...pending, minedNonce: 8 }, { storedStatus: null })).toBe(
      "pending",
    );
    expect(
      resolve(
        { receipt: null, known: false, txNonce: null, minedNonce: null },
        { storedStatus: null, elapsedMs: ASSUME_DROPPED_AFTER_MS },
      ),
    ).toBe("pending");
  });

  it("takes a hash never seen as dropped only after a while", () => {
    const unknown = {
      receipt: null,
      known: false,
      txNonce: null,
      minedNonce: null,
    };

    expect(resolve(unknown, { elapsedMs: ASSUME_DROPPED_AFTER_MS - 1 })).toBe(
      "pending",
    );
    expect(resolve(unknown, { elapsedMs: ASSUME_DROPPED_AFTER_MS })).toBe(
      "dropped",
    );
    // An RPC that cannot answer proves nothing.
    expect(
      resolve(
        { ...unknown, known: null },
        { elapsedMs: 10 * ASSUME_DROPPED_AFTER_MS },
      ),
    ).toBe("pending");
  });

  it("keeps a transaction seen with nonce N pending while that slot is empty", () => {
    // Seen once with nonce 7, now unknown to the node, nonce 7 still unused:
    // it can still land, so only another transaction at 7 concludes it.
    expect(
      resolve(
        { receipt: null, known: false, txNonce: 7, minedNonce: 7 },
        { elapsedMs: ASSUME_DROPPED_AFTER_MS },
      ),
    ).toBe("pending");
    expect(
      resolve(
        { receipt: null, known: false, txNonce: 7, minedNonce: null },
        { elapsedMs: 10 * ASSUME_DROPPED_AFTER_MS },
      ),
    ).toBe("pending");
    expect(
      resolve(
        { receipt: null, known: false, txNonce: 7, minedNonce: 8 },
        { elapsedMs: ASSUME_DROPPED_AFTER_MS },
      ),
    ).toBe("replaced");
  });
});

describe("polling an unknown outcome", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs `checks` in order, one per interval, reporting each verdict. */
  async function poll(checks: (SettlementTxOutcome | Error)[]) {
    const queue = [...checks];
    const verdicts: SettlementTxOutcome[] = [];
    let calls = 0;
    const stop = pollSettlementTx(
      async () => {
        calls += 1;
        const next = queue.shift() ?? "pending";
        if (next instanceof Error) throw next;
        return next;
      },
      (outcome) => verdicts.push(outcome),
      1_000,
    );
    for (let tick = 0; tick < checks.length + 2; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
    }
    stop();
    return { verdicts, calls: () => calls };
  }

  it("needs two agreeing checks, so one lagging backend decides nothing", async () => {
    // A successful close read once as "nonce used, no receipt, still active".
    const { verdicts } = await poll(["replaced", "pending", "done", "done"]);

    expect(verdicts).toEqual(["done"]);
  });

  it("settles on two agreeing checks and then stops", async () => {
    const { verdicts, calls } = await poll(["pending", "replaced", "replaced"]);

    expect(verdicts).toEqual(["replaced"]);
    const after = calls();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls()).toBe(after);
  });

  it("a failed check breaks the streak", async () => {
    const { verdicts } = await poll([
      "reverted",
      new Error("rpc down"),
      "reverted",
    ]);

    expect(verdicts).toEqual([]);
  });

  it("reports 'dropped' without stopping, and its withdrawal", async () => {
    const { verdicts } = await poll([
      "dropped",
      "dropped",
      "pending",
      "pending",
      "done",
      "done",
    ]);

    expect(verdicts).toEqual(["dropped", "pending", "done"]);
  });

  it("never overlaps a slow check with the next one", async () => {
    let running = 0;
    let overlapped = false;
    const stop = pollSettlementTx(
      async () => {
        running += 1;
        overlapped ||= running > 1;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        running -= 1;
        return "pending";
      },
      () => {},
      1_000,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    stop();

    expect(overlapped).toBe(false);
  });
});

describe("a card after the effect shows on-chain", () => {
  it("turns done when it still shows that transaction waiting or failed", () => {
    expect(cardFlipsToDone({ state: "reconciling", hash: HASH }, HASH)).toBe(
      true,
    );
    // Failed on one backend's "replaced", then the chain shows it closed.
    expect(cardFlipsToDone({ state: "failed", hash: HASH }, HASH)).toBe(true);
  });

  it("leaves another transaction's card or a finished one alone", () => {
    const other = `0x${"cd".repeat(32)}` as Hash;

    expect(cardFlipsToDone({ state: "failed", hash: other }, HASH)).toBe(false);
    expect(cardFlipsToDone({ state: "failed" }, HASH)).toBe(false);
    expect(cardFlipsToDone({ state: "done", hash: HASH }, HASH)).toBe(false);
    expect(cardFlipsToDone({ state: "pending", hash: HASH }, HASH)).toBe(false);
  });
});

/** A wallet whose node answers from `node`, recording the call order. */
function walletWith(node: {
  chainId?: number;
  transaction?: () => Promise<{ nonce: number }>;
  minedNonce?: () => Promise<number>;
  receipt?: () => Promise<{ status: "success" | "reverted" }>;
}) {
  const calls: string[] = [];
  const publicClient = {
    getChainId: async () => node.chainId ?? CHAIN_ID,
    getTransaction: () => {
      calls.push("getTransaction");
      return (
        node.transaction?.() ??
        Promise.reject(new TransactionNotFoundError({ hash: HASH }))
      );
    },
    getTransactionCount: () => {
      calls.push("getTransactionCount");
      return node.minedNonce?.() ?? Promise.resolve(0);
    },
    getTransactionReceipt: () => {
      calls.push("getTransactionReceipt");
      return (
        node.receipt?.() ??
        Promise.reject(new TransactionReceiptNotFoundError({ hash: HASH }))
      );
    },
  } as unknown as PublicClient;
  return { wallet: { address: ADVERTISER, publicClient }, calls };
}

describe("observing a close or refund transaction", () => {
  it("settles a receipt that arrives on a later check without a reload", async () => {
    let mined = false;
    const { wallet } = walletWith({
      transaction: async () => ({ nonce: 7 }),
      minedNonce: async () => (mined ? 8 : 7),
      receipt: async () => {
        if (!mined) throw new TransactionReceiptNotFoundError({ hash: HASH });
        return { status: "success" };
      },
    });
    // The page's check for a close: the campaign still reads "active".
    const check = unresolvedTxCheck({
      wallet,
      chainId: CHAIN_ID,
      hash: HASH,
      sentAtMs: Date.now(),
      readEffect: async () => settlementEffectVisible("close", "active"),
    });

    expect(await check()).toBe("pending");
    mined = true;
    expect(await check()).toBe("done");
  });

  it("never reports a close as replaced while the campaign cannot be read", async () => {
    // Nonce 7 was used by another transaction, which may have closed it.
    const { wallet } = walletWith({
      transaction: async () => ({ nonce: 7 }),
      minedNonce: async () => 8,
    });
    const check = (readEffect: () => Promise<boolean>) =>
      unresolvedTxCheck({
        wallet,
        chainId: CHAIN_ID,
        hash: HASH,
        sentAtMs: Date.now(),
        readEffect,
      })();

    expect(
      await check(async () => {
        throw new Error("rpc down");
      }),
    ).toBe("pending");
    expect(await check(async () => false)).toBe("replaced");
    expect(await check(async () => true)).toBe("done");
  });

  it("reads the sender's nonce before the receipt", async () => {
    const { wallet, calls } = walletWith({
      transaction: async () => ({ nonce: 7 }),
      minedNonce: async () => 8,
    });

    expect(await observeSettlementTx(wallet, CHAIN_ID, HASH, null)).toEqual({
      receipt: null,
      known: true,
      txNonce: 7,
      minedNonce: 8,
    });
    expect(calls).toEqual([
      "getTransaction",
      "getTransactionCount",
      "getTransactionReceipt",
    ]);
  });

  it("tells a hash the node does not know from an RPC that fails", async () => {
    const notFound = walletWith({});
    expect(
      await observeSettlementTx(notFound.wallet, CHAIN_ID, HASH, 7),
    ).toMatchObject({ known: false, txNonce: 7, receipt: null });

    const failing = walletWith({
      transaction: async () => {
        throw new Error("rpc down");
      },
      minedNonce: async () => {
        throw new Error("rpc down");
      },
    });
    expect(
      await observeSettlementTx(failing.wallet, CHAIN_ID, HASH, null),
    ).toEqual({ receipt: null, known: null, txNonce: null, minedNonce: null });
  });

  it("observes nothing while the wallet is on another network", async () => {
    const { wallet, calls } = walletWith({ chainId: 1 });

    expect(await observeSettlementTx(wallet, CHAIN_ID, HASH, 7)).toEqual({
      receipt: null,
      known: null,
      txNonce: 7,
      minedNonce: null,
    });
    expect(calls).toEqual([]);
  });
});
