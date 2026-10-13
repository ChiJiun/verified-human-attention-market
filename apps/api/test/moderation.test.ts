import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { Authenticate } from "../src/auth/siwe.js";
import type { ModerationConfig } from "../src/moderation/routes.js";
import { checkContentUrl } from "../src/moderation/url-policy.js";

const ADVERTISER = "0x1234567890abcdef1234567890abcdef12345678";
const TRUSTED = "0x" + "77".repeat(20);
const OPERATOR = "0x" + "0e".repeat(20);
const STRANGER = "0x" + "5a".repeat(20);

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Bearer token = wallet address (test-only authenticator). */
const byToken: Authenticate = async (request) => {
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  return token
    ? {
        sessionId: "00000000-0000-4000-8000-000000000001",
        address: token.toLowerCase(),
        chainId: 84532,
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      }
    : null;
};

const as = (address: string) => ({ authorization: `Bearer ${address}` });

function setup(config: Partial<ModerationConfig> = {}) {
  const app = buildApp({
    authenticate: byToken,
    moderation: {
      mode: "review",
      operators: [OPERATOR],
      advertiserAllowlist: [TRUSTED],
      ...config,
    },
    contentUrlPolicy: { allowedDomains: null },
    now: () => new Date("2026-10-05T10:00:00.000Z"),
  });
  apps.push(app);

  let key = 0;
  async function create(advertiser = ADVERTISER, contentUrl?: string) {
    key += 1;
    return app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { ...as(advertiser), "idempotency-key": `moderation-${key}` },
      payload: {
        advertiser,
        contentUrl: contentUrl ?? "https://example.com/sponsored",
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
      },
    });
  }

  async function campaign(advertiser = ADVERTISER) {
    const response = await create(advertiser);
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  const mission = (id: string) =>
    app.inject({ method: "GET", url: `/v1/campaigns/${id}/mission` });

  const moderate = (
    id: string,
    action: string,
    by = OPERATOR,
    extra: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/admin/campaigns/${id}/moderation`,
      headers: as(by),
      payload: { action, reason: "checked the landing page", ...extra },
    });

  return { app, create, campaign, mission, moderate };
}

describe("content URL policy", () => {
  it.each([
    ["https://example.com/a?b=c", null],
    ["https://sub.example.co.uk/path", null],
    ["http://example.com", "NOT_HTTPS"],
    ["javascript:alert(1)", "NOT_HTTPS"],
    ["data:text/html,hi", "NOT_HTTPS"],
    ["not a url", "NOT_HTTPS"],
    ["https://user:pass@example.com", "HAS_CREDENTIALS"],
    ["https://example.com@evil.example", "HAS_CREDENTIALS"],
    ["https://127.0.0.1/", "IP_HOST"],
    ["https://0x7f.1/", "IP_HOST"],
    ["https://[::1]/", "IP_HOST"],
    ["https://localhost/", "INTERNAL_HOST"],
    ["https://intranet/", "INTERNAL_HOST"],
    ["https://printer.local/", "INTERNAL_HOST"],
    ["https://metadata.internal/", "INTERNAL_HOST"],
    ["https://example.com:8443/", "NON_DEFAULT_PORT"],
    [`https://example.com/${"a".repeat(2100)}`, "TOO_LONG"],
  ])("%s → %s", (url, expected) => {
    expect(checkContentUrl(url)).toBe(expected);
  });

  it("enforces an optional domain allowlist", () => {
    const policy = { allowedDomains: ["example.com"] };
    expect(checkContentUrl("https://blog.example.com/x", policy)).toBeNull();
    expect(checkContentUrl("https://example.com.evil.io/", policy)).toBe(
      "DOMAIN_NOT_ALLOWED",
    );
    expect(checkContentUrl("https://notexample.com/", policy)).toBe(
      "DOMAIN_NOT_ALLOWED",
    );
  });

  it("rejects unsafe URLs at campaign creation", async () => {
    const { create } = setup();
    const response = await create(ADVERTISER, "https://127.0.0.1/phish");

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "UNSAFE_CONTENT_URL", reason: "IP_HOST" },
    });
  });
});

describe("moderation gate (review mode)", () => {
  it("does not serve or publish a campaign until an operator approves it", async () => {
    const { app, campaign, mission, moderate } = setup();
    const id = await campaign();

    for (const [method, url] of [
      ["GET", `/v1/campaigns/${id}/mission`],
      ["POST", `/v1/campaigns/${id}/eligibility/verify`],
      ["POST", `/v1/campaigns/${id}/submissions`],
      ["POST", `/v1/campaigns/${id}/publish`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: as(ADVERTISER),
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "CAMPAIGN_NOT_APPROVED" },
      });
    }

    expect((await moderate(id, "approve")).json()).toMatchObject({
      status: "approved",
    });
    expect((await mission(id)).statusCode).toBe(200);
  });

  it("starts allowlisted advertisers' campaigns approved, with an audit entry", async () => {
    const { app, campaign, mission } = setup();
    const id = await campaign(TRUSTED);

    expect((await mission(id)).statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/admin/campaigns/${id}/moderation`,
      headers: as(OPERATOR),
    });
    expect(detail.json()).toMatchObject({
      status: "approved",
      actions: [
        { action: "approve", actor: "system", reason: "advertiser allowlist" },
      ],
    });
  });

  it("still returns 404 for unknown campaigns", async () => {
    const { mission } = setup();
    const response = await mission("00000000-0000-4000-8000-000000000999");
    expect(response.statusCode).toBe(404);
  });

  it("takes a campaign down and reinstates it, keeping claims ungated", async () => {
    const { app, campaign, mission, moderate } = setup();
    const id = await campaign(TRUSTED);

    expect((await moderate(id, "take_down")).json()).toMatchObject({
      status: "taken_down",
    });
    const blocked = await mission(id);
    expect(blocked.statusCode).toBe(410);
    expect(blocked.json()).toMatchObject({
      error: { code: "CAMPAIGN_TAKEN_DOWN" },
    });

    // Already-completed work stays payable: the claim route is not gated.
    const claim = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/submissions/00000000-0000-4000-8000-000000000001/authorization`,
      payload: {},
    });
    expect(claim.statusCode).not.toBe(410);
    expect(claim.statusCode).not.toBe(403);

    expect((await moderate(id, "reinstate")).json()).toMatchObject({
      status: "approved",
    });
    expect((await mission(id)).statusCode).toBe(200);
  });

  it("rejects invalid transitions", async () => {
    const { campaign, moderate } = setup();
    const id = await campaign();

    expect((await moderate(id, "reinstate")).json()).toMatchObject({
      error: { code: "INVALID_TRANSITION" },
    });
    expect((await moderate(id, "reject")).statusCode).toBe(200);
    expect((await moderate(id, "take_down")).statusCode).toBe(409);
    expect((await moderate(id, "approve")).statusCode).toBe(200);
    expect((await moderate(id, "reject")).statusCode).toBe(409);
  });

  it("requires an operator session and a reason for admin actions", async () => {
    const { app, campaign, moderate } = setup();
    const id = await campaign();

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/admin/moderation",
        })
      ).statusCode,
    ).toBe(401);
    expect((await moderate(id, "approve", STRANGER)).json()).toMatchObject({
      error: { code: "NOT_OPERATOR" },
    });
    // The advertiser cannot approve their own campaign.
    expect((await moderate(id, "approve", ADVERTISER)).statusCode).toBe(403);
    expect(
      (await moderate(id, "approve", OPERATOR, { reason: "" })).statusCode,
    ).toBe(400);

    const queue = await app.inject({
      method: "GET",
      url: "/v1/admin/moderation?status=pending_review",
      headers: as(OPERATOR),
    });
    expect(queue.json()).toMatchObject({
      items: [{ campaignId: id, contentUrl: "https://example.com/sponsored" }],
    });
  });
});

describe("reports and disputes", () => {
  it("accepts anonymous reports and lets operators act on and resolve them", async () => {
    const { app, campaign, moderate } = setup();
    const id = await campaign(TRUSTED);

    const report = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/reports`,
      payload: { reason: "phishing", details: "asks for a seed phrase" },
    });
    expect(report.statusCode).toBe(201);
    const reportId = report.json<{ reportId: string }>().reportId;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/campaigns/${id}/reports`,
          payload: { reason: "spam?" },
        })
      ).statusCode,
    ).toBe(400);

    const open = await app.inject({
      method: "GET",
      url: "/v1/admin/reports",
      headers: as(OPERATOR),
    });
    expect(open.json()).toMatchObject({
      items: [{ id: reportId, reason: "phishing", status: "open" }],
    });

    expect(
      (await moderate(id, "take_down", OPERATOR, { reportId })).statusCode,
    ).toBe(200);

    const resolve = (by = OPERATOR) =>
      app.inject({
        method: "POST",
        url: `/v1/admin/reports/${reportId}/resolve`,
        headers: as(by),
        payload: { resolution: "actioned", reason: "confirmed phishing" },
      });
    expect((await resolve(STRANGER)).statusCode).toBe(403);
    expect((await resolve()).json()).toMatchObject({ status: "actioned" });
    expect((await resolve()).json()).toMatchObject({
      error: { code: "REPORT_ALREADY_RESOLVED" },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/admin/campaigns/${id}/moderation`,
      headers: as(OPERATOR),
    });
    const actions = detail.json<{
      actions: { action: string; actor: string; reportId: string | null }[];
    }>().actions;
    expect(actions.map((action) => action.action)).toEqual([
      "approve",
      "take_down",
      "resolve_report",
    ]);
    expect(actions[1]).toMatchObject({
      actor: `operator:${OPERATOR}`,
      reportId,
    });
  });

  it("returns 404 for reports on unknown campaigns", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-4000-8000-000000000999/reports",
      payload: { reason: "scam" },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("open mode (local demos)", () => {
  it("serves new campaigns immediately but honours take-downs", async () => {
    const { campaign, mission, moderate } = setup({ mode: "open" });
    const id = await campaign();

    expect((await mission(id)).statusCode).toBe(200);
    expect((await moderate(id, "take_down")).statusCode).toBe(200);
    expect((await mission(id)).statusCode).toBe(410);
  });
});
