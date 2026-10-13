import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { signedInAs } from "./support/auth.js";
import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";

const apps: ReturnType<typeof buildApp>[] = [];
const now = new Date("2026-10-05T10:00:00.000Z");

const validPayload = {
  advertiser: "0x1234567890ABCDEF1234567890ABCDEF12345678",
  contentUrl: "https://example.com/sponsored-content",
  rewardPerCompletion: "1000000",
  maxCompletions: 10,
  startAt: "2026-10-05T10:15:00.000Z",
  endAt: "2026-10-05T11:15:00.000Z",
  mission: {
    questions: [
      {
        id: "q1",
        prompt: "Which feature did the article highlight?",
        choices: [
          { id: "a", label: "Speed" },
          { id: "b", label: "Price" },
        ],
      },
      {
        id: "q2",
        prompt: "Who is the product for?",
        choices: [
          { id: "a", label: "Developers" },
          { id: "b", label: "Designers" },
        ],
      },
    ],
    answerKey: { q1: "a", q2: "b" },
  },
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("campaign routes", () => {
  it("creates and retrieves a campaign draft", async () => {
    const repository = new InMemoryCampaignRepository();
    const app = buildApp({
      authenticate: signedInAs(),
      campaignRepository: repository,
      chainId: 84532,
      now: () => now,
    });
    apps.push(app);

    const createResponse = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": "create-campaign-1",
      },
      payload: validPayload,
    });

    expect(createResponse.statusCode).toBe(201);

    const created = createResponse.json<{
      id: string;
      chainId: number;
      advertiser: string;
      rewardPerCompletion: string;
      status: string;
    }>();

    expect(created.chainId).toBe(84532);
    expect(created.advertiser).toBe(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    expect(created.rewardPerCompletion).toBe("1000000");
    expect(created.status).toBe("draft");

    const getResponse = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${created.id}`,
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      id: created.id,
      chainId: 84532,
      status: "draft",
    });
  });

  it("replays the same idempotent request without creating a second campaign", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const request = {
      method: "POST" as const,
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": "replay-key",
      },
      payload: validPayload,
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ id: string }>().id).toBe(
      first.json<{ id: string }>().id,
    );
  });

  it("rejects reuse of an idempotency key with different input", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const first = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": "conflict-key",
      },
      payload: validPayload,
    });

    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": "conflict-key",
      },
      payload: {
        ...validPayload,
        rewardPerCompletion: "2000000",
      },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
      },
    });
  });

  it("requires an idempotency key", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      payload: validPayload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_IDEMPOTENCY_KEY",
      },
    });
  });

  it("rejects a campaign that starts in the past", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": "past-key",
      },
      payload: {
        ...validPayload,
        startAt: "2026-10-05T09:00:00.000Z",
        endAt: "2026-10-05T10:30:00.000Z",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "CAMPAIGN_START_IN_PAST",
      },
    });
  });

  it("rejects floating point monetary values", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": "float-key",
      },
      payload: {
        ...validPayload,
        rewardPerCompletion: "1.5",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_CAMPAIGN",
      },
    });
  });

  it("returns 404 for unknown campaigns", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/campaigns/00000000-0000-0000-0000-000000000000",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: "CAMPAIGN_NOT_FOUND",
      },
    });
  });

  it("serves the public mission without the answer key", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const created = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "mission-key" },
      payload: validPayload,
    });
    const { id } = created.json<{ id: string }>();

    const response = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${id}/mission`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      campaignId: id,
      version: 1,
      kind: "comprehension_check",
      contentUrl: validPayload.contentUrl,
    });
    expect(body).not.toHaveProperty("answerKey");
    expect(body).not.toHaveProperty("passThreshold");
    expect(response.body).not.toContain("answerKey");
  });

  it("treats answer key ordering as the same idempotent request", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const first = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "order-key" },
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "order-key" },
      payload: {
        ...validPayload,
        mission: {
          ...validPayload.mission,
          answerKey: { q2: "b", q1: "a" },
        },
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json<{ id: string }>().id).toBe(
      first.json<{ id: string }>().id,
    );
  });

  it("rejects a changed mission under the same idempotency key", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "mission-conflict" },
      payload: validPayload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "mission-conflict" },
      payload: {
        ...validPayload,
        mission: {
          ...validPayload.mission,
          answerKey: { q1: "b", q2: "b" },
        },
      },
    });

    expect(second.statusCode).toBe(409);
  });

  it.each([
    ["missing answer key entry", { answerKey: { q1: "a" } }],
    [
      "answer key naming an unknown choice",
      { answerKey: { q1: "z", q2: "b" } },
    ],
    [
      "answer key naming an unknown question",
      { answerKey: { q1: "a", q2: "b", q3: "a" } },
    ],
    ["threshold above question count", { passThreshold: 3 }],
  ])("rejects an invalid mission: %s", async (_label, override) => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": `invalid-${_label}` },
      payload: {
        ...validPayload,
        mission: { ...validPayload.mission, ...override },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://example.com/plain-http",
    "file:///etc/passwd",
  ])("rejects non-https content URL %s", async (contentUrl) => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": `url-${contentUrl.length}` },
      payload: { ...validPayload, contentUrl },
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 404 instead of failing on malformed campaign ids", async () => {
    const app = buildApp({
      authenticate: signedInAs(),
      now: () => now,
    });
    apps.push(app);

    for (const url of ["/v1/campaigns/not-a-uuid", "/v1/campaigns/x/mission"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
  });
});
