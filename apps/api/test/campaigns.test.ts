import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
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
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("campaign routes", () => {
  it("creates and retrieves a campaign draft", async () => {
    const repository = new InMemoryCampaignRepository();
    const app = buildApp({
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
    const app = buildApp({ now: () => now });
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
    const app = buildApp({ now: () => now });
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
    const app = buildApp({ now: () => now });
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
    const app = buildApp({ now: () => now });
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
    const app = buildApp({ now: () => now });
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
    const app = buildApp({ now: () => now });
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
});
