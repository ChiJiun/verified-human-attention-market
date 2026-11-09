import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

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

/**
 * A registry that counts the metrics it is asked for and throws on call
 * `failAt` instead, as a build that fails there would.
 */
function failingRegistry(failAt = Infinity) {
  const metrics = new MetricsRegistry();
  let calls = 0;
  const count = () => {
    calls += 1;
    if (calls === failAt) throw new Error("build failed");
  };
  const gauge = metrics.gauge.bind(metrics);
  const counter = metrics.counter.bind(metrics);
  vi.spyOn(metrics, "gauge").mockImplementation((name, help) => {
    count();
    return gauge(name, help);
  });
  vi.spyOn(metrics, "counter").mockImplementation((name, help) => {
    count();
    return counter(name, help);
  });
  return { metrics, calls: () => calls };
}

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

  it("refuses a registry another open app uses, and frees it on close", async () => {
    // Each app orders its own chain and halt reads; two on one registry
    // would write the same gauges out of order.
    const metrics = new MetricsRegistry();
    const first = buildApp({ metrics });
    closers.push(first);
    expect(() => buildApp({ metrics })).toThrow(/used by another open app/);

    // Closed without ever being ready: the registry is free again.
    await first.close();
    const second = buildApp({ metrics });
    closers.push(second);
    expect(
      (await second.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(200);
  });

  it("leaves the registry free when building the app throws", () => {
    // A build asks for its first metric right after the registry check and
    // for its last in registerInstrumentation, late in the build.
    const probe = failingRegistry();
    closers.push(buildApp({ metrics: probe.metrics }));
    const last = probe.calls();
    expect(last).toBeGreaterThan(4);

    for (const failAt of [1, last]) {
      const { metrics } = failingRegistry(failAt);
      expect(() => buildApp({ metrics })).toThrow("build failed");
      closers.push(buildApp({ metrics }));
    }
  });

  it("frees the registry before the dependencies close", async () => {
    const metrics = new MetricsRegistry();
    const reused: ReturnType<typeof buildApp>[] = [];
    const first = buildApp({
      metrics,
      close: async () => {
        reused.push(buildApp({ metrics }));
      },
    });
    await first.close();
    expect(reused).toHaveLength(1);
    closers.push(...reused);
  });

  it("frees the registry on close even when closing the database fails", async () => {
    const metrics = new MetricsRegistry();
    const first = buildApp({
      metrics,
      close: async () => {
        throw new Error("database close failed");
      },
    });
    await expect(first.close()).rejects.toThrow("database close failed");

    const second = buildApp({ metrics });
    closers.push(second);
    expect(
      (await second.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(200);
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

  it("exports the lag of the stored cursor, and none once the index is reset", async () => {
    const metrics = new MetricsRegistry();
    const deps = chainDeps({ blockNumber: async () => 120n });
    const app = buildApp({ metrics, chain: deps });
    closers.push(app);
    const lagLines = async () =>
      (await app.inject({ method: "GET", url: "/metrics" })).body
        .split("\n")
        .filter((line) => line.startsWith("vham_indexer_lag_blocks "));

    // Nothing indexed yet: no lag rather than a made-up one.
    expect(await lagLines()).toEqual([]);

    await deps.events.commitConfirmedRange(
      deps.chain,
      {
        from: 1n,
        to: 100n,
        toBlockHash: `0x${"ab".repeat(32)}`,
        expectedCursor: null,
      },
      [],
    );
    expect(await lagLines()).toEqual(["vham_indexer_lag_blocks 20"]);

    // `reorg:recover --apply` resets the index: the lag from before the
    // reset no longer holds, so it is not exported until a range commits.
    await deps.events.resetIndex(deps.chain);
    expect(await lagLines()).toEqual([]);
  });

  it("drops the head and lag it cannot read now, instead of keeping old ones", async () => {
    class UnreadableCursor extends InMemoryChainEventRepository {
      unreadable = false;
      override async getCursor(scope: ChainScope) {
        if (this.unreadable) throw new Error("database unavailable");
        return super.getCursor(scope);
      }
    }
    const events = new UnreadableCursor();
    let rpcDown = false;
    let head = 120n;
    const metrics = new MetricsRegistry();
    const deps = chainDeps(
      {
        blockNumber: async () => {
          if (rpcDown) throw new Error("RPC unavailable");
          return head;
        },
      },
      events,
    );
    const app = buildApp({ metrics, chain: deps });
    closers.push(app);
    await events.commitConfirmedRange(
      deps.chain,
      {
        from: 1n,
        to: 100n,
        toBlockHash: `0x${"ab".repeat(32)}`,
        expectedCursor: null,
      },
      [],
    );
    const exported = async () =>
      (await app.inject({ method: "GET", url: "/metrics" })).body
        .split("\n")
        .filter((line) =>
          /^vham_(chain_head_block|indexer_lag_blocks|rpc_up) /.test(line),
        )
        .sort();

    const healthy = [
      "vham_chain_head_block 120",
      "vham_indexer_lag_blocks 20",
      "vham_rpc_up 1",
    ];
    expect(await exported()).toEqual(healthy);

    // Database down: the new head is read, the lag is not.
    events.unreadable = true;
    head = 121n;
    expect(await exported()).toEqual([
      "vham_chain_head_block 121",
      "vham_rpc_up 1",
    ]);
    events.unreadable = false;
    head = 120n;
    expect(await exported()).toEqual(healthy);

    // RPC down: neither the head nor the lag holds any more.
    rpcDown = true;
    expect(await exported()).toEqual(["vham_rpc_up 0"]);
    rpcDown = false;
    expect(await exported()).toEqual(healthy);
  });

  /**
   * An app whose chain reads can be held: `hold(step)` makes the next RPC,
   * cursor or halt read wait until `release()`, and `reached` resolves once
   * it waits. The RPC answers with the head set when the read starts, and a
   * cursor or halt read fails if `db.cursorDown` or `db.haltDown` was set
   * when it started.
   */
  async function heldChainApp() {
    type Step = "rpc" | "cursor" | "halt";
    const holds = new Map<
      Step,
      { reached: () => void; released: Promise<void> }
    >();
    async function pass(step: Step) {
      const hold = holds.get(step);
      if (!hold) return;
      holds.delete(step);
      hold.reached();
      await hold.released;
    }
    const db = { cursorDown: false, haltDown: false };
    class HeldEvents extends InMemoryChainEventRepository {
      override async getCursor(scope: ChainScope) {
        const down = db.cursorDown;
        await pass("cursor");
        if (down) throw new Error("database unavailable");
        return super.getCursor(scope);
      }
      override async getHalt(scope: ChainScope) {
        const down = db.haltDown;
        await pass("halt");
        if (down) throw new Error("database unavailable");
        return super.getHalt(scope);
      }
    }
    const events = new HeldEvents();
    // null: the RPC is down.
    const rpc: { head: bigint | null } = { head: 120n };
    const deps = chainDeps(
      {
        blockNumber: async () => {
          const head = rpc.head;
          await pass("rpc");
          if (head === null) throw new Error("RPC unavailable");
          return head;
        },
      },
      events,
    );
    const app = buildApp({ metrics: new MetricsRegistry(), chain: deps });
    closers.push(app);
    await events.commitConfirmedRange(
      deps.chain,
      {
        from: 1n,
        to: 100n,
        toBlockHash: `0x${"ab".repeat(32)}`,
        expectedCursor: null,
      },
      [],
    );

    function hold(step: Step) {
      let reached!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(step, { reached, released });
      return { reached: waiting, release };
    }
    const request = (url: string) =>
      Promise.resolve(app.inject({ method: "GET", url }));
    const exported = async (scrape: ReturnType<typeof request>) =>
      (await scrape).body
        .split("\n")
        .filter((line) =>
          /^vham_(chain_head_block|indexer_lag_blocks|rpc_up) /.test(line),
        )
        .sort();
    const halted = async (scrape: ReturnType<typeof request>) =>
      (await scrape).body
        .split("\n")
        .filter((line) => line.startsWith("vham_chain_halted "));
    // Lets the reads that hold nothing finish.
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    return { rpc, db, hold, request, exported, halted, settle };
  }

  it("exports one whole read when a scrape and a readiness check overlap", async () => {
    const { rpc, hold, request, exported, settle } = await heldChainApp();

    // A readiness check that starts while the scrape waits for its cursor,
    // and finds the RPC down, is newer: the scrape exports it whole, not
    // `vham_rpc_up 0` next to the scrape's own lag.
    const cursor = hold("cursor");
    const first = request("/metrics");
    await cursor.reached;
    rpc.head = null;
    expect((await request("/health/ready")).statusCode).toBe(503);
    cursor.release();
    expect(await exported(first)).toEqual(["vham_rpc_up 0"]);

    // A readiness check that has read a new head but not its cursor yet
    // changes nothing: the scrape, waiting for the halt, exports its own.
    rpc.head = 120n;
    const halt = hold("halt");
    const second = request("/metrics");
    await halt.reached;
    await settle();
    const newer = hold("cursor");
    rpc.head = 130n;
    const ready = request("/health/ready");
    await newer.reached;
    halt.release();
    expect(await exported(second)).toEqual([
      "vham_chain_head_block 120",
      "vham_indexer_lag_blocks 20",
      "vham_rpc_up 1",
    ]);
    newer.release();
    expect((await ready).json()).toMatchObject({ indexerLagBlocks: "30" });
  });

  it("never replaces a newer read with an older one that finishes later", async () => {
    const { rpc, db, hold, request, exported, settle } = await heldChainApp();
    const healthy = [
      "vham_chain_head_block 120",
      "vham_indexer_lag_blocks 20",
      "vham_rpc_up 1",
    ];

    // A readiness check reads head 110 and waits for its cursor; a scrape
    // that starts later reads 120 and publishes it, then waits for the halt.
    rpc.head = 110n;
    const cursor = hold("cursor");
    const ready = request("/health/ready");
    await cursor.reached;
    rpc.head = 120n;
    const halt = hold("halt");
    const scrape = request("/metrics");
    await halt.reached;
    await settle();

    // The readiness check finishes with its own, older read...
    cursor.release();
    expect((await ready).json()).toMatchObject({ indexerLagBlocks: "10" });
    // ...which does not replace the scrape's.
    halt.release();
    expect(await exported(scrape)).toEqual(healthy);

    // Nor does an older one whose RPC read fails after the scrape published.
    rpc.head = null;
    const slowRpc = hold("rpc");
    const rpcFails = request("/health/ready");
    await slowRpc.reached;
    rpc.head = 120n;
    const afterRpc = hold("halt");
    const second = request("/metrics");
    await afterRpc.reached;
    await settle();
    slowRpc.release();
    expect((await rpcFails).statusCode).toBe(503);
    afterRpc.release();
    expect(await exported(second)).toEqual(healthy);

    // Nor one whose cursor read fails after the scrape published.
    db.cursorDown = true;
    const slowCursor = hold("cursor");
    const cursorFails = request("/health/ready");
    await slowCursor.reached;
    db.cursorDown = false;
    const afterCursor = hold("halt");
    const third = request("/metrics");
    await afterCursor.reached;
    await settle();
    slowCursor.release();
    expect((await cursorFails).statusCode).toBe(503);
    afterCursor.release();
    expect(await exported(third)).toEqual(healthy);
  });

  it("publishes an older read that finishes while a newer one still runs", async () => {
    const { rpc, hold, request, exported } = await heldChainApp();
    rpc.head = 110n;
    expect(await exported(request("/metrics"))).toEqual([
      "vham_chain_head_block 110",
      "vham_indexer_lag_blocks 10",
      "vham_rpc_up 1",
    ]);

    // A scrape reads 120 and waits for its cursor; a readiness check that
    // starts later reads 130 and waits for its own.
    rpc.head = 120n;
    const older = hold("cursor");
    const scrape = request("/metrics");
    await older.reached;
    rpc.head = 130n;
    const newer = hold("cursor");
    const ready = request("/health/ready");
    await newer.reached;

    // Nothing newer is published yet, so the scrape exports its own read,
    // not the one before it.
    older.release();
    expect(await exported(scrape)).toEqual([
      "vham_chain_head_block 120",
      "vham_indexer_lag_blocks 20",
      "vham_rpc_up 1",
    ]);
    newer.release();
    expect((await ready).json()).toMatchObject({ indexerLagBlocks: "30" });
  });

  it("never replaces a newer halt read with an older one that finishes later", async () => {
    const { db, hold, request, halted, settle } = await heldChainApp();

    // A readiness check whose halt read fails waits before it finishes; a
    // scrape that starts later reads no halt, then waits for its cursor.
    db.haltDown = true;
    const slowFailure = hold("halt");
    const failing = request("/health/ready");
    await slowFailure.reached;
    db.haltDown = false;
    const cursor = hold("cursor");
    const scrape = request("/metrics");
    await cursor.reached;
    await settle();
    // The older failure does not put the scrape's 0 back to 1...
    slowFailure.release();
    expect((await failing).json()).toMatchObject({
      checks: { database: "error" },
    });
    cursor.release();
    expect(await halted(scrape)).toEqual(["vham_chain_halted 0"]);

    // ...and an older success does not clear a newer failure's 1.
    const slowSuccess = hold("halt");
    const succeeding = request("/health/ready");
    await slowSuccess.reached;
    db.haltDown = true;
    const second = hold("cursor");
    const failedScrape = request("/metrics");
    await second.reached;
    await settle();
    slowSuccess.release();
    expect((await succeeding).json()).toMatchObject({ chainHalted: false });
    second.release();
    expect(await halted(failedScrape)).toEqual(["vham_chain_halted 1"]);
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
