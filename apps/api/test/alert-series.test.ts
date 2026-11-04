import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { ERROR_CATALOG } from "../src/errors/catalog.js";
import {
  ALERTED_COUNTER_SERIES,
  INDEXER_PASSES_METRIC,
  REORG_BEYOND_CONFIRMATIONS,
} from "../src/observability/alerted-series.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { PayoutAnomalyDetector } from "../src/observability/payout-anomaly.js";

/**
 * Drops YAML comments: a `#` at the start of a line or after whitespace,
 * outside quotes. A `#` inside a quoted label value stays.
 */
function withoutComments(text: string) {
  return text
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]!;
        if (quote) {
          if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (
          char === "#" &&
          (index === 0 || /\s/.test(line[index - 1]!))
        ) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

const RULES = withoutComments(
  readFileSync(
    new URL("../../../docs/operations/alerts.yml", import.meta.url),
    "utf8",
  ),
);

/**
 * Selectors left out on purpose: the 5xx series (one per route, method and
 * status) exist only once they occur. Any other selector of the metric is
 * checked.
 */
const NOT_LISTED = new Set(['vham_http_requests_total{status=~"5.."}']);

/**
 * Counters whose list holds every value of their label, checked by type, so
 * a selector without a matcher may watch them.
 */
const EXHAUSTIVE = new Set(["vham_payout_anomalies_total"]);

/** Counters of the indexer worker, which exports its own registry. */
const WORKER_COUNTERS = new Set([INDEXER_PASSES_METRIC]);

/** Counters whose `outcome` label is an error code of the catalog. */
const OUTCOME_CODES = new Set([
  "vham_claim_authorizations_total",
  "vham_eligibility_verifications_total",
  "vham_world_id_requests_total",
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
    matchers: (matchers ?? "").replace(/\s+/g, ""),
  }));
}

/** The label sets a selector needs: `k="v"` or a literal `k=~"a|b"`. */
function labelSetsOf(matchers: string): Record<string, string>[] {
  if (matchers === "") return [];
  const match = /^(\w+)(=~?)"([^"]*)"$/.exec(matchers);
  if (!match) throw new Error(`Unsupported matchers: ${matchers}`);
  const [, key, operator, value] = match;
  if (operator === "=~" && !/^\w+(\|\w+)*$/.test(value!)) {
    throw new Error(`Not a literal alternation: ${value}`);
  }
  return value!.split("|").map((part) => ({ [key!]: part }));
}

function seriesLine(metric: string, labels: Record<string, string>) {
  const pairs = Object.entries(labels)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  return `${metric}{${pairs}}`;
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
        "vham_world_id_requests_total",
        "vham_indexer_passes_total",
      ]),
    );
    // Every range selector (`[10m]`) in the rules belongs to an increase()
    // parsed above. rate(), changes() or delta() would miss a first sample the
    // same way, so a rule using one, or an increase() the pattern cannot read,
    // fails here (so does a range over a gauge, such as avg_over_time(): add
    // it here when one is needed). A comparison with `offset` has no range
    // and is not checked.
    const ranges = [...RULES.matchAll(/\[\s*\d+(?:ms|[smhdwy])/g)];
    expect(selectors).toHaveLength(ranges.length);

    for (const { metric, matchers } of selectors) {
      const selector = `${metric}{${matchers}}`;
      if (NOT_LISTED.has(selector)) continue;
      const listed = ALERTED_COUNTER_SERIES.get(metric);
      expect(listed, selector).toBeDefined();
      const needed = labelSetsOf(matchers);
      // Without a matcher every series counts, so only a list that holds
      // every value will do.
      if (needed.length === 0) expect(EXHAUSTIVE, selector).toContain(metric);
      for (const labels of needed) {
        expect(listed, selector).toContainEqual(labels);
      }
    }
  });

  it("lists outcome codes that exist and every payout anomaly scope", () => {
    for (const metric of OUTCOME_CODES) {
      const listed = ALERTED_COUNTER_SERIES.get(metric) ?? [];
      expect(listed.length, metric).toBeGreaterThan(0);
      for (const { outcome } of listed) {
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
        expect(scrape.body).toContain(`${seriesLine(metric, labels)} 0`);
      }
    }
  });

  it("counts into the series it started at 0 and keeps that count", () => {
    const metrics = new MetricsRegistry();
    // The indexer worker creates this counter the same way, with the same
    // constants.
    const passes = metrics.counter(INDEXER_PASSES_METRIC, "Passes");
    const reorg = { result: REORG_BEYOND_CONFIRMATIONS };
    const line = seriesLine(INDEXER_PASSES_METRIC, reorg);
    const linesOf = () =>
      metrics
        .render()
        .split("\n")
        .filter((rendered) => rendered.startsWith(`${line} `));
    expect(linesOf()).toEqual([`${line} 0`]);

    passes.inc(reorg);
    metrics.counter(INDEXER_PASSES_METRIC, "Passes");
    // One series, not a 0 next to a 1: the increment found the started one.
    expect(linesOf()).toEqual([`${line} 1`]);
  });
});
