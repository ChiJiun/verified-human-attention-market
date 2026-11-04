import { campaignManagerAbi } from "@vham/shared/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  encodeAbiParameters,
  encodeEventTopics,
  toHex,
  type Hash,
  type Hex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MissionPage from "../app/mission/page";
import { chain } from "../lib/config";
import {
  apiFetch,
  injectedWallet,
  revert,
  type ApiAnswer,
} from "./support/dom";

// The World ID widget is not part of the claim step.
vi.mock("@worldcoin/idkit", () => ({
  CredentialRequest: () => ({}),
  IDKitRequestWidget: () => null,
}));

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const SUBMISSION = "22222222-2222-4222-8222-222222222222";
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT = "0xcccccccccccccccccccccccccccccccccccccccc";
const NONCE = `0x${"22".repeat(32)}` as Hex;
const TX = `0x${"44".repeat(32)}` as Hash;
const ISSUED_AT = 1_791_186_300;
const AUTHORIZATION = `POST /v1/campaigns/${CAMPAIGN}/submissions/${SUBMISSION}/authorization`;

const authorization = {
  campaignId: "1",
  draftRef: `0x${"11".repeat(32)}`,
  claimant: WALLET,
  amount: "1000000",
  nonce: NONCE,
  issuedAt: ISSUED_AT,
  expiresAt: ISSUED_AT + 900,
  signature: `0x${"33".repeat(65)}`,
  chainId: chain.id,
  contractAddress: CONTRACT,
};

/** The RewardClaimed log of `authorization`, as a node returns it. */
const rewardClaimed = {
  address: CONTRACT,
  topics: encodeEventTopics({
    abi: campaignManagerAbi,
    eventName: "RewardClaimed",
    args: { campaignId: 1n, claimant: WALLET },
  }),
  data: encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }],
    [1_000_000n, NONCE],
  ),
  blockHash: `0x${"55".repeat(32)}`,
  blockNumber: "0xa",
  logIndex: "0x0",
  transactionHash: TX,
  transactionIndex: "0x0",
  removed: false,
};

/**
 * A wallet on the site's chain whose node answers the claim: the contract's
 * `code`, eth_call (`simulation`: null passes, an Error reverts) and, once
 * sent, a successful receipt with `logs`.
 */
function claimWallet({
  code = "0x6080" as Hex,
  simulation = null as Error | null,
  logs = [rewardClaimed] as unknown[],
} = {}) {
  return injectedWallet({
    eth_requestAccounts: () => [WALLET],
    eth_chainId: () => toHex(chain.id),
    eth_getCode: () => code,
    eth_call: () => {
      if (simulation) throw simulation;
      return "0x";
    },
    eth_sendTransaction: () => TX,
    eth_getTransactionReceipt: () => ({
      blockHash: `0x${"55".repeat(32)}`,
      blockNumber: "0xa",
      contractAddress: null,
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: "0x1",
      from: WALLET,
      gasUsed: "0x5208",
      logs,
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      to: CONTRACT,
      transactionHash: TX,
      transactionIndex: "0x0",
      type: "0x2",
    }),
  });
}

/** The API of an active campaign, answering the claim with `claim`. */
function api(claim: () => ApiAnswer) {
  return apiFetch({
    [`GET /v1/campaigns/${CAMPAIGN}`]: () => ({
      body: {
        id: CAMPAIGN,
        status: "active",
        rewardPerCompletion: "1000000",
        startAt: "2026-11-04T00:00:00.000Z",
        endAt: "2026-11-05T00:00:00.000Z",
      },
    }),
    [`GET /v1/campaigns/${CAMPAIGN}/mission`]: () => ({
      body: {
        campaignId: CAMPAIGN,
        contentUrl: "https://example.com",
        questions: [],
      },
    }),
    [AUTHORIZATION]: claim,
  });
}

/** Renders the page at its claim step: verified and accepted earlier. */
async function openClaimStep(
  wallet: ReturnType<typeof injectedWallet>,
  fetch: ReturnType<typeof apiFetch>["fetch"],
) {
  window.ethereum = wallet.provider;
  vi.stubGlobal("fetch", fetch);
  const saved = (name: string) => `vham:${CAMPAIGN}:${WALLET}:${name}`;
  sessionStorage.setItem(saved("eligibility"), JSON.stringify("eligible"));
  sessionStorage.setItem(saved("submission"), JSON.stringify(SUBMISSION));

  const view = render(<MissionPage />);
  await screen.findByText("Earn 1 USDC");
  fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
  fireEvent.click(await screen.findByRole("button", { name: "Claim USDC" }));
  return view;
}

const errorShown = (container: HTMLElement) =>
  container.querySelector("p.error")?.textContent ?? null;

beforeEach(() => {
  window.history.replaceState(null, "", `/mission?campaign=${CAMPAIGN}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.ethereum;
  sessionStorage.clear();
});

describe("mission page: a reward that was already paid (#82)", () => {
  it(
    "switches to already paid when the simulation says so, sending nothing",
    {
      timeout: 20_000,
    },
    async () => {
      const wallet = claimWallet({ simulation: revert("NonceAlreadyUsed") });
      const { container } = await openClaimStep(
        wallet,
        api(() => ({ body: authorization })).fetch,
      );

      // viem's transport retries a revert it cannot classify (about 1 s), as
      // it does with a real injected wallet.
      expect(
        await screen.findByText(
          "This reward was already paid to your wallet.",
          undefined,
          { timeout: 15_000 },
        ),
      ).toBeTruthy();
      expect(screen.getByText(/No\s+transaction was sent\./)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Claim USDC" })).toBeNull();
      expect(errorShown(container)).toBeNull();
      expect(wallet.count("eth_call")).toBeGreaterThan(0);
      expect(wallet.count("eth_sendTransaction")).toBe(0);
    },
  );

  it("run() turns the API's ALREADY_CLAIMED into already paid, not an error", async () => {
    const wallet = claimWallet();
    const { fetch, requests } = api(() => ({
      status: 409,
      body: { error: { code: "ALREADY_CLAIMED", retryable: false } },
    }));
    const { container } = await openClaimStep(wallet, fetch);

    expect(
      await screen.findByText("This reward was already paid to your wallet."),
    ).toBeTruthy();
    expect(screen.getByText(/No\s+transaction was sent\./)).toBeTruthy();
    expect(errorShown(container)).toBeNull();
    expect(requests).toContain(AUTHORIZATION);
    // Nothing was read from the contract or sent.
    expect(wallet.count("eth_getCode")).toBe(0);
    expect(wallet.count("eth_call")).toBe(0);
    expect(wallet.count("eth_sendTransaction")).toBe(0);
  });
});

describe("mission page: what the claim's receipt shows (#110 review)", () => {
  it("shows paid when the receipt carries this claim's RewardClaimed", async () => {
    const wallet = claimWallet();
    await openClaimStep(wallet, api(() => ({ body: authorization })).fetch);

    expect(await screen.findByText("Reward paid to your wallet.")).toBeTruthy();
    expect(screen.getByText(TX)).toBeTruthy();
    expect(wallet.count("eth_sendTransaction")).toBe(1);
  });

  it("does not show paid for a successful receipt without the event", async () => {
    const wallet = claimWallet({ logs: [] });
    await openClaimStep(wallet, api(() => ({ body: authorization })).fetch);

    expect(
      await screen.findByText(
        "The claim transaction succeeded, but no reward payment was found.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Reward paid to your wallet.")).toBeNull();
    expect(screen.getByText(TX)).toBeTruthy();
  });

  it("refuses a contract address without code, sending nothing", async () => {
    const wallet = claimWallet({ code: "0x" });
    const { container } = await openClaimStep(
      wallet,
      api(() => ({ body: authorization })).fetch,
    );

    await waitFor(() =>
      expect(errorShown(container)).toBe(
        `There is no contract at ${CONTRACT} on your wallet's network, so nothing was sent. The site's contract configuration needs fixing.`,
      ),
    );
    // Still at the claim step; nothing was simulated or sent.
    expect(screen.getByRole("button", { name: "Claim USDC" })).toBeTruthy();
    expect(wallet.count("eth_call")).toBe(0);
    expect(wallet.count("eth_sendTransaction")).toBe(0);
  });
});
