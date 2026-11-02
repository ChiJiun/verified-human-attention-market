import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  ASSUME_DROPPED_AFTER_MS,
  observeSettlementTx,
  resolveSettlementTx,
  settlementButton,
  settlementEffectVisible,
  type SettlementAction,
  type SettlementTxObservation,
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

  it("stay in place, disabled, while another action runs", () => {
    expect(settlementButton("close", available, null, true)).toBe("disabled");
    expect(settlementButton("refund", available, "close", true)).toBe(
      "disabled",
    );
    expect(settlementButton("close", available, null, false)).toBe("enabled");
  });

  it("are hidden only while not offered or awaiting their own effect", () => {
    expect(settlementButton("close", available, "close", false)).toBe("hidden");
    expect(settlementButton("refund", { kind: "waiting" }, null, false)).toBe(
      "hidden",
    );
    expect(settlementButton("close", null, null, true)).toBe("hidden");
  });
});

describe("resolving an unknown close or refund outcome", () => {
  const resolve = (
    observation: SettlementTxObservation,
    {
      action = "close" as SettlementAction,
      storedStatus = "active" as string | null,
      elapsedMs = 0,
    } = {},
  ) => resolveSettlementTx({ action, storedStatus, observation, elapsedMs });

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

  it("takes an unknown hash as dropped only after a while", () => {
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
    const check = async () =>
      resolveSettlementTx({
        action: "close",
        storedStatus: "active",
        observation: await observeSettlementTx(wallet, CHAIN_ID, HASH, null),
        elapsedMs: 0,
      });

    expect(await check()).toBe("pending");
    mined = true;
    expect(await check()).toBe("done");
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
