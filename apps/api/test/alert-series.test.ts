import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { ERROR_CATALOG } from "../src/errors/catalog.js";
import { ALERTED_COUNTER_SERIES } from "../src/observability/alerted-series.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { PayoutAnomalyDetector } from "../src/observability/payout-anomaly.js";

/** The alert rules without their comment lines. */
const RULES = readFileSync(
  new URL("../../../docs/operations/alerts.yml", import.meta.url),
  "utf8",
).replace(/^\s*#.*$/gm, "");

/** Series that carry the route, so they cannot be listed ahead. */
const UNLISTABLE = new Set(["vham_http_requests_total"]);

/** Counters of the indexer worker, which exports its own registry. */
const WORKER_COUNTERS = new Set(["vham_indexer_passes_total"]);

/** Counters whose `outcome` label is an error code of the catalog. */
const OUTCOME_CODES = new Set([
  "vham_claim_authorizations_total",
  "vham_eligibility_verifications_total",
]);

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Every `increase(metric{matchers}[range])` in the alert rules. */
function increaseSelectors() {
  return [
    ...RULES.matchAll(/\bincrease\(\s*(\w+)\s*(?:\{([^}]*)\})?\s*\[/g),
  ].map(([, metric, matchers]) => ({
    metric: metric!,
    matchers: matchers ?? "",
  }));
}

/** The label sets a selector needs: `k="v"` or a literal `k=~"a|b"`. */
function labelSetsOf(matchers: string): Record<string, string>[] {
  if (matchers.trim() === "") return [];
  const match = /^(\w+)\s*(=~?)\s*"([^"]*)"$/.exec(matchers.trim());
  if (!match) throw new Error(`Unsupported matchers: ${matchers}`);
  const [, key, operator, value] = match;
  if (operator === "=~" && !/^\w+(\|\w+)*$/.test(value!)) {
    throw new Error(`Not a literal alternation: ${value}`);
  }
  return value!.split("|").map((part) => ({ [key!]: part }));
}

function rendered(metric: string, labels: Record<string, string>) {
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  return `${metric}{${pairs}} 0`;
}

describe("series watched by increase() alert rules", () => {
  it("lists every counter series an increase() rule needs", () => {
    const selectors = increaseSelectors();
    // Guards the parsing above: the rules hold at least these.
    expect(selectors.map((selector) => selector.metric)).toEqual(
      expect.arrayContaining([
        "vham_payout_anomalies_total",
        "vham_claim_authorizations_total",
        "vham_eligibility_verifications_total",
        "vham_indexer_passes_total",
      ]),
    );
    // Every range function in the rules is one of the selectors parsed
    // above. rate() and irate() would miss a first sample the same way, so a
    // rule using one, or an increase() the pattern cannot read, fails here.
    const rangeCalls = [...RULES.matchAll(/\b(?:increase|rate|irate)\s*\(/g)];
    expect(selectors).toHaveLength(rangeCalls.length);

    for (const { metric, matchers } of selectors) {
      if (UNLISTABLE.has(metric)) continue;
      const listed = ALERTED_COUNTER_SERIES.get(metric);
      expect(listed, metric).toBeDefined();
      expect(listed!.length, metric).toBeGreaterThan(0);
      for (const labels of labelSetsOf(matchers)) {
        expect(listed, metric).toContainEqual(labels);
      }
    }
  });

  it("lists outcome codes that exist and every payout anomaly scope", () => {
    for (const metric of OUTCOME_CODES) {
      for (const { outcome } of ALERTED_COUNTER_SERIES.get(metric) ?? []) {
        expect(ERROR_CATALOG, metric).toHaveProperty(outcome!);
      }
    }

    // The payout anomaly rule has no matcher, so every scope the detector
    // reports must be listed (the type of the list checks this too).
    const anomalies = new PayoutAnomalyDetector({
      windowMs: 60_000,
      perCampaign: 0,
      global: 0,
    }).record("campaign-1", new Date("2026-10-05T10:30:00.000Z"));
    expect(anomalies.length).toBeGreaterThan(1);
    for (const { scope } of anomalies) {
      expect(
        ALERTED_COUNTER_SERIES.get("vham_payout_anomalies_total"),
      ).toContainEqual({ scope });
    }
  });

  it("exports the API's watched series at 0 before any event", async () => {
    const app = buildApp({});
    apps.push(app);

    const scrape = await app.inject({ method: "GET", url: "/metrics" });
    expect(scrape.statusCode).toBe(200);

    for (const [metric, series] of ALERTED_COUNTER_SERIES) {
      if (WORKER_COUNTERS.has(metric)) continue;
      for (const labels of series) {
        expect(scrape.body).toContain(rendered(metric, labels));
      }
    }
  });

  it("starts a watched series at 0 and keeps its count when the counter is fetched again", () => {
    const metrics = new MetricsRegistry();
    // The indexer worker creates this counter the same way.
    const passes = metrics.counter("vham_indexer_passes_total", "Passes");
    const reorg = { result: "reorg_beyond_confirmations" };
    expect(metrics.render()).toContain(
      rendered("vham_indexer_passes_total", reorg),
    );

    passes.inc(reorg);
    metrics.counter("vham_indexer_passes_total", "Passes");
    expect(metrics.value("vham_indexer_passes_total", reorg)).toBe(1);
  });
});
