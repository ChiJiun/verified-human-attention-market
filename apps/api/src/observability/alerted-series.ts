import type { PayoutAnomaly } from "./payout-anomaly.js";

type Labels = Readonly<Record<string, string>>;

/** The indexer worker's pass counter (indexer-worker.ts). */
export const INDEXER_PASSES_METRIC = "vham_indexer_passes_total";

/** The pass result the worker counts for a reorg past the confirmation depth. */
export const REORG_BEYOND_CONFIRMATIONS = "reorg_beyond_confirmations";

/**
 * Every anomaly scope, so that adding one without listing it fails the type
 * check: the payout anomaly rule watches the counter without a matcher.
 */
const PAYOUT_ANOMALY_SCOPES: Record<PayoutAnomaly["scope"], true> = {
  campaign: true,
  global: true,
};

/**
 * Counter series that a rule in docs/operations/alerts.yml watches with
 * `increase()`. Prometheus derives `increase()` from the samples it has
 * scraped, so an event counts only once it holds an earlier sample of the
 * series. MetricsRegistry exports each of these at 0 as soon as its counter
 * exists (test/alert-series.test.ts checks this list against the rules). The
 * worker exits right after it counts a deep reorg, so that series still
 * alerts only if a scrape lands in between (VhamChainHalted stays).
 *
 * `vham_http_requests_total{status=~"5.."}` is not listed, so that its series
 * (one per route, method and status) exist only once they occur. The 5xx
 * responses a new series counts before its first scrape are not seen as an
 * increase; that rule is a warning, so it accepts the gap.
 */
export const ALERTED_COUNTER_SERIES: ReadonlyMap<string, readonly Labels[]> =
  new Map<string, readonly Labels[]>([
    [
      "vham_payout_anomalies_total",
      Object.keys(PAYOUT_ANOMALY_SCOPES).map((scope) => ({ scope })),
    ],
    [
      "vham_claim_authorizations_total",
      [
        { outcome: "SIGNER_MISMATCH" },
        { outcome: "SIGNER_UNAVAILABLE" },
        { outcome: "DAILY_LIMIT_REACHED" },
      ],
    ],
    [
      "vham_eligibility_verifications_total",
      [
        { outcome: "PROVIDER_UNAVAILABLE" },
        { outcome: "WORLD_ID_NOT_CONFIGURED" },
      ],
    ],
    [INDEXER_PASSES_METRIC, [{ result: REORG_BEYOND_CONFIRMATIONS }]],
  ]);
