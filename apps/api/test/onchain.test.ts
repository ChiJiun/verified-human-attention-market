import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { signedInAs } from "./support/auth.js";
import {
  autoLinkCreatedCampaigns,
  syncCampaignStatuses,
} from "../src/campaigns/onchain.js";
import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";
import { InMemoryChainEventRepository } from "../src/chain/events-repository.js";
import { indexOnce } from "../src/chain/indexer.js";
import { InMemoryEligibilityRepository } from "../src/eligibility/repository.js";
import { InMemorySubmissionRepository } from "../src/submissions/repository.js";
import { FakeChain, logs } from "./support/fake-chain.js";

const apps: ReturnType<typeof buildApp>[] = [];
const CONTRACT = "0x" + "c0".repeat(20);
const USDC_ADDRESS = "0x" + "d0".repeat(20);
const ADVERTISER = "0x1234567890abcdef1234567890abcdef12345678";
const CLAIMANT = "0x" + "b".repeat(40);
const USDC = 1_000_000n;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const draft = {
  advertiser: ADVERTISER,
  contentUrl: "https://example.com/sponsored",
  rewardPerCompletion: "1000000",
  maxCompletions: 10,
  startAt: "2026-10-05T10:15:00.000Z",
  endAt: "2026-10-05T11:15:00.000Z",
  mission: {
    questions: [
      {
        id: "q1",
        prompt: "Pick a",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    ],
    answerKey: { q1: "a" },
  },
};

const START = Date.parse(draft.startAt) / 1000;
const END = Date.parse(draft.endAt) / 1000;

async function setup(options: { chainConfigured?: boolean } = {}) {
  let now = new Date("2026-10-05T10:00:00.000Z");
  const chain = new FakeChain(CONTRACT, 2);
  const campaigns = new InMemoryCampaignRepository();
  const events = new InMemoryChainEventRepository();
  const eligibility = new InMemoryEligibilityRepository();
  const submissions = new InMemorySubmissionRepository(eligibility);
  const scope = { chainId: 84532, contractAddress: CONTRACT };
  const chainDeps = {
    rpc: chain,
    chain: { ...scope, usdcAddress: USDC_ADDRESS },
    events,
    now: () => now,
  };
  const app = buildApp({
    authenticate: signedInAs(),
    campaignRepository: campaigns,
    eligibilityRepository: eligibility,
    submissionRepository: submissions,
    chainId: 84532,
    chain: options.chainConfigured === false ? null : chainDeps,
    now: () => now,
  });
  apps.push(app);

  async function createDraft(key = "draft-1", overrides = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": key },
      payload: { ...draft, ...overrides },
    });
    return response.json<{ id: string }>().id;
  }

  /** Simulates the advertiser's createCampaign transaction. */
  function createOnchain(
    onchainId: number,
    params: Partial<{
      advertiser: string;
      rewardPerCompletion: bigint;
      maxCompletions: number;
      startTime: number;
      endTime: number;
    }> = {},
    address = CONTRACT,
  ) {
    const struct = {
      advertiser: ADVERTISER,
      rewardPerCompletion: USDC,
      maxCompletions: 10,
      startTime: START,
      endTime: END,
      ...params,
    };
    chain.campaignStructs.set(String(onchainId), struct);
    chain.mine(1, [logs.created(onchainId, struct.advertiser)], address);
    return chain.lastTxHash;
  }

  async function reconcile() {
    await indexOnce(chain, events, {
      chainId: 84532,
      contractAddress: CONTRACT,
      deployBlock: 1n,
      confirmations: 2,
      maxBlockRange: 100n,
    });
    await autoLinkCreatedCampaigns({ campaigns, ...chainDeps });
    return syncCampaignStatuses({
      campaigns,
      events,
      chain: scope,
      now: () => now,
    });
  }

  const link = (campaignId: string, txHash: string) =>
    app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/onchain`,
      payload: { txHash },
    });

  const analytics = async (campaignId: string) =>
    (
      await app.inject({
        method: "GET",
        url: `/v1/campaigns/${campaignId}/analytics`,
      })
    ).json<Record<string, unknown>>();

  return {
    app,
    chain,
    campaigns,
    createDraft,
    createOnchain,
    reconcile,
    link,
    analytics,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

describe("GET /v1/chain", () => {
  it("exposes the public contract addresses for wallets", async () => {
    const { app } = await setup();
    const response = await app.inject({ method: "GET", url: "/v1/chain" });

    expect(response.json()).toEqual({
      chainId: 84532,
      campaignManager: CONTRACT,
      usdc: USDC_ADDRESS,
    });
  });

  it("reports when chain integration is not configured", async () => {
    const { app } = await setup({ chainConfigured: false });
    const response = await app.inject({ method: "GET", url: "/v1/chain" });

    expect(response.statusCode).toBe(503);
  });
});

describe("POST /v1/campaigns/:id/publish", () => {
  it("returns the exact on-chain transaction intent for a draft", async () => {
    const { app, createDraft } = await setup();
    const id = await createDraft();

    const response = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/publish`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      chainId: 84532,
      campaignManager: CONTRACT,
      steps: [
        {
          function: "createCampaign",
          args: {
            rewardPerCompletion: "1000000",
            maxCompletions: 10,
            startTime: START,
            endTime: END,
          },
        },
        {
          contract: USDC_ADDRESS,
          function: "approve",
          args: { spender: CONTRACT, amount: "10000000" },
        },
        { function: "fundCampaign", args: { amount: "10000000" } },
      ],
    });
  });

  it("refuses when the start time has passed or chain is not configured", async () => {
    const started = await setup();
    const id = await started.createDraft();
    started.setNow(new Date(draft.startAt));
    expect(
      (
        await started.app.inject({
          method: "POST",
          url: `/v1/campaigns/${id}/publish`,
        })
      ).statusCode,
    ).toBe(409);

    const offline = await setup({ chainConfigured: false });
    const offlineId = await offline.createDraft();
    expect(
      (
        await offline.app.inject({
          method: "POST",
          url: `/v1/campaigns/${offlineId}/publish`,
        })
      ).json(),
    ).toMatchObject({ error: { code: "CHAIN_NOT_CONFIGURED" } });
  });
});

describe("POST /v1/campaigns/:id/onchain", () => {
  it("links a verified creation transaction idempotently", async () => {
    const { createDraft, createOnchain, link } = await setup();
    const id = await createDraft();
    const txHash = createOnchain(1);

    const first = await link(id, txHash);
    const retry = await link(id, txHash);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      onchainCampaignId: "1",
      publishTxHash: txHash,
      status: "pending_onchain",
    });
    expect(retry.statusCode).toBe(200);

    const other = createOnchain(2);
    expect((await link(id, other)).json()).toMatchObject({
      error: { code: "ALREADY_LINKED" },
    });
  });

  it("reports an unmined transaction or RPC outage as reconciling, not failed", async () => {
    const { chain, createDraft, link } = await setup();
    const id = await createDraft();

    const unknown = await link(id, "0x" + "9".repeat(64));
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toMatchObject({
      status: "reconciling",
      code: "TX_PENDING",
    });

    chain.rpcDown = true;
    const outage = await link(id, "0x" + "9".repeat(64));
    expect(outage.statusCode).toBe(503);
    expect(outage.json()).toMatchObject({ status: "reconciling" });
  });

  it.each([
    [
      "wrong advertiser",
      { advertiser: "0x" + "e".repeat(40) },
      "ADVERTISER_MISMATCH",
    ],
    [
      "different reward",
      { rewardPerCompletion: 2n * USDC },
      "PARAMETERS_MISMATCH",
    ],
    ["different completions", { maxCompletions: 9 }, "PARAMETERS_MISMATCH"],
    ["different window", { endTime: END + 60 }, "PARAMETERS_MISMATCH"],
  ])("rejects on-chain evidence with %s", async (_label, params, code) => {
    const { createDraft, createOnchain, link } = await setup();
    const id = await createDraft();

    const response = await link(id, createOnchain(1, params));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code } });
  });

  it("rejects events from another contract and reverted transactions", async () => {
    const { chain, createDraft, createOnchain, link } = await setup();
    const id = await createDraft();

    const foreign = createOnchain(1, {}, "0x" + "f".repeat(40));
    expect((await link(id, foreign)).json()).toMatchObject({
      error: { code: "NO_CAMPAIGN_CREATED_EVENT" },
    });

    const reverted = createOnchain(2);
    chain.revertedTxs.add(reverted);
    expect((await link(id, reverted)).json()).toMatchObject({
      error: { code: "TX_REVERTED" },
    });
  });

  it("never links one on-chain campaign to two drafts", async () => {
    const { createDraft, createOnchain, link } = await setup();
    const first = await createDraft("a");
    const second = await createDraft("b", {
      contentUrl: "https://example.com/b",
    });
    const txHash = createOnchain(1);

    expect((await link(first, txHash)).statusCode).toBe(200);
    expect((await link(second, txHash)).json()).toMatchObject({
      error: { code: "ONCHAIN_CAMPAIGN_ALREADY_LINKED" },
    });
  });
});

describe("on-chain reconciliation", () => {
  it("activates a campaign only from confirmed funding", async () => {
    const { chain, campaigns, createDraft, createOnchain, link, reconcile } =
      await setup();
    const id = await createDraft();
    await link(id, createOnchain(1));

    chain.mine(1, [logs.funded(1, 10n * USDC)]);
    await reconcile();
    // Funding is still inside the confirmation window.
    expect((await campaigns.getById(id))?.status).toBe("pending_onchain");

    chain.mine(3);
    const result = await reconcile();
    expect(result.updated).toEqual([
      { campaignId: id, from: "pending_onchain", to: "active" },
    ]);
    expect((await campaigns.getById(id))?.status).toBe("active");
  });

  it("recovers a campaign whose transaction hash was never reported", async () => {
    const { chain, campaigns, createDraft, createOnchain, reconcile } =
      await setup();
    const id = await createDraft();
    createOnchain(7);
    chain.mine(1, [logs.funded(7, 10n * USDC)]);
    chain.mine(3);

    await reconcile();

    expect(await campaigns.getById(id)).toMatchObject({
      onchainCampaignId: "7",
      status: "active",
    });
  });

  it("does not guess between identical drafts", async () => {
    const { chain, campaigns, createDraft, createOnchain, reconcile } =
      await setup();
    const first = await createDraft("a");
    const second = await createDraft("b", {
      contentUrl: "https://example.com/b",
    });
    createOnchain(3);
    chain.mine(3);

    await reconcile();

    expect((await campaigns.getById(first))?.onchainCampaignId).toBeNull();
    expect((await campaigns.getById(second))?.onchainCampaignId).toBeNull();
  });
});

describe("GET /v1/campaigns/:id/analytics", () => {
  it("reports no settlement before the campaign is on-chain", async () => {
    const { createDraft, analytics } = await setup();
    const id = await createDraft();

    expect(await analytics(id)).toMatchObject({
      status: "draft",
      plannedBudget: "10000000",
      submissions: { accepted: 0, rejected: 0 },
      settlement: null,
    });
  });

  it("separates confirmed from pending settlement and survives reprocessing", async () => {
    const { chain, createDraft, createOnchain, link, reconcile, analytics } =
      await setup();
    const id = await createDraft();
    await link(id, createOnchain(1));
    chain.mine(1, [logs.funded(1, 10n * USDC)]);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 1)]);
    chain.mine(3);
    chain.mine(1, [logs.claimed(1, "0x" + "a".repeat(40), USDC, 2)]);

    await reconcile();
    await reconcile();

    expect(await analytics(id)).toMatchObject({
      status: "active",
      settlement: {
        confirmed: {
          funded: "10000000",
          paidRewards: "1000000",
          paidCompletions: 1,
          remaining: "9000000",
        },
        pending: { paidRewards: "2000000", paidCompletions: 2 },
        hasUnconfirmedEvents: true,
      },
    });
  });

  it("reports fully paid, closed and refunded campaigns", async () => {
    const { chain, createDraft, createOnchain, link, reconcile, analytics } =
      await setup();
    const id = await createDraft("full", { maxCompletions: 2 });
    await link(id, createOnchain(1, { maxCompletions: 2 }));
    chain.mine(1, [logs.funded(1, 2n * USDC)]);
    chain.mine(1, [logs.claimed(1, CLAIMANT, USDC, 1)]);
    chain.mine(1, [logs.claimed(1, "0x" + "a".repeat(40), USDC, 2)]);
    chain.mine(3);
    await reconcile();

    expect(await analytics(id)).toMatchObject({
      status: "active",
      settlement: { confirmed: { paidCompletions: 2, remaining: "0" } },
    });

    chain.mine(1, [logs.closed(1)]);
    chain.mine(3);
    await reconcile();
    expect((await analytics(id)).status).toBe("closed");

    chain.mine(1, [logs.refunded(1, 0n)]);
    chain.mine(3);
    await reconcile();
    expect(await analytics(id)).toMatchObject({
      status: "settled",
      settlement: {
        confirmed: {
          status: "settled",
          refunded: "0",
          accountingViolation: false,
        },
      },
    });
  });
});
