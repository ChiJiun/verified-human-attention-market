import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  decodeFunctionData,
  encodeFunctionResult,
  toHex,
  type Hash,
  type Hex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AdvertiserPage from "../app/advertiser/page";
import { chain } from "../lib/config";
import { apiFetch, injectedWallet } from "./support/dom";

// The receipt does not arrive while the page waits for it (two minutes in
// the app), so the card says "reconciling" and the page keeps checking the
// transaction every 10 s (#86). Everything else of lib/wallet is real.
vi.mock("../lib/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/wallet")>()),
  waitForTx: async (_publicClient: unknown, hash: Hash) => ({
    kind: "pending",
    hash,
  }),
}));

const CAMPAIGN = "33333333-3333-4333-8333-333333333333";
const ADVERTISER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MANAGER = "0xcccccccccccccccccccccccccccccccccccccccc";
const USDC = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DRAFT_REF = `0x${"11".repeat(32)}` as Hex;
const CLOSE_TX = `0x${"44".repeat(32)}` as Hash;
const START = 1_800_000_000;
const END = START + 3_600;
/** The latest block's time: the campaign is running, far from its end. */
const NOW = START + 600;
const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();

/** What the wallet's node shows; tests change it between checks. */
interface ChainNode {
  status: "active" | "closed";
  closedAt: bigint;
  /** The close transaction's nonce, or null while the node does not know it. */
  txNonce: number | null;
  /** The advertiser's mined transaction count. */
  minedNonce: number;
  receipt: "success" | null;
}

let node: ChainNode;

/** CampaignManager as the node answers eth_call for it. */
function answerCall({ to, data }: { to: Hex; data: Hex }): Hex {
  if (to.toLowerCase() !== MANAGER) throw new Error(`eth_call to ${to}`);
  const abi = campaignManagerAbi;
  const { functionName } = decodeFunctionData({ abi, data });
  switch (functionName) {
    case "MAX_AUTHORIZATION_TTL":
      return encodeFunctionResult({ abi, functionName, result: 900n });
    case "paused":
      return encodeFunctionResult({ abi, functionName, result: false });
    case "campaignIdByDraft":
      return encodeFunctionResult({ abi, functionName, result: 1n });
    case "campaigns":
      return encodeFunctionResult({
        abi,
        functionName,
        result: [
          ADVERTISER,
          10_000_000n,
          0n,
          1_000_000n,
          10,
          0,
          BigInt(START),
          BigInt(END),
          node.closedAt,
          node.status === "active" ? 1 : 2,
        ],
      });
    case "closeCampaign":
      return "0x";
    default:
      throw new Error(`eth_call ${functionName}`);
  }
}

/** The advertiser's injected wallet, answering from `node`. */
function advertiserWallet() {
  return injectedWallet({
    eth_requestAccounts: () => [ADVERTISER],
    eth_chainId: () => toHex(chain.id),
    eth_getBlockByNumber: () => ({
      number: "0x10",
      hash: `0x${"66".repeat(32)}`,
      timestamp: toHex(NOW),
    }),
    eth_call: ([request]) => answerCall(request as { to: Hex; data: Hex }),
    eth_sendTransaction: () => CLOSE_TX,
    eth_getTransactionByHash: () =>
      node.txNonce === null
        ? null
        : {
            hash: CLOSE_TX,
            nonce: toHex(node.txNonce),
            from: ADVERTISER,
            to: MANAGER,
            input: "0x",
            value: "0x0",
            gas: "0x5208",
            maxFeePerGas: "0x1",
            maxPriorityFeePerGas: "0x1",
            type: "0x2",
            chainId: toHex(chain.id),
            blockHash: null,
            blockNumber: null,
            transactionIndex: null,
            accessList: [],
            v: "0x0",
            yParity: "0x0",
            r: "0x1",
            s: "0x1",
          },
    eth_getTransactionCount: () => toHex(node.minedNonce),
    eth_getTransactionReceipt: () =>
      node.receipt === null
        ? null
        : {
            blockHash: `0x${"55".repeat(32)}`,
            blockNumber: "0xa",
            contractAddress: null,
            cumulativeGasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            from: ADVERTISER,
            gasUsed: "0x5208",
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            to: MANAGER,
            transactionHash: CLOSE_TX,
            transactionIndex: "0x0",
            type: "0x2",
          },
  });
}

/** Confirmed settlement figures after `paidCompletions` rewards of 1 USDC. */
function settlementAfter(paidCompletions: number) {
  const paid = BigInt(paidCompletions) * 1_000_000n;
  return {
    confirmed: {
      funded: "10000000",
      paidRewards: paid.toString(),
      remaining: (10_000_000n - paid).toString(),
      paidCompletions,
    },
    pending: { funded: "10000000", status: "active" },
    hasUnconfirmedEvents: false,
  };
}

/** The API: a signed-in advertiser and the campaign, active and linked. */
function advertiserApi(
  settlement: ReturnType<typeof settlementAfter> | null = null,
) {
  let session: { address: string; expiresAt: string } | null = {
    address: ADVERTISER,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  return apiFetch({
    "GET /v1/auth/session": () =>
      session ? { body: session } : { status: 204 },
    "POST /v1/auth/logout": () => {
      session = null;
      return { status: 204 };
    },
    "GET /v1/chain": () => ({
      body: { chainId: chain.id, campaignManager: MANAGER, usdc: USDC },
    }),
    [`GET /v1/campaigns/${CAMPAIGN}/analytics`]: () => ({
      body: {
        campaignId: CAMPAIGN,
        chainId: chain.id,
        onchainCampaignId: "1",
        onchainContractAddress: MANAGER,
        draftRef: DRAFT_REF,
        rewardPerCompletion: "1000000",
        maxCompletions: 10,
        startAt: iso(START),
        endAt: iso(END),
        status: "active",
        plannedBudget: "10000000",
        submissions: {
          accepted: 0,
          rejected: 0,
          flaggedAccepted: 0,
          adjustedAccepted: 0,
          flagReasons: {},
        },
        settlement,
      },
    }),
  });
}

/** Advances fake time by `ms` and lets the reads and renders it starts finish. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

const card = () => document.querySelector("section.tx");
const closeButton = () =>
  screen.queryByRole("button", { name: "Close campaign" });
const checks = (wallet: ReturnType<typeof injectedWallet>) =>
  wallet.count("eth_getTransactionByHash");

/** Signs in, connects, and sends Close; its receipt does not come in time. */
async function reconcilingClose() {
  const wallet = advertiserWallet();
  window.ethereum = wallet.provider;
  const api = advertiserApi();
  vi.stubGlobal("fetch", api.fetch);

  const view = render(<AdvertiserPage />);
  await advance(0);
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  await advance(0);
  fireEvent.click(closeButton()!);
  await advance(0);

  expect(card()?.className).toContain("reconciling");
  expect(card()?.textContent).toContain("Close campaign — still confirming.");
  // Hidden while the page waits for the close's effect.
  expect(closeButton()).toBeNull();
  expect(checks(wallet)).toBe(0);
  return { view, wallet, api };
}

beforeEach(() => {
  node = {
    status: "active",
    closedAt: 0n,
    txNonce: null,
    minedNonce: 7,
    receipt: null,
  };
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  window.history.replaceState(null, "", `/advertiser?campaign=${CAMPAIGN}`);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.ethereum;
  localStorage.clear();
});

describe("advertiser page: paid rewards", () => {
  it.each([
    [0, "0 USDC (0 completions)"],
    [1, "1 USDC (1 completion)"],
    [2, "2 USDC (2 completions)"],
  ])("shows %i paid as %s", async (paidCompletions, text) => {
    window.ethereum = advertiserWallet().provider;
    vi.stubGlobal(
      "fetch",
      advertiserApi(settlementAfter(paidCompletions)).fetch,
    );

    render(<AdvertiserPage />);
    await advance(0);
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await advance(0);

    const term = screen.getByText("Paid rewards");
    expect(term.nextElementSibling?.textContent).toBe(text);
  });
});

describe("advertiser page: an unresolved close (#86)", () => {
  it("turns the card done once the chain shows the close, then stops checking", async () => {
    const { wallet } = await reconcilingClose();

    // The first check still sees the campaign active.
    await advance(10_000);
    expect(checks(wallet)).toBe(1);
    expect(card()?.className).toContain("reconciling");

    // Mined after all (the node never returned the hash): the next read
    // shows it closed.
    node.status = "closed";
    node.closedAt = BigInt(NOW);
    await advance(10_000);

    expect(card()?.className).toContain("done");
    expect(card()?.textContent).toContain("Campaign closed — done.");
    expect(card()?.textContent).toContain(CLOSE_TX);
    expect(checks(wallet)).toBe(2);
    await advance(60_000);
    expect(checks(wallet)).toBe(2);
  });

  it("offers Close again once two checks agree it was replaced", async () => {
    const { wallet } = await reconcilingClose();
    // Another transaction used the close's nonce; the campaign is unchanged.
    node.txNonce = 7;
    node.minedNonce = 8;

    await advance(10_000);
    // One check decides nothing: the wallet's RPC may lag.
    expect(card()?.className).toContain("reconciling");
    expect(closeButton()).toBeNull();

    await advance(10_000);
    expect(card()?.className).toContain("failed");
    expect(card()?.textContent).toContain(
      "Your wallet used this transaction's nonce for another transaction (cancelled or replaced), and the campaign is unchanged.",
    );
    // The wait for the close's effect is over: Close is offered again.
    expect(closeButton()).not.toBeNull();
    expect((closeButton() as HTMLButtonElement).disabled).toBe(false);
    const settled = checks(wallet);
    await advance(30_000);
    expect(checks(wallet)).toBe(settled);
  });

  it("keeps Close hidden after a done receipt while reads still show it active", async () => {
    await reconcilingClose();
    // Mined, but the node's campaign read lags behind its receipt.
    node.txNonce = 7;
    node.minedNonce = 8;
    node.receipt = "success";

    await advance(10_000);
    await advance(10_000);

    expect(card()?.textContent).toContain("Campaign closed — done.");
    // A stale "active" read must not offer Close again.
    await advance(30_000);
    expect(closeButton()).toBeNull();
  });

  it("restarts the check with the wallet that is connected again", async () => {
    const first = await reconcilingClose();
    await advance(10_000);
    expect(checks(first.wallet)).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await advance(0);
    // No wallet, no checks; the card still says the close is unresolved.
    await advance(30_000);
    expect(checks(first.wallet)).toBe(1);
    expect(card()?.className).toContain("reconciling");

    const second = advertiserWallet();
    window.ethereum = second.provider;
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    await advance(0);
    await advance(10_000);
    // The effect started again on the new wallet's client.
    expect(checks(second)).toBe(1);
    expect(checks(first.wallet)).toBe(1);

    node.status = "closed";
    node.closedAt = BigInt(NOW);
    await advance(10_000);
    expect(card()?.textContent).toContain("Campaign closed — done.");
  });

  it("stops every interval when the page is left", async () => {
    const { view, wallet, api } = await reconcilingClose();
    await advance(10_000);
    expect(checks(wallet)).toBe(1);

    view.unmount();
    const asked = wallet.methods.length;
    const requested = api.requests.length;
    await advance(60_000);

    expect(wallet.methods.length).toBe(asked);
    expect(api.requests.length).toBe(requested);
    expect(vi.getTimerCount()).toBe(0);
  });
});
