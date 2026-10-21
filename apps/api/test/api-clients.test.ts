import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryApiClientRepository } from "../src/api-clients/repository.js";
import { FixedWindowRateLimiter } from "../src/api-clients/rate-limit.js";
import type { RateLimitConfig } from "../src/api-clients/routes.js";
import { buildApp } from "../src/app.js";
import type { Authenticate } from "../src/auth/siwe.js";
import { ERROR_CATALOG } from "../src/errors/catalog.js";
import { MetricsRegistry } from "../src/observability/metrics.js";

const ADVERTISER = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER = "0x" + "5a".repeat(20);
const OPERATOR = "0x" + "0e".repeat(20);
const UNKNOWN_CAMPAIGN = "00000000-0000-4000-8000-000000000999";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Test-only SIWE stand-in: "Bearer siwe-<address>". */
const siwe: Authenticate = async (request) => {
  const match = /^Bearer siwe-(0x[0-9a-f]{40})$/.exec(
    request.headers.authorization ?? "",
  );
  return match
    ? {
        sessionId: "00000000-0000-4000-8000-000000000001",
        address: match[1]!,
        chainId: 84532,
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      }
    : null;
};

const as = (address: string) => ({ authorization: `Bearer siwe-${address}` });
const withKey = (key: string) => ({ authorization: `Bearer ${key}` });

function setup(
  options: {
    rateLimits?: RateLimitConfig | null;
    chainId?: number;
    trustProxyHops?: number;
    clients?: InMemoryApiClientRepository;
    metrics?: MetricsRegistry;
  } = {},
) {
  let now = new Date("2026-10-05T10:00:00.000Z");
  const app = buildApp({
    authenticate: siwe,
    apiClientRepository: options.clients ?? new InMemoryApiClientRepository(),
    rateLimits: options.rateLimits ?? null,
    metrics: options.metrics ?? new MetricsRegistry(),
    chainId: options.chainId ?? 84532,
    trustProxyHops: options.trustProxyHops ?? 0,
    moderation: {
      mode: "open",
      operators: [OPERATOR],
      advertiserAllowlist: [],
    },
    now: () => now,
  });
  apps.push(app);

  async function createKey(
    scopes: string[] = ["campaigns:write"],
    owner = ADVERTISER,
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/api-clients",
      headers: as(owner),
      payload: { name: "agency integration", scopes },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string; key: string; keyPrefix: string }>();
  }

  let idempotency = 0;
  const createCampaign = (
    headers: Record<string, string>,
    advertiser = ADVERTISER,
  ) => {
    idempotency += 1;
    return app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { ...headers, "idempotency-key": `api-client-${idempotency}` },
      payload: {
        advertiser,
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
      },
    });
  };

  return {
    app,
    createKey,
    createCampaign,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe("API clients (#26)", () => {
  it("issues a key once and lets it act as its advertiser within its scopes", async () => {
    const { app, createKey, createCampaign } = setup();
    const created = await createKey(["campaigns:write"]);

    expect(created.key).toMatch(/^vhamk_test_[A-Za-z0-9_-]{43}$/);
    expect(created.key.startsWith(created.keyPrefix)).toBe(true);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/api-clients",
      headers: as(ADVERTISER),
    });
    expect(listed.body).not.toContain(created.key);
    expect(listed.json()).toMatchObject({
      items: [{ id: created.id, scopes: ["campaigns:write"], revokedAt: null }],
    });

    const campaign = await createCampaign(withKey(created.key));
    expect(campaign.statusCode).toBe(201);
    const campaignId = campaign.json<{ id: string }>().id;

    // Only as its own advertiser.
    expect(
      (await createCampaign(withKey(created.key), OTHER)).json(),
    ).toMatchObject({ error: { code: "NOT_CAMPAIGN_ADVERTISER" } });

    // Missing scope.
    const analytics = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/analytics`,
      headers: withKey(created.key),
    });
    expect(analytics.statusCode).toBe(403);
    expect(analytics.json()).toMatchObject({
      error: { code: "INSUFFICIENT_SCOPE", retryable: false },
    });
  });

  it("never reaches key management, sessions or operator endpoints", async () => {
    const { app, createKey } = setup();
    const { key, id } = await createKey(["campaigns:write", "analytics:read"]);

    for (const [method, url] of [
      ["GET", "/v1/api-clients"],
      ["POST", "/v1/api-clients"],
      ["GET", "/v1/auth/session"],
      ["GET", "/v1/admin/moderation"],
      ["POST", `/v1/admin/api-clients/${id}/revoke`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: withKey(key),
        ...(method === "POST" ? { payload: {} } : {}),
      });
      expect(response.json()).toMatchObject({
        error: { code: "API_KEY_NOT_ALLOWED" },
      });
    }
  });

  it("rejects unknown, malformed, revoked and wrong-environment keys", async () => {
    const clients = new InMemoryApiClientRepository();
    const { app, createKey, createCampaign } = setup({ clients });
    const { key, id } = await createKey();

    expect(
      (await createCampaign(withKey(`vhamk_test_${"A".repeat(43)}`))).json(),
    ).toMatchObject({ error: { code: "INVALID_API_KEY" } });
    expect(
      (
        await createCampaign(withKey("vhamk_test_short_but_long_enough"))
      ).json(),
    ).toMatchObject({ error: { code: "INVALID_API_KEY" } });

    // A sandbox key is useless against a live deployment.
    const live = setup({ clients, chainId: 8453 });
    expect((await live.createCampaign(withKey(key))).json()).toMatchObject({
      error: { code: "API_KEY_WRONG_ENVIRONMENT" },
    });

    // Another advertiser cannot revoke it; the owner can.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/api-clients/${id}`,
          headers: as(OTHER),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/v1/api-clients/${id}`,
          headers: as(ADVERTISER),
        })
      ).statusCode,
    ).toBe(204);
    expect((await createCampaign(withKey(key))).statusCode).toBe(401);
  });

  it("lets operators revoke any key with a reason (abuse path)", async () => {
    const { app, createKey, createCampaign } = setup();
    const { key, id } = await createKey();
    const revoke = (by: string, payload: object) =>
      app.inject({
        method: "POST",
        url: `/v1/admin/api-clients/${id}/revoke`,
        headers: as(by),
        payload,
      });

    expect((await revoke(OTHER, { reason: "spam" })).statusCode).toBe(403);
    expect((await revoke(OPERATOR, {})).statusCode).toBe(400);
    const revoked = await revoke(OPERATOR, { reason: "scraping abuse" });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<{ revokedAt: string | null }>().revokedAt).not.toBe(
      null,
    );
    expect((await createCampaign(withKey(key))).json()).toMatchObject({
      error: { code: "INVALID_API_KEY" },
    });
  });

  it("validates key requests and caps active keys per advertiser", async () => {
    const { app, createKey } = setup();
    const create = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/v1/api-clients",
        headers: as(ADVERTISER),
        payload,
      });

    expect((await create({ name: "x", scopes: [] })).statusCode).toBe(400);
    expect((await create({ name: "x", scopes: ["admin"] })).statusCode).toBe(
      400,
    );
    expect(
      (
        await create({
          name: "x",
          scopes: ["campaigns:write"],
          rateLimitPerMinute: 1_000_000,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/api-clients",
          payload: { name: "x", scopes: ["campaigns:write"] },
        })
      ).statusCode,
    ).toBe(401);

    for (let index = 0; index < 10; index += 1) await createKey();
    expect(
      (await create({ name: "x", scopes: ["campaigns:write"] })).json(),
    ).toMatchObject({ error: { code: "API_CLIENT_LIMIT_REACHED" } });
  });
});

describe("rate limits (#26)", () => {
  const limits: RateLimitConfig = {
    anonymousPerMinute: 3,
    sensitivePerMinute: 2,
    defaultClientPerMinute: 2,
    maxClientPerMinute: 10,
  };

  it("limits anonymous traffic per IP with standard headers", async () => {
    const metrics = new MetricsRegistry();
    const { app, advance } = setup({ rateLimits: limits, metrics });
    const get = (ip = "203.0.113.7") =>
      app.inject({
        method: "GET",
        url: `/v1/campaigns/${UNKNOWN_CAMPAIGN}`,
        remoteAddress: ip,
      });

    for (let index = 0; index < 3; index += 1) {
      expect((await get()).statusCode).toBe(404);
    }

    const limited = await get();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
    expect(limited.json()).toMatchObject({
      error: { code: "RATE_LIMITED", retryable: true },
    });
    expect(metrics.value("vham_rate_limited_total", { bucket: "ip" })).toBe(1);

    // Other clients and health checks are unaffected; windows reset.
    expect((await get("198.51.100.1")).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/health/live",
          remoteAddress: "203.0.113.7",
        })
      ).statusCode,
    ).toBe(200);
    advance(60_000);
    expect((await get()).statusCode).toBe(404);
  });

  it("keys per-IP limits on the client address behind trusted proxies", async () => {
    const { app } = setup({ rateLimits: limits, trustProxyHops: 1 });
    const get = (forwardedFor: string) =>
      app.inject({
        method: "GET",
        url: `/v1/campaigns/${UNKNOWN_CAMPAIGN}`,
        remoteAddress: "10.0.0.2",
        headers: { "x-forwarded-for": forwardedFor },
      });

    // Spoofed left-most entries do not create fresh buckets.
    for (let index = 0; index < 3; index += 1) {
      expect((await get(`9.9.9.${index}, 203.0.113.50`)).statusCode).toBe(404);
    }
    expect((await get("9.9.9.99, 203.0.113.50")).statusCode).toBe(429);
    // A different client behind the same proxy has its own bucket.
    expect((await get("203.0.113.51")).statusCode).toBe(404);
  });

  it("applies a stricter bucket to sign-in, eligibility and reports", async () => {
    const { app } = setup({ rateLimits: limits });
    const nonce = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/nonce",
        remoteAddress: "203.0.113.9",
      });

    expect((await nonce()).statusCode).toBe(200);
    expect((await nonce()).statusCode).toBe(200);
    expect((await nonce()).json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
  });

  it("limits each API client by its own quota", async () => {
    const { createKey, createCampaign } = setup({ rateLimits: limits });
    const { key } = await createKey();

    expect((await createCampaign(withKey(key))).statusCode).toBe(201);
    expect((await createCampaign(withKey(key))).statusCode).toBe(201);
    expect((await createCampaign(withKey(key))).statusCode).toBe(429);
  });

  it("bounds memory under many keys", () => {
    const limiter = new FixedWindowRateLimiter(60_000, 100);
    const now = new Date("2026-10-05T10:00:00.000Z");
    for (let index = 0; index < 1_000; index += 1) {
      limiter.check(`ip:${index}`, 5, now);
    }
    expect(limiter.check("ip:new", 5, now).allowed).toBe(true);
  });
});

describe("error model (#26)", () => {
  it("adds retryable and requestId to every error", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${UNKNOWN_CAMPAIGN}`,
      headers: { "x-request-id": "trace-error-1" },
    });

    expect(response.json()).toEqual({
      error: {
        code: "CAMPAIGN_NOT_FOUND",
        message: expect.any(String),
        requestId: "trace-error-1",
        retryable: false,
      },
    });
  });

  it("catalogs every error code used by the API", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    // Files whose upper-case literals are env names or non-error reasons.
    const skip = new Set([
      "server.ts",
      "indexer-worker.ts",
      "url-policy.ts",
      "config.ts",
      "rpc.ts",
      "signer.ts",
      "world-id.ts",
      "world-id-config.ts",
      "catalog.ts",
      // Reconciliation finding kinds, not HTTP error codes.
      "check.ts",
      // Quality reason codes are analytics data, not HTTP error codes.
      "signals.ts",
    ]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !skip.has(name)) files.push(path);
      }
    };
    walk(root);

    const missing = new Set<string>();
    for (const file of files) {
      for (const [, code] of readFileSync(file, "utf8").matchAll(
        /"([A-Z][A-Z0-9_]{3,})"/g,
      )) {
        if (!(code! in ERROR_CATALOG)) missing.add(code!);
      }
    }

    expect([...missing]).toEqual([]);
  });
});
