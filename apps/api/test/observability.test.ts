import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryChainEventRepository } from "../src/chain/events-repository.js";
import type { ChainRpc } from "../src/chain/rpc.js";
import {
  generateRequestId,
  LOGGER_REDACT_PATHS,
  registerInstrumentation,
} from "../src/observability/instrumentation.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { PayoutAnomalyDetector } from "../src/observability/payout-anomaly.js";
import { signedInAs } from "./support/auth.js";

const closers: { close(): Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((app) => app.close()));
});

const AUTHORIZATION_ROUTE =
  "/v1/campaigns/:id/submissions/:submissionId/authorization";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

describe("MetricsRegistry", () => {
  it("renders Prometheus text with sorted, escaped labels", () => {
    const metrics = new MetricsRegistry();
    const counter = metrics.counter("vham_test_total", "Test counter");
    counter.inc({ route: "/a", method: "GET" });
    counter.inc({ method: "GET", route: "/a" }, 2);
    counter.inc({ route: 'quote"back\\slash\nline' });
    metrics.gauge("vham_test_gauge", "Test gauge").set(7);

    expect(
      metrics.value("vham_test_total", { route: "/a", method: "GET" }),
    ).toBe(3);
    expect(metrics.render()).toBe(
      [
        "# HELP vham_test_total Test counter",
        "# TYPE vham_test_total counter",
        'vham_test_total{method="GET",route="/a"} 3',
        'vham_test_total{route="quote\\"back\\\\slash\\nline"} 1',
        "# HELP vham_test_gauge Test gauge",
        "# TYPE vham_test_gauge gauge",
        "vham_test_gauge 7",
        "",
      ].join("\n"),
    );
  });

  it("rejects invalid metric names", () => {
    expect(() => new MetricsRegistry().counter("bad name", "x")).toThrow();
  });
});

describe("request ids", () => {
  it("accepts a well-formed caller id and replaces anything else", () => {
    expect(
      generateRequestId({ headers: { "x-request-id": "abc-123.XYZ_9" } }),
    ).toBe("abc-123.XYZ_9");

    for (const value of [
      "short",
      "has space here",
      "x".repeat(129),
      undefined,
    ]) {
      const id = generateRequestId({ headers: { "x-request-id": value } });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("echoes the request id on every response", async () => {
    const app = buildApp();
    closers.push(app);

    const propagated = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "trace-0001" },
    });
    expect(propagated.headers["x-request-id"]).toBe("trace-0001");

    const generated = await app.inject({ method: "GET", url: "/nope" });
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("outcome metrics", () => {
  it("counts critical-path outcomes by error code", async () => {
    const metrics = new MetricsRegistry();
    const app = buildApp({ metrics, authenticate: signedInAs() });
    closers.push(app);

    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${CAMPAIGN}/submissions/${CAMPAIGN}/authorization`,
      payload: {},
    });
    await app.inject({
      method: "POST",
      url: `/v1/campaigns/${CAMPAIGN}/eligibility/verify`,
      payload: {},
    });

    const text = metrics.render();
    expect(text).toMatch(
      /vham_claim_authorizations_total\{outcome="[A-Z_]+"\} 1/,
    );
    expect(text).toMatch(
      /vham_eligibility_verifications_total\{outcome="[A-Z_]+"\} 1/,
    );
    expect(text).toContain(
      `vham_http_requests_total{method="POST",route="${AUTHORIZATION_ROUTE}"`,
    );
    // Unmatched routes collapse into one series (bounded cardinality).
    await app.inject({ method: "GET", url: `/random/${CAMPAIGN}` });
    expect(metrics.render()).toContain('route="unmatched"');
    expect(metrics.render()).not.toContain(`/random/${CAMPAIGN}`);
  });
});

describe("GET /metrics", () => {
  it("requires the bearer token when configured", async () => {
    const app = buildApp({ metricsToken: "scrape-token-123456" });
    closers.push(app);

    expect(
      (await app.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer scrape-token-123456" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("# TYPE vham_http_requests_total counter");
  });
});

describe("payout anomaly alert", () => {
  it("flags bursts per campaign and globally, then recovers", () => {
    const detector = new PayoutAnomalyDetector({
      windowMs: 60_000,
      perCampaign: 2,
      global: 3,
    });
    const at = (seconds: number) => new Date(seconds * 1000);

    expect(detector.record("a", at(0))).toEqual([]);
    expect(detector.record("a", at(1))).toEqual([]);
    expect(detector.record("a", at(2))).toEqual([
      { scope: "campaign", campaignId: "a", count: 3, limit: 2 },
    ]);
    expect(detector.record("b", at(3))).toEqual([
      { scope: "global", campaignId: null, count: 4, limit: 3 },
    ]);
    // Window slid past the burst.
    expect(detector.record("a", at(120))).toEqual([]);
  });

  it("increments the alert metric and logs on a burst of issued authorizations", async () => {
    const logs: Record<string, unknown>[] = [];
    const app = Fastify({
      logger: {
        level: "warn",
        stream: { write: (line: string) => logs.push(JSON.parse(line)) },
      },
    });
    closers.push(app);
    const metrics = new MetricsRegistry();

    registerInstrumentation(app, {
      metrics,
      payoutAnomalies: new PayoutAnomalyDetector({
        windowMs: 60_000,
        perCampaign: 2,
        global: 100,
      }),
      metricsToken: null,
      now: () => new Date("2026-10-13T00:00:00.000Z"),
    });
    app.post(AUTHORIZATION_ROUTE, async (_request, reply) =>
      reply.status(201).send({ signature: "0xsecret" }),
    );

    for (let index = 0; index < 3; index += 1) {
      await app.inject({
        method: "POST",
        url: `/v1/campaigns/${CAMPAIGN}/submissions/s${index}/authorization`,
      });
    }

    expect(
      metrics.value("vham_payout_anomalies_total", { scope: "campaign" }),
    ).toBe(1);
    const alert = logs.find((line) => line.alert === "payout_anomaly");
    expect(alert).toMatchObject({ campaignId: CAMPAIGN, count: 3, limit: 2 });
    expect(JSON.stringify(logs)).not.toContain("0xsecret");
  });
});

describe("log redaction", () => {
  it("never logs credentials or session cookies", () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        redact: { paths: LOGGER_REDACT_PATHS, censor: "[redacted]" },
        // Fastify's default req/res serializers drop headers before redaction.
        serializers: {
          req: (value: { headers?: unknown }) => value,
          res: (value: { headers?: unknown }) => value,
        },
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    closers.push(app);

    app.log.info(
      {
        req: {
          headers: {
            authorization: "Bearer secret-1",
            cookie: "__Host-vham_session=secret-2",
          },
        },
        res: {
          headers: { "set-cookie": "__Host-vham_session=secret-3; Path=/" },
        },
        headers: { "set-cookie": ["__Host-vham_session=secret-4"] },
      },
      "headers",
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/secret-\d/);
  });
});

describe("readiness with a chain", () => {
  function chainDeps(
    rpc: Pick<ChainRpc, "blockNumber">,
    events = new InMemoryChainEventRepository(),
  ) {
    return {
      rpc: rpc as ChainRpc,
      chain: {
        chainId: 84532,
        contractAddress: "0x" + "c0".repeat(20),
        usdcAddress: "0x" + "d0".repeat(20),
      },
      events,
      now: () => new Date(),
    };
  }

  it("reports chain status and indexer lag without leaking details", async () => {
    const metrics = new MetricsRegistry();
    const app = buildApp({
      metrics,
      chain: chainDeps({ blockNumber: async () => 120n }),
    });
    closers.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: { process: "ok", database: "ok", chain: "ok" },
      indexerLagBlocks: null,
    });
    expect(metrics.value("vham_chain_head_block")).toBe(120);
    expect(metrics.value("vham_rpc_up")).toBe(1);
  });

  it("returns 503 when the RPC is down", async () => {
    const metrics = new MetricsRegistry();
    const app = buildApp({
      metrics,
      chain: chainDeps({
        blockNumber: async () => {
          throw new Error(
            "connect ECONNREFUSED https://rpc.secret.example/key",
          );
        },
      }),
    });
    closers.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "error",
      checks: { process: "ok", database: "ok", chain: "error" },
    });
    expect(response.body).not.toContain("secret");
    expect(metrics.value("vham_rpc_up")).toBe(0);
  });
});
