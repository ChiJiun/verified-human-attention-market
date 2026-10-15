import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { signedInAs } from "./support/auth.js";
import {
  autoLinkCreatedCampaigns,
  draftRefFor,
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

const CONFIRMATIONS = 2;
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
    // Links wait for the same depth the indexer below treats as final.
    confirmations: CONFIRMATIONS,
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
  /**
   * Simulates the advertiser's createCampaign transaction for `draft` (its
   * draft reference is in the event and the contract mapping, ADR-0011).
   */
  function createOnchain(
    onchainId: number,
    draft: string,
    params: Partial<{
      advertiser: string;
      rewardPerCompletion: bigint;
      maxCompletions: number;
      startTime: number;
      endTime: number;
    }> = {},
    address = CONTRACT,
    /** Mine the confirmation depth on top (false = leave it unconfirmed). */
    confirm = true,
  ) {
    const struct = {
      advertiser: ADVERTISER,
      rewardPerCompletion: USDC,
      maxCompletions: 10,
      startTime: START,
      endTime: END,
      ...params,
    };
    const ref = draftRefFor(draft);
    chain.campaignStructs.set(String(onchainId), struct);
    const block = chain.mine(
      1,
      [logs.created(onchainId, struct.advertiser, ref)],
      address,
    );
    const txHash = chain.lastTxHash;
    if (address === CONTRACT) {
      chain.campaignIdByDraft.set(`${struct.advertiser.toLowerCase()}:${ref}`, {
        id: onchainId,
        block,
      });
    }
    if (confirm) chain.mine(CONFIRMATIONS);
    return txHash;
  }

  async function reconcile() {
    await indexOnce(chain, events, {
      chainId: 84532,
      contractAddress: CONTRACT,
      deployBlock: 1n,
      confirmations: CONFIRMATIONS,
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

  /** Only the indexer pass, without auto-link or status sync. */
  async function index() {
    await indexOnce(chain, events, {
      chainId: 84532,
      contractAddress: CONTRACT,
      deployBlock: 1n,
      confirmations: CONFIRMATIONS,
      maxBlockRange: 100n,
    });
  }

  return {
    app,
    chain,
    chainDeps,
    events,
    scope,
    index,
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
    const txHash = createOnchain(1, id);

    const first = await link(id, txHash);
    const retry = await link(id, txHash);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      onchainCampaignId: "1",
      publishTxHash: txHash,
      status: "pending_onchain",
    });
    expect(retry.statusCode).toBe(200);

    const other = createOnchain(2, id);
    expect((await link(id, other)).json()).toMatchObject({
      error: { code: "ALREADY_LINKED" },
    });
  });

  it("links by draft reference when no transaction hash is known", async () => {
    const { createDraft, createOnchain, app } = await setup();
    const id = await createDraft();
    const linkByDraft = () =>
      app.inject({
        method: "POST",
        url: `/v1/campaigns/${id}/onchain`,
        payload: {},
      });

    // Not created yet (or still in the mempool): reconciling, never failed.
    const before = await linkByDraft();
    expect(before.statusCode).toBe(202);
    expect(before.json()).toMatchObject({
      status: "reconciling",
      code: "NOT_CREATED_YET",
    });

    const txHash = createOnchain(4, id);
    const linked = await linkByDraft();
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({
      onchainCampaignId: "4",
      publishTxHash: null,
      status: "pending_onchain",
    });

    // Reporting the hash afterwards is the same creation, not a conflict.
    expect((await linkByDraft()).statusCode).toBe(200);
    const byHash = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/onchain`,
      payload: { txHash },
    });
    expect(byHash.statusCode).toBe(200);
  });

  it("rejects a creation that carries another draft's reference", async () => {
    const { createDraft, createOnchain, link } = await setup();
    const id = await createDraft("a");
    // Same wallet, same parameters, but created for a different draft.
    const otherDraft = await createDraft("b", {
      contentUrl: "https://example.com/b",
    });
    const response = await link(id, createOnchain(5, otherDraft));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "DRAFT_MISMATCH" },
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

    const response = await link(id, createOnchain(1, id, params));

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code } });
  });

  it("rejects events from another contract and reverted transactions", async () => {
    const { chain, createDraft, createOnchain, link } = await setup();
    const id = await createDraft();

    const foreign = createOnchain(1, id, {}, "0x" + "f".repeat(40));
    expect((await link(id, foreign)).json()).toMatchObject({
      error: { code: "NO_CAMPAIGN_CREATED_EVENT" },
    });

    const reverted = createOnchain(2, id);
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
    const txHash = createOnchain(1, first);

    expect((await link(first, txHash)).statusCode).toBe(200);
    // The event names the first draft, so the second can never claim it.
    expect((await link(second, txHash)).json()).toMatchObject({
      error: { code: "DRAFT_MISMATCH" },
    });
  });
});

describe("confirmation and reorgs (ADR-0011)", () => {
  it("links a creation only once it is buried under the confirmation depth", async () => {
    const { app, chain, createDraft, createOnchain, link } = await setup();
    const id = await createDraft();
    const txHash = createOnchain(1, id, {}, CONTRACT, false);
    const linkByDraft = () =>
      app.inject({
        method: "POST",
        url: `/v1/campaigns/${id}/onchain`,
        payload: {},
      });

    // Mined but not final: reconciling, never a permanent link.
    expect((await link(id, txHash)).json()).toMatchObject({
      status: "reconciling",
      code: "TX_UNCONFIRMED",
    });
    expect((await linkByDraft()).json()).toMatchObject({
      status: "reconciling",
      code: "NOT_CREATED_YET",
    });

    chain.mine(CONFIRMATIONS);
    expect((await linkByDraft()).statusCode).toBe(200);
  });

  it("never syncs, and then releases, a link whose creation a reorg replaced", async () => {
    const fixture = await setup();
    const { chain, campaigns, createDraft, createOnchain, index } = fixture;
    const draftA = await createDraft("a");
    const draftB = await createDraft("b", {
      contentUrl: "https://example.com/b",
    });

    // A's creation gets id 1 and is linked once confirmed.
    const reorgFrom = chain.head + 1n;
    const txA = createOnchain(1, draftA);
    expect((await fixture.link(draftA, txA)).statusCode).toBe(200);

    // A reorg deeper than the confirmation depth removes it; on the new
    // fork draft B's creation takes id 1 and is funded.
    chain.reorg(reorgFrom);
    createOnchain(1, draftB);
    chain.mine(1, [logs.funded(1, 10n * USDC)]);
    chain.mine(CONFIRMATIONS + 1);
    await index();

    // B's funding is never applied to A.
    const sync = await syncCampaignStatuses({
      campaigns,
      events: fixture.events,
      chain: fixture.scope,
      now: () => new Date(),
    });
    expect(sync.orphanedLinks).toEqual([draftA]);
    expect((await campaigns.getById(draftA))?.status).toBe("pending_onchain");

    // The canonical creation names B: A's link is released, B is linked.
    const autoLinked = await autoLinkCreatedCampaigns({
      campaigns,
      ...fixture.chainDeps,
    });
    expect(autoLinked.relinked).toEqual([draftA]);
    expect(await campaigns.getById(draftA)).toMatchObject({
      onchainCampaignId: null,
      onchainContractAddress: null,
      status: "draft",
    });
    expect((await campaigns.getById(draftB))?.onchainCampaignId).toBe("1");
  });
});

describe("on-chain reconciliation", () => {
  it("activates a campaign only from confirmed funding", async () => {
    const { chain, campaigns, createDraft, createOnchain, link, reconcile } =
      await setup();
    const id = await createDraft();
    await link(id, createOnchain(1, id));

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
    createOnchain(7, id);
    chain.mine(1, [logs.funded(7, 10n * USDC)]);
    chain.mine(3);

    await reconcile();

    expect(await campaigns.getById(id)).toMatchObject({
      onchainCampaignId: "7",
      status: "active",
    });
  });

  it("links the draft named by the event even between identical drafts", async () => {
    const { chain, campaigns, createDraft, createOnchain, reconcile } =
      await setup();
    const first = await createDraft("a");
    const second = await createDraft("b", {
      contentUrl: "https://example.com/b",
    });
    createOnchain(3, second);
    chain.mine(3);

    await reconcile();

    expect((await campaigns.getById(first))?.onchainCampaignId).toBeNull();
    expect((await campaigns.getById(second))?.onchainCampaignId).toBe("3");
  });

  it("ignores creations that name no known draft", async () => {
    const { chain, campaigns, createDraft, reconcile } = await setup();
    const id = await createDraft();
    // Same advertiser and parameters, but created outside this platform.
    chain.campaignStructs.set("6", {
      advertiser: ADVERTISER,
      rewardPerCompletion: USDC,
      maxCompletions: 10,
      startTime: START,
      endTime: END,
    });
    chain.mine(1, [logs.created(6, ADVERTISER)]);
    chain.mine(3);

    await reconcile();

    expect((await campaigns.getById(id))?.onchainCampaignId).toBeNull();
  });
});

describe("campaigns of a retired deployment (ADR-0011)", () => {
  const OLD_CONTRACT = "0x" + "0d".repeat(20);

  /** An active campaign linked on the contract used before a redeploy. */
  async function retiredCampaign() {
    const fixture = await setup();
    const id = await fixture.createDraft();
    await fixture.campaigns.linkOnchain(id, {
      onchainCampaignId: "1",
      contractAddress: OLD_CONTRACT,
      publishTxHash: "0x" + "ab".repeat(32),
      status: "active",
      updatedAt: new Date("2026-10-05T10:00:00.000Z"),
    });
    fixture.setNow(new Date(Date.parse(draft.startAt) + 60_000));
    return { ...fixture, id };
  }

  it("accepts no new World ID verification or completion", async () => {
    const { app, id } = await retiredCampaign();
    const post = (url: string, payload: unknown, headers = {}) =>
      app.inject({ method: "POST", url, payload: payload as object, headers });

    // Still "active" in the database, but its rewards could only be signed
    // for on the old contract, so participants must not start or finish it.
    expect(
      (await post(`/v1/campaigns/${id}/world-id/request`, {})).json(),
    ).toMatchObject({ error: { code: "CAMPAIGN_NOT_OPEN" } });
    expect(
      (
        await post(`/v1/campaigns/${id}/eligibility/verify`, {
          claimant: CLAIMANT,
          idkitResponse: { action: `vham-campaign-${id}` },
        })
      ).json(),
    ).toMatchObject({ error: { code: "CAMPAIGN_NOT_OPEN" } });
    expect(
      (
        await post(
          `/v1/campaigns/${id}/submissions`,
          {
            eligibilityToken: "00000000-0000-4000-8000-000000000000",
            claimant: CLAIMANT,
            answers: [{ questionId: "q1", choiceId: "a" }],
          },
          { "idempotency-key": "retired" },
        )
      ).json(),
    ).toMatchObject({ error: { code: "CAMPAIGN_NOT_ACTIVE" } });
  });

  it("does not accept the old creation hash as this contract's link", async () => {
    const { link, id } = await retiredCampaign();

    expect((await link(id, "0x" + "ab".repeat(32))).json()).toMatchObject({
      error: { code: "ALREADY_LINKED" },
    });
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
    await link(id, createOnchain(1, id));
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
    await link(id, createOnchain(1, id, { maxCompletions: 2 }));
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
