import {
  getAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hash,
  type PublicClient,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  allowanceCovers,
  fundedIndexed,
  fundingButton,
  fundingButtonLabel,
  fundingEffectVisible,
  fundingRefusal,
  readFunding,
  requiredBudget,
  trackedCall,
  trackedFailure,
  trackedNoun,
  type FundingAction,
  type FundingButton,
  type FundingDeployment,
  type FundingReading,
  type IndexedFunding,
} from "../lib/funding";
import {
  ASSUME_DROPPED_AFTER_MS,
  pollSettlementTx,
  resolveTxOutcome,
  unresolvedTxCheck,
  type SettlementTarget,
  type SettlementTxObservation,
  type SettlementTxOutcome,
} from "../lib/settlement";

const HASH = `0x${"ab".repeat(32)}` as Hash;
const ADVERTISER = getAddress(`0x${"aa".repeat(20)}`);
const MANAGER = getAddress(`0x${"cc".repeat(20)}`);
const USDC = getAddress(`0x${"dd".repeat(20)}`);
const CHAIN_ID = 84532;

const DEPLOYMENT: FundingDeployment = {
  chainId: CHAIN_ID,
  contractAddress: MANAGER,
  usdc: USDC,
};
const TARGET: SettlementTarget = {
  onchainCampaignId: "3",
  rewardPerCompletion: "1000000",
  maxCompletions: 10,
  startAt: "2026-11-03T10:00:00.000Z",
  endAt: "2026-11-03T12:00:00.000Z",
  draftRef: `0x${"ef".repeat(32)}` as Hash,
};
const BUDGET = 10_000_000n;

/** CampaignManager's stored status indices. */
const STATUS = { draft: 0, active: 1, closed: 2, settled: 4, cancelled: 5 };

const unfunded: FundingReading = {
  allowance: 0n,
  storedStatus: "draft",
  fundedBudget: 0n,
};
const funded: FundingReading = {
  allowance: 0n,
  storedStatus: "active",
  fundedBudget: BUDGET,
};

describe("the funding budget", () => {
  it("is rewardPerCompletion × maxCompletions in atomic units", () => {
    expect(requiredBudget(TARGET)).toBe(BUDGET);
    // Beyond Number.MAX_SAFE_INTEGER: still exact.
    expect(
      requiredBudget({
        rewardPerCompletion: "9007199254740993",
        maxCompletions: 3,
      }),
    ).toBe(27021597764222979n);
  });
});

describe("approve and fund effects", () => {
  it("approve shows once the allowance covers the budget", () => {
    expect(
      fundingEffectVisible("approve", BUDGET, {
        ...unfunded,
        allowance: BUDGET - 1n,
      }),
    ).toBe(false);
    expect(
      fundingEffectVisible("approve", BUDGET, {
        ...unfunded,
        allowance: BUDGET,
      }),
    ).toBe(true);
    expect(fundingEffectVisible("approve", BUDGET, null)).toBe(false);
    expect(
      allowanceCovers({ ...unfunded, allowance: BUDGET + 1n }, BUDGET),
    ).toBe(true);
  });

  it("approve also shows once the campaign is funded (funding spent the allowance)", () => {
    expect(fundingEffectVisible("approve", BUDGET, funded)).toBe(true);
  });

  it("fund shows only as the campaign funded with its budget", () => {
    // An allowance alone is not a funding.
    expect(
      fundingEffectVisible("fund", BUDGET, { ...unfunded, allowance: BUDGET }),
    ).toBe(false);
    expect(fundingEffectVisible("fund", BUDGET, funded)).toBe(true);
    // It stays funded through close and refund.
    expect(
      fundingEffectVisible("fund", BUDGET, {
        ...funded,
        storedStatus: "settled",
      }),
    ).toBe(true);
    expect(
      fundingEffectVisible("fund", BUDGET, { ...funded, fundedBudget: 1n }),
    ).toBe(false);
    expect(
      fundingEffectVisible("fund", BUDGET, {
        ...unfunded,
        storedStatus: "cancelled",
      }),
    ).toBe(false);
  });

  it("fund shows in the API's index, confirmed or not", () => {
    const indexed = (
      status: string,
      pending: IndexedFunding["settlement"],
    ): IndexedFunding => ({ status, settlement: pending });
    const pending = (status: string, amount: string) => ({
      pending: { status, funded: amount },
    });

    expect(fundedIndexed(null)).toBe(false);
    expect(fundedIndexed(indexed("pending_onchain", null))).toBe(false);
    expect(
      fundedIndexed(indexed("pending_onchain", pending("created", "0"))),
    ).toBe(false);
    expect(
      fundedIndexed(indexed("pending_onchain", pending("active", "10000000"))),
    ).toBe(true);
    expect(fundedIndexed(indexed("active", null))).toBe(true);
    expect(
      fundingEffectVisible(
        "fund",
        BUDGET,
        unfunded,
        indexed("pending_onchain", pending("active", "10000000")),
      ),
    ).toBe(true);
  });
});

describe("funding refusal before the wallet is asked", () => {
  it("lets a draft with nothing funded through", () => {
    expect(fundingRefusal(unfunded, BUDGET)).toBeNull();
  });

  it("stops a second funding after the first landed", () => {
    expect(fundingRefusal(funded, BUDGET)).toMatch(/already funded/);
    expect(
      fundingRefusal({ ...unfunded, storedStatus: "cancelled" }, BUDGET),
    ).toMatch(/cancelled/);
  });
});

describe("the funding button", () => {
  const idle = { awaitingEffect: null, maybeDropped: null, blocked: false };
  const labelOf = (button: FundingButton) =>
    button.kind === "hidden" ? null : fundingButtonLabel(button);

  it("offers Approve & fund, then Fund once the allowance covers the budget", () => {
    const approve = fundingButton(true, false, idle);
    const fund = fundingButton(true, true, idle);

    expect(approve).toEqual({ kind: "send", step: "approve", disabled: false });
    expect(fund).toEqual({ kind: "send", step: "fund", disabled: false });
    expect(labelOf(approve)).toBe("Approve & fund");
    expect(labelOf(fund)).toBe("Fund campaign");
    expect(fundingButton(true, false, { ...idle, blocked: true })).toEqual({
      kind: "send",
      step: "approve",
      disabled: true,
    });
    expect(fundingButton(false, true, idle)).toEqual({ kind: "hidden" });
  });

  it("is hidden while an approve or fund may still land", () => {
    for (const action of ["approve", "fund"] as const) {
      expect(
        fundingButton(true, true, { ...idle, awaitingEffect: action }),
      ).toEqual({ kind: "hidden" });
      // Dropped is only ever offered for the transaction awaited.
      expect(
        fundingButton(true, true, {
          ...idle,
          awaitingEffect: action,
          maybeDropped: "close",
        }),
      ).toEqual({ kind: "hidden" });
    }
  });

  it("offers only the warned 'anyway' send of the step never seen", () => {
    const approveAnyway = fundingButton(true, false, {
      ...idle,
      awaitingEffect: "approve",
      maybeDropped: "approve",
    });
    const fundAnyway = fundingButton(true, true, {
      ...idle,
      awaitingEffect: "fund",
      maybeDropped: "fund",
    });

    expect(approveAnyway).toEqual({
      kind: "send-anyway",
      step: "approve",
      disabled: false,
    });
    expect(fundAnyway).toEqual({
      kind: "send-anyway",
      step: "fund",
      disabled: false,
    });
    expect(labelOf(approveAnyway)).toBe("Approve & fund anyway");
    expect(labelOf(fundAnyway)).toBe("Fund campaign anyway");
    // Funded meanwhile (the first one landed): nothing is offered.
    expect(
      fundingButton(false, true, {
        ...idle,
        awaitingEffect: "fund",
        maybeDropped: "fund",
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("ignores a close or refund awaited elsewhere on the page", () => {
    expect(
      fundingButton(true, false, { ...idle, awaitingEffect: "close" }),
    ).toEqual({ kind: "send", step: "approve", disabled: false });
  });
});

describe("tracked transaction texts", () => {
  it("name approve and fund like close and refund", () => {
    expect(trackedCall("approve")).toEqual({
      label: "Approve USDC",
      done: "USDC approved",
    });
    expect(trackedCall("fund").label).toBe("Fund campaign");
    expect(trackedCall("close").done).toBe("Campaign closed");
    expect(trackedNoun("approve")).toBe("approval");
    expect(trackedNoun("fund")).toBe("funding");
    expect(trackedNoun("refund")).toBe("refund");
  });

  it("say what is unchanged after a replacement", () => {
    expect(trackedFailure("approve", "replaced")).toMatch(/allowance/);
    expect(trackedFailure("fund", "replaced")).toMatch(/campaign/);
    expect(trackedFailure("fund", "reverted")).toBe(
      "The transaction reverted.",
    );
  });
});

describe("resolving an unknown approve or fund outcome", () => {
  const seen: SettlementTxObservation = {
    receipt: null,
    known: true,
    txNonce: 7,
    minedNonce: 7,
  };
  const resolve = (
    observation: SettlementTxObservation,
    effect: boolean | null,
    elapsedMs = 0,
  ) => resolveTxOutcome({ effect, observation, elapsedMs });

  it("is done on the receipt or once the effect shows", () => {
    expect(resolve(seen, false)).toBe("pending");
    expect(resolve({ ...seen, receipt: "success" }, false)).toBe("done");
    // Sped up in the wallet: the replacement set the allowance.
    expect(resolve({ ...seen, minedNonce: 8 }, true)).toBe("done");
  });

  it("concludes 'replaced' only on a fresh read without the effect", () => {
    expect(resolve({ ...seen, minedNonce: 8 }, false)).toBe("replaced");
    expect(resolve({ ...seen, minedNonce: 8 }, null)).toBe("pending");
    expect(resolve({ ...seen, receipt: "reverted" }, null)).toBe("reverted");
  });

  it("takes a hash never seen as dropped only after a while, and never one seen", () => {
    const unknown = {
      receipt: null,
      known: false,
      txNonce: null,
      minedNonce: null,
    };
    expect(resolve(unknown, false, ASSUME_DROPPED_AFTER_MS - 1)).toBe(
      "pending",
    );
    expect(resolve(unknown, false, ASSUME_DROPPED_AFTER_MS)).toBe("dropped");
    expect(resolve(unknown, null, ASSUME_DROPPED_AFTER_MS)).toBe("pending");
    expect(
      resolve(
        { ...unknown, txNonce: 7, minedNonce: 7 },
        false,
        10 * ASSUME_DROPPED_AFTER_MS,
      ),
    ).toBe("pending");
  });
});

interface NodeState {
  chainId: number;
  /** null: the node does not know the hash. */
  tx: { nonce: number } | null;
  minedNonce: number;
  receipt: "success" | "reverted" | null;
  allowance: bigint | Error;
  mappedCampaignId: bigint;
  status: number;
  fundedBudget: bigint;
}

/** A wallet whose node answers from a mutable `state`. */
function nodeWith(initial: Partial<NodeState> = {}) {
  const state: NodeState = {
    chainId: CHAIN_ID,
    tx: { nonce: 7 },
    minedNonce: 7,
    receipt: null,
    allowance: 0n,
    mappedCampaignId: 3n,
    status: STATUS.draft,
    fundedBudget: 0n,
    ...initial,
  };
  const reads: { functionName: string; address: string; args?: unknown }[] = [];
  const seconds = (iso: string) => BigInt(Date.parse(iso) / 1000);
  const publicClient = {
    getChainId: async () => state.chainId,
    getTransaction: async () => {
      if (!state.tx) throw new TransactionNotFoundError({ hash: HASH });
      return state.tx;
    },
    getTransactionCount: async () => state.minedNonce,
    getTransactionReceipt: async () => {
      if (!state.receipt) {
        throw new TransactionReceiptNotFoundError({ hash: HASH });
      }
      return { status: state.receipt };
    },
    readContract: async ({
      functionName,
      address,
      args,
    }: {
      functionName: string;
      address: string;
      args?: unknown;
    }) => {
      reads.push({ functionName, address, args });
      switch (functionName) {
        case "allowance":
          if (state.allowance instanceof Error) throw state.allowance;
          return state.allowance;
        case "campaignIdByDraft":
          return state.mappedCampaignId;
        case "campaigns":
          return [
            ADVERTISER,
            state.fundedBudget,
            0n,
            1_000_000n,
            10,
            0,
            seconds(TARGET.startAt),
            seconds(TARGET.endAt),
            0n,
            state.status,
          ] as const;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
  } as unknown as PublicClient;
  return { state, reads, wallet: { address: ADVERTISER, publicClient } };
}

describe("reading the allowance and the campaign", () => {
  it("reads the allowance from the advertiser to CampaignManager", async () => {
    const { wallet, reads } = nodeWith({
      allowance: BUDGET,
      status: STATUS.active,
      fundedBudget: BUDGET,
    });

    expect(await readFunding(wallet, DEPLOYMENT, TARGET)).toEqual({
      allowance: BUDGET,
      storedStatus: "active",
      fundedBudget: BUDGET,
    });
    expect(reads).toContainEqual({
      functionName: "allowance",
      address: USDC,
      args: [ADVERTISER, MANAGER],
    });
    expect(reads).toContainEqual({
      functionName: "campaignIdByDraft",
      address: MANAGER,
      args: [ADVERTISER, TARGET.draftRef],
    });
  });

  it("refuses another network or an id that is not this draft's", async () => {
    await expect(
      readFunding(nodeWith({ chainId: 1 }).wallet, DEPLOYMENT, TARGET),
    ).rejects.toThrow(/network/);
    // After a deep reorg another draft can hold the id.
    await expect(
      readFunding(
        nodeWith({ mappedCampaignId: 4n }).wallet,
        DEPLOYMENT,
        TARGET,
      ),
    ).rejects.toThrow(/does not match this draft/);
  });
});

describe("polling an unknown approve or fund outcome", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The page's check: the transaction, then a fresh funding read. */
  function poll(
    node: ReturnType<typeof nodeWith>,
    action: FundingAction,
    sentAtMs = Date.now(),
  ) {
    const verdicts: SettlementTxOutcome[] = [];
    const stop = pollSettlementTx(
      unresolvedTxCheck({
        wallet: node.wallet,
        chainId: CHAIN_ID,
        hash: HASH,
        sentAtMs,
        readEffect: async () =>
          fundingEffectVisible(
            action,
            BUDGET,
            await readFunding(node.wallet, DEPLOYMENT, TARGET),
          ),
      }),
      (outcome) => verdicts.push(outcome),
      1_000,
    );
    return { verdicts, stop };
  }

  it("settles an approve whose receipt arrives after the wait timed out", async () => {
    const node = nodeWith();
    const { verdicts, stop } = poll(node, "approve");

    await vi.advanceTimersByTimeAsync(3_000);
    expect(verdicts).toEqual([]);
    node.state.receipt = "success";
    node.state.allowance = BUDGET;
    node.state.minedNonce = 8;
    await vi.advanceTimersByTimeAsync(2_000);
    stop();

    expect(verdicts).toEqual(["done"]);
  });

  it("settles a fund once the campaign shows funded, even without its receipt", async () => {
    const node = nodeWith({ allowance: BUDGET });
    const { verdicts, stop } = poll(node, "fund");

    await vi.advanceTimersByTimeAsync(2_000);
    // A sped-up replacement funded it; this hash never mines.
    node.state.minedNonce = 8;
    node.state.status = STATUS.active;
    node.state.fundedBudget = BUDGET;
    node.state.allowance = 0n;
    await vi.advanceTimersByTimeAsync(2_000);
    stop();

    expect(verdicts).toEqual(["done"]);
  });

  it("reports a cancelled approve as replaced, after two agreeing checks", async () => {
    const node = nodeWith({ minedNonce: 8 });
    const { verdicts, stop } = poll(node, "approve");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(verdicts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(verdicts).toEqual(["replaced"]);
    stop();
  });

  it("never concludes while the allowance cannot be read", async () => {
    const node = nodeWith({ minedNonce: 8, allowance: new Error("rpc down") });
    const { verdicts, stop } = poll(node, "approve");

    await vi.advanceTimersByTimeAsync(5_000);
    stop();

    expect(verdicts).toEqual([]);
  });

  it("offers a fund never seen as dropped, then settles when it lands after all", async () => {
    const node = nodeWith({ tx: null, allowance: BUDGET });
    const { verdicts, stop } = poll(
      node,
      "fund",
      Date.now() - ASSUME_DROPPED_AFTER_MS,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(verdicts).toEqual(["dropped"]);
    node.state.receipt = "success";
    node.state.status = STATUS.active;
    node.state.fundedBudget = BUDGET;
    await vi.advanceTimersByTimeAsync(2_000);
    stop();

    expect(verdicts).toEqual(["dropped", "done"]);
  });

  it("keeps a fund seen once pending while its nonce slot is empty", async () => {
    const node = nodeWith({ allowance: BUDGET });
    const { verdicts, stop } = poll(
      node,
      "fund",
      Date.now() - ASSUME_DROPPED_AFTER_MS,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    // The node forgets it; nonce 7 is still unused, so it can still land.
    node.state.tx = null;
    await vi.advanceTimersByTimeAsync(5_000);
    stop();

    expect(verdicts).toEqual([]);
  });
});
