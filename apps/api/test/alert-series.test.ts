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

/** Column of a line's key, after its indentation and any `- `. */
function keyColumn(line: string) {
  return line.search(/[^\s-]/);
}

/** Where a YAML scalar may start: a quote there opens a quoted scalar. */
const SCALAR_START = /(?:^\s*(?:-\s+)*|:\s+|[[{,]\s*)$/;

/**
 * Drops YAML comments as YAML does: a `#` at the start of a line or after
 * whitespace, outside a quoted scalar and outside the content of a block
 * scalar (`>-`, `|`), which is kept as it is. A quote opens a quoted scalar
 * only where a scalar starts; elsewhere, as in `it's` or `{a="b"}`, it is
 * plain text. A quoted scalar may span lines; `\"` and `''` escape its
 * quote.
 */
function withoutComments(text: string) {
  let quote: string | null = null;
  let blockColumn: number | null = null;
  return text
    .split("\n")
    .map((line) => {
      if (blockColumn !== null) {
        if (line.trim() === "" || keyColumn(line) > blockColumn) return line;
        blockColumn = null;
      }
      let kept = line;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index]!;
        if (quote) {
          if (quote === '"' && char === "\\") index += 1;
          else if (quote === "'" && line.startsWith("''", index)) index += 1;
          else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
          if (SCALAR_START.test(line.slice(0, index))) quote = char;
        } else if (
          char === "#" &&
          (index === 0 || /\s/.test(line[index - 1]!))
        ) {
          kept = line.slice(0, index);
          break;
        }
      }
      if (quote === null && /:\s+[>|][-+0-9]*\s*$/.test(kept)) {
        blockColumn = keyColumn(line);
      }
      return kept;
    })
    .join("\n");
}

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

const RULES_FILE = repositoryText("docs/operations/alerts.yml");
const RULES = withoutComments(RULES_FILE);

const EXPR_KEY = /^\s*(?:-\s+)*expr:/;

/**
 * The item lines of every `key:` list, such as `rules:`. The list must be a
 * block sequence (the selector test checks that each item is a block
 * mapping): a flow sequence or mapping would hide its keys from the
 * line-based checks here. Items may sit at the key's indentation.
 */
function sequenceItems(text: string, key: string) {
  const lines = text.split("\n");
  const items: string[] = [];
  lines.forEach((line, index) => {
    const list = new RegExp(`^(\\s*)${key}:(.*)$`).exec(line);
    if (!list) return;
    if (list[2]!.trim() !== "") {
      throw new Error(`Not a block sequence: ${line.trim()}`);
    }
    const keyIndent = list[1]!.length;
    let itemIndent: number | null = null;
    for (const next of lines.slice(index + 1)) {
      if (next.trim() === "") continue;
      const indent = next.search(/\S/);
      const item = next.trimStart().startsWith("-");
      if (indent < keyIndent || (indent === keyIndent && !item)) break;
      itemIndent ??= indent;
      if (indent === itemIndent) items.push(next.trimEnd());
    }
  });
  return items;
}

/**
 * Where an `expr` value may start, on its key's line: a block scalar (`>-`,
 * `|`), a plain value, or one quoted on that line, `\"` and `''` escaped.
 * The next lines of a quoted value may sit at any indentation, where
 * exprLines would not look, so fold long ones with `>-`.
 */
const EXPR_VALUE =
  /^(?:[>|][-+0-9]*|[\w(-].*|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')$/;

/**
 * Every line of every `expr` value: block, plain, or quoted on one line (the
 * selector test checks EXPR_VALUE). Prometheus reads a `#` in
 * an expression as a PromQL comment that hides the rest of its line. In a
 * quoted or block value YAML keeps the `#`, so this parser would still see
 * what Prometheus does not; in a plain value YAML drops it as a comment. So
 * no `expr` line may hold one: put comments above the rule.
 */
function exprLines(text: string) {
  const lines = text.split("\n");
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (!EXPR_KEY.test(line)) return;
    found.push(line);
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== "" && keyColumn(next) <= keyColumn(line)) break;
      found.push(next);
    }
  });
  return found;
}

/** GitHub's anchor for the text of a Markdown heading. */
function slugOf(heading: string) {
  return heading
    .trim()
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
 * part of a heading's text.
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
    const title = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(
      line.replace(/<!--.*?-->/g, ""),
    )?.[1];
    if (title === undefined) continue;
    const slug = slugOf(title);
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
  return [
    ...RULES.matchAll(/\bincrease\(\s*(\w+)\s*(?:\{([^}]*)\})?\s*\[/g),
  ].map(([, metric, matchers]) => ({
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
    // Groups and rules are block mappings in block sequences, so every key
    // starts a line, where these checks look; flow style fails here. Every
    // alert has an `expr` key whose value starts on its line (EXPR_VALUE),
    // no `expr` line holds a `#` (exprLines), and the folded World ID rule's
    // second line is found, which guards the search.
    for (const group of sequenceItems(RULES, "groups")) {
      expect(group).toMatch(/^\s*-\s+name:\s*\S+$/);
    }
    const alerts = sequenceItems(RULES, "rules");
    for (const alert of alerts) expect(alert).toMatch(/^\s*-\s+alert:\s*\w+$/);
    const expressions = exprLines(RULES_FILE);
    const keys = expressions.filter((line) => EXPR_KEY.test(line));
    expect(keys).toHaveLength(alerts.length);
    for (const line of keys) {
      expect(line.replace(EXPR_KEY, "").trim(), line).toMatch(EXPR_VALUE);
    }
    expect(expressions.join("\n")).toContain("or increase(vham_world_id");
    for (const line of expressions) expect(line).not.toContain("#");

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
    const alerts = sequenceItems(RULES, "rules");
    const anchors = [
      ...RULES.matchAll(/runbook:\s*docs\/operations\/RUNBOOK\.md#(\S+)/g),
    ].map(([, anchor]) => anchor!);
    expect(alerts.length).toBeGreaterThan(0);
    expect(anchors).toHaveLength(alerts.length);
    for (const anchor of anchors) expect(slugs, anchor).toContain(anchor);
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
