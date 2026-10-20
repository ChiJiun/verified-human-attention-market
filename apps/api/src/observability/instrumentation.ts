import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { MetricsRegistry } from "./metrics.js";
import type { PayoutAnomalyDetector } from "./payout-anomaly.js";

/** Business outcome metric per critical route (success or error code). */
const OUTCOME_METRICS: Record<string, { name: string; help: string }> = {
  "POST /v1/auth/verify": {
    name: "vham_sign_ins_total",
    help: "SIWE sign-in attempts by outcome",
  },
  "POST /v1/campaigns": {
    name: "vham_campaign_creations_total",
    help: "Campaign draft creations by outcome",
  },
  "POST /v1/campaigns/:id/publish": {
    name: "vham_campaign_publishes_total",
    help: "Campaign publish (on-chain intent) requests by outcome",
  },
  "POST /v1/campaigns/:id/onchain": {
    name: "vham_campaign_links_total",
    help: "On-chain campaign link attempts by outcome",
  },
  "POST /v1/campaigns/:id/eligibility/verify": {
    name: "vham_eligibility_verifications_total",
    help: "World ID eligibility verifications by outcome",
  },
  "POST /v1/campaigns/:id/submissions": {
    name: "vham_submissions_total",
    help: "Engagement submissions by outcome",
  },
  "POST /v1/campaigns/:id/submissions/:submissionId/authorization": {
    name: "vham_claim_authorizations_total",
    help: "Claim authorization requests by outcome",
  },
};

/** Outcomes that point at an operator problem rather than a user error. */
const OPERATOR_OUTCOMES = new Set([
  "PROVIDER_UNAVAILABLE",
  "WORLD_ID_NOT_CONFIGURED",
  "SIGNER_MISMATCH",
  "AUTHORIZATION_UNAVAILABLE",
  "SIGNER_UNAVAILABLE",
  "DAILY_LIMIT_REACHED",
  "CHAIN_NOT_CONFIGURED",
  "CHAIN_UNAVAILABLE",
  "RPC_UNAVAILABLE",
]);

/**
 * Pino options shared by the API: never log credentials, cookies, raw
 * proofs or signatures, even if a future log line includes them.
 */
export const LOGGER_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.idkitResponse",
  "*.signalSalt",
  "*.proof",
  "*.signature",
  "*.privateKey",
  "*.nullifier",
];

const REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** Uses a caller-supplied x-request-id when well-formed, else a new UUID. */
export function generateRequestId(request: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && REQUEST_ID.test(header)
    ? header
    : randomUUID();
}

function outcomeOf(statusCode: number, payload: unknown): string {
  if (typeof payload === "string" && payload.length < 10_000) {
    try {
      const body = JSON.parse(payload) as {
        error?: { code?: unknown };
        code?: unknown;
        status?: unknown;
      };
      if (typeof body.error?.code === "string") return body.error.code;
      if (body.status === "reconciling" && typeof body.code === "string") {
        return body.code;
      }
      if (typeof body.status === "string" && statusCode < 300) {
        return body.status;
      }
    } catch {
      // Non-JSON payload: fall back to the status class.
    }
  }

  return statusCode < 400 ? "success" : `http_${statusCode}`;
}

export function registerInstrumentation(
  app: FastifyInstance,
  dependencies: {
    metrics: MetricsRegistry;
    payoutAnomalies: PayoutAnomalyDetector;
    now: () => Date;
    /** When set, /metrics requires `Authorization: Bearer <token>`. */
    metricsToken: string | null;
    /** Refreshes scrape-time gauges (e.g. indexer lag); errors are ignored. */
    collect?: () => Promise<void>;
  },
) {
  const { metrics } = dependencies;
  const requests = metrics.counter(
    "vham_http_requests_total",
    "HTTP requests by route, method and status",
  );
  const anomalies = metrics.counter(
    "vham_payout_anomalies_total",
    "Claim authorization bursts above the configured thresholds",
  );

  app.addHook("onSend", async (request: FastifyRequest, reply, payload) => {
    reply.header("x-request-id", request.id);

    const route = request.routeOptions.url ?? "unmatched";
    const key = `${request.method} ${route}`;
    requests.inc({
      route,
      method: request.method,
      status: String(reply.statusCode),
    });

    const outcomeMetric = OUTCOME_METRICS[key];
    if (outcomeMetric) {
      const outcome = outcomeOf(reply.statusCode, payload);
      metrics.counter(outcomeMetric.name, outcomeMetric.help).inc({ outcome });

      if (reply.statusCode >= 400 || outcome === "reconciling") {
        // Identifiers only: never the request body (proofs, answers).
        const event = {
          event: outcomeMetric.name.replace(/^vham_|_total$/g, ""),
          outcome,
          statusCode: reply.statusCode,
          campaignId: (request.params as { id?: string } | undefined)?.id,
        };
        if (OPERATOR_OUTCOMES.has(outcome) || reply.statusCode >= 500) {
          request.log.error(event, "Critical path failed");
        } else {
          request.log.warn(event, "Critical path rejected");
        }
      }
    }

    if (
      key ===
        "POST /v1/campaigns/:id/submissions/:submissionId/authorization" &&
      reply.statusCode === 201
    ) {
      const campaignId = (request.params as { id: string }).id;
      for (const anomaly of dependencies.payoutAnomalies.record(
        campaignId,
        dependencies.now(),
      )) {
        anomalies.inc({ scope: anomaly.scope });
        request.log.error(
          { alert: "payout_anomaly", ...anomaly },
          "Claim authorization rate above threshold",
        );
      }
    }

    return payload;
  });

  app.get("/metrics", async (request, reply) => {
    if (
      dependencies.metricsToken &&
      request.headers.authorization !== `Bearer ${dependencies.metricsToken}`
    ) {
      return reply.status(401).send({ error: { code: "UNAUTHENTICATED" } });
    }

    if (dependencies.collect) {
      try {
        await dependencies.collect();
      } catch (error) {
        request.log.warn({ err: error }, "Metrics collection failed");
      }
    }

    return reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.render());
  });
}
