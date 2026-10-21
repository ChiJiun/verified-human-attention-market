import type { FastifyBaseLogger } from "fastify";

import type { ClaimOutcome } from "../claims/service.js";
import { OPERATOR_OUTCOMES } from "./instrumentation.js";
import type { MetricsRegistry } from "./metrics.js";
import type { PayoutAnomalyDetector } from "./payout-anomaly.js";

/**
 * Records every claim authorization attempt, whichever route made it
 * (acceptance, submissions replay, authorization route): one outcome series
 * for the alert rules, and the payout anomaly detector for each newly signed
 * authorization (#21, #89).
 */
export function claimAuthorizationObserver(dependencies: {
  metrics: MetricsRegistry;
  payoutAnomalies: PayoutAnomalyDetector;
  now: () => Date;
  log: FastifyBaseLogger;
}) {
  const { metrics, payoutAnomalies, now, log } = dependencies;
  const attempts = metrics.counter(
    "vham_claim_authorizations_total",
    "Claim authorization attempts by outcome",
  );
  const anomalies = metrics.counter(
    "vham_payout_anomalies_total",
    "Claim authorization bursts above the configured thresholds",
  );

  return (campaignId: string, outcome: ClaimOutcome) => {
    attempts.inc({ outcome: outcome.ok ? "success" : outcome.code });

    if (!outcome.ok) {
      if (OPERATOR_OUTCOMES.has(outcome.code)) {
        log.error(
          {
            event: "claim_authorizations",
            outcome: outcome.code,
            statusCode: outcome.status,
            campaignId,
          },
          "Critical path failed",
        );
      }
      return;
    }

    if (!outcome.created) return;

    for (const anomaly of payoutAnomalies.record(campaignId, now())) {
      anomalies.inc({ scope: anomaly.scope });
      log.error(
        { alert: "payout_anomaly", ...anomaly },
        "Claim authorization rate above threshold",
      );
    }
  };
}
