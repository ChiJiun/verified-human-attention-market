import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

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
 * A file of this repository with `\n` line ends: a Windows checkout may have
 * `\r\n`, and a `.` in the patterns here does not match `\r`.
 */
function repositoryText(path: string) {
  return readFileSync(
    new URL(`../../../${path}`, import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");
}

/**
 * What these checks read of a rule file: every rule is an alert with an
 * expression and a runbook link. Keys left out here are not checked.
 */
const RuleFile = z.object({
  groups: z.array(
    z.object({
      rules: z.array(
        z.object({
          alert: z.string(),
          expr: z.string(),
          annotations: z.object({ runbook: z.string() }),
        }),
      ),
    }),
  ),
});

/**
 * The alert rules as Prometheus reads them: comments dropped, quoting,
 * folding, anchors, tags and merge keys (`<<`) resolved, duplicate keys
 * refused.
 */
const RULES = RuleFile.parse(
  parse(repositoryText("docs/operations/alerts.yml"), { merge: true }),
).groups.flatMap((group) => group.rules);

/** GitHub's anchor for the text of a Markdown heading. */
function slugOf(heading: string) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/**
 * GitHub's anchors for the headings of a Markdown file: none inside a code
 * fence or an HTML comment block, and `-1`, `-2` after a repeated one. A
 * fence closes only with a bare marker of its kind, at least as long. A
 * comment block starts with `<!--` at the start of a line and ends on the
 * line that holds `-->`; a comment inside a line is no block, and is not
 * part of a heading's text, though the spaces around it are.
 */
function anchorsOf(markdown: string) {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  let comment = false;
  for (const line of markdown.split("\n")) {
    if (comment) {
      comment = !line.includes("-->");
      continue;
    }
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceLine) {
      const [, marker, rest] = fenceLine;
      if (fence === null) fence = marker!;
      else if (
        marker![0] === fence[0] &&
        marker!.length >= fence.length &&
        rest!.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    if (/^ {0,3}<!--/.test(line)) {
      comment = !line.includes("-->", line.indexOf("<!--") + 4);
      continue;
    }
    const title = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (title === undefined) continue;
    // GitHub drops an inline comment but keeps the spaces around it, so
    // `### Foo <!-- note -->` gets the anchor `foo-`.
    const slug = slugOf(title.replace(/<!--.*?-->/g, ""));
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

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
  return RULES.flatMap(({ expr }) => [
    ...expr.matchAll(/\bincrease\(\s*(\w+)\s*(?:\{([^}]*)\})?\s*\[/g),
  ]).map(([, metric, matchers]) => ({
    metric: metric!,
    // Spaces between matchers go, those inside a label value stay.
    matchers: (matchers ?? "").replace(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/g, ""),
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
    // Prometheus reads a `#` in an expression as a PromQL comment that hides
    // the rest of its line, which the selectors below would still see. So no
    // expression may hold one, not even in a label value: put comments in
    // YAML, above the rule.
    for (const { alert, expr } of RULES) expect(expr, alert).not.toContain("#");

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
    const ranges = RULES.flatMap(({ expr }) => [
      ...expr.matchAll(/\[\s*\d+(?:ms|[smhdwy])/g),
    ]);
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

  it("links every alert to a heading of the runbook", () => {
    const slugs = anchorsOf(repositoryText("docs/operations/RUNBOOK.md"));
    // Guards the heading parser: `VhamIndexerLag / VhamIndexerStalled`.
    expect(slugs).toContain("vhamindexerlag--vhamindexerstalled");
    expect(RULES.length).toBeGreaterThan(0);
    for (const { alert, annotations } of RULES) {
      const anchor = /^docs\/operations\/RUNBOOK\.md#(\S+)$/.exec(
        annotations.runbook,
      )?.[1];
      expect(anchor, alert).toBeDefined();
      expect(slugs, alert).toContain(anchor);
    }
  });

  it("finds GitHub's anchors only where GitHub makes them", () => {
    const markdown = [
      "# Runbook",
      "### VhamIndexerLag / VhamIndexerStalled",
      "### VhamRpcDown <!-- note -->",
      "### [Linked](https://example.com) heading ###",
      "## Repeated",
      "## Repeated",
      "```sh",
      "# in a fence",
      "~~~",
      "# still in the fence: only its own marker closes it",
      "```bash",
      "# still in the fence: only a bare marker closes it",
      "```",
      "````md",
      "```",
      "# still in the fence: only a marker as long closes it",
      "````",
      "<!-- a comment block",
      "## Commented out",
      "-->",
      "<!-- a whole comment on one line -->",
      "Text with an unclosed <!-- inline comment",
      "## After the text",
      "   ### Indented by three",
      "    ### Indented by four: code",
    ].join("\n");
    expect([...anchorsOf(markdown)]).toEqual([
      "runbook",
      "vhamindexerlag--vhamindexerstalled",
      "vhamrpcdown-",
      "linked-heading",
      "repeated",
      "repeated-1",
      "after-the-text",
      "indented-by-three",
    ]);
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
