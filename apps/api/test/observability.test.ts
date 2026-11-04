import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  InMemoryChainEventRepository,
  type ChainScope,
} from "../src/chain/events-repository.js";
import type { ChainRpc } from "../src/chain/rpc.js";
import {
  generateRequestId,
  LOGGER_REDACT_PATHS,
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

describe("log redaction", () => {
  it("redacts the signal salt and the proof in a logged request body", async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        redact: { paths: LOGGER_REDACT_PATHS, censor: "[redacted]" },
        stream: { write: (line: string) => lines.push(line) },
      },
    });
    closers.push(app);
    const salt = `0x${"5a".repeat(32)}`;

    app.log.info(
      {
        body: {
          claimant: `0x${"a".repeat(40)}`,
          signalSalt: salt,
          idkitResponse: { responses: [{ nullifier: "0x2b" }] },
        },
      },
      "eligibility request",
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      body: { signalSalt: "[redacted]", idkitResponse: "[redacted]" },
    });
    expect(lines[0]).not.toContain(salt.slice(2));
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
      payload: { eligibilityToken: CAMPAIGN },
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

    const refused = await app.inject({ method: "GET", url: "/metrics" });
    expect(refused.statusCode).toBe(401);
    // The catalog error body (errors/catalog.ts), like every other 401.
    expect(refused.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "A valid metrics token is required",
        requestId: refused.headers["x-request-id"],
        retryable: false,
      },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: "Bearer wrong-token" },
        })
      ).statusCode,
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
      chainHalted: false,
    });
    expect(metrics.value("vham_chain_head_block")).toBe(120);
    expect(metrics.value("vham_rpc_up")).toBe(1);
    expect(metrics.value("vham_chain_halted")).toBe(0);
  });

  it("reports a deep-reorg halt without failing readiness (#77)", async () => {
    const metrics = new MetricsRegistry();
    const deps = chainDeps({ blockNumber: async () => 120n });
    const app = buildApp({ metrics, chain: deps });
    closers.push(app);
    await deps.events.haltForReorg(deps.chain, 100n, new Date());

    // Participants get 503 CHAIN_HALTED per route; the instance still serves.
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: { process: "ok", database: "ok", chain: "ok" },
      indexerLagBlocks: null,
      chainHalted: true,
    });
    expect(metrics.value("vham_chain_halted")).toBe(1);
  });

  it("fails closed when the halt cannot be read, from the first scrape on (#77)", async () => {
    class UnreadableHalts extends InMemoryChainEventRepository {
      unreadable = true;
      override async getHalt(scope: ChainScope) {
        if (this.unreadable) throw new Error("database unavailable");
        return super.getHalt(scope);
      }
    }
    const events = new UnreadableHalts();
    const metrics = new MetricsRegistry();
    const app = buildApp({
      metrics,
      chain: chainDeps({ blockNumber: async () => 120n }, events),
    });
    closers.push(app);

    // An instance started during a database outage: 1, not a missing series.
    const scrape = await app.inject({ method: "GET", url: "/metrics" });
    expect(scrape.body).toContain("\nvham_chain_halted 1\n");

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: "error",
      checks: { process: "ok", database: "error", chain: "ok" },
      indexerLagBlocks: null,
    });

    events.unreadable = false;
    await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.value("vham_chain_halted")).toBe(0);
  });

  it("exports vham_chain_halted on every scrape while halted, RPC down or not (#77)", async () => {
    const metrics = new MetricsRegistry();
    let rpcDown = false;
    const deps = chainDeps({
      blockNumber: async () => {
        if (rpcDown) throw new Error("rpc down");
        return 120n;
      },
    });
    const app = buildApp({ metrics, chain: deps });
    closers.push(app);
    const scrape = async () =>
      (await app.inject({ method: "GET", url: "/metrics" })).body;

    expect(await scrape()).toContain("\nvham_chain_halted 0\n");

    await deps.events.haltForReorg(deps.chain, 100n, new Date());
    rpcDown = true;
    // A gauge, not a counter increase: every scrape of the halt sees 1.
    expect(await scrape()).toContain("\nvham_chain_halted 1\n");
    expect(await scrape()).toContain("\nvham_chain_halted 1\n");
    expect(metrics.value("vham_rpc_up")).toBe(0);

    // Only the worker's verified recovery clears it.
    const applied = new Date();
    await deps.events.markRecoveryApplied(deps.chain, applied);
    expect(await scrape()).toContain("\nvham_chain_halted 1\n");
    await deps.events.commitConfirmedRange(
      deps.chain,
      { from: 1n, to: 110n, toBlockHash: "0x01", expectedCursor: null },
      [],
    );
    await deps.events.clearHalt(deps.chain, {
      recoveryAppliedAt: applied,
      indexedThrough: 110n,
    });
    expect(await scrape()).toContain("\nvham_chain_halted 0\n");
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
      chainHalted: false,
    });
    expect(response.body).not.toContain("secret");
    expect(metrics.value("vham_rpc_up")).toBe(0);
  });
});
