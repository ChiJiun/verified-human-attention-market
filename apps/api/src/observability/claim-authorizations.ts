import type { FastifyBaseLogger } from "fastify";

import type { ClaimOutcome } from "../claims/service.js";
import type { MetricsRegistry } from "./metrics.js";
import type { PayoutAnomalyDetector } from "./payout-anomaly.js";

/**
 * Records every claim authorization attempt, whichever route made it
 * (acceptance, submissions replay, authorization route): one outcome series
 * for the alert rules, and the payout anomaly detector for each newly signed
 * authorization (#21, #89). Failures are logged by the route that answers
 * the request; the anomaly line goes to the request's logger so it carries
 * the request id.
 */
export function claimAuthorizationObserver(dependencies: {
  metrics: MetricsRegistry;
  payoutAnomalies: PayoutAnomalyDetector;
  now: () => Date;
  log: FastifyBaseLogger;
}) {
  const { metrics, payoutAnomalies, now } = dependencies;
  const attempts = metrics.counter(
    "vham_claim_authorizations_total",
    "Claim authorization attempts by outcome",
  );
  const anomalies = metrics.counter(
    "vham_payout_anomalies_total",
    "Claim authorization bursts above the configured thresholds",
  );

  return (
    campaignId: string,
    outcome: ClaimOutcome,
    log: FastifyBaseLogger = dependencies.log,
  ) => {
    attempts.inc({ outcome: outcome.ok ? "success" : outcome.code });

    if (!outcome.ok || !outcome.created) return;

    for (const anomaly of payoutAnomalies.record(campaignId, now())) {
      anomalies.inc({ scope: anomaly.scope });
      log.error(
        { alert: "payout_anomaly", ...anomaly },
        "Claim authorization rate above threshold",
      );
    }
  };
}
