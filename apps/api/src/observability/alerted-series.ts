/**
 * Counter series that a rule in docs/operations/alerts.yml watches with
 * `increase()`. Prometheus derives `increase()` from the samples it has
 * scraped, so a series whose first sample is already 1 shows no increase,
 * and the first event would not alert. MetricsRegistry exports each of these
 * at 0 as soon as its counter exists (test/alert-series.test.ts checks this
 * list against the rules).
 *
 * `vham_http_requests_total{status=~"5.."}` is left out: its series carry the
 * route and status, so they cannot be listed ahead, and that rule alerts only
 * above 10 errors.
 */
export const ALERTED_COUNTER_SERIES: Readonly<
  Record<string, readonly Readonly<Record<string, string>>[]>
> = {
  vham_payout_anomalies_total: [{ scope: "campaign" }, { scope: "global" }],
  vham_claim_authorizations_total: [
    { outcome: "SIGNER_MISMATCH" },
    { outcome: "SIGNER_UNAVAILABLE" },
    { outcome: "DAILY_LIMIT_REACHED" },
  ],
  vham_eligibility_verifications_total: [
    { outcome: "PROVIDER_UNAVAILABLE" },
    { outcome: "WORLD_ID_NOT_CONFIGURED" },
  ],
  vham_indexer_passes_total: [{ result: "reorg_beyond_confirmations" }],
};
