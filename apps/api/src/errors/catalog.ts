import type { FastifyInstance } from "fastify";

/**
 * Stable, machine-readable error codes (#26). Every error response is
 * `{ error: { code, message, requestId, retryable } }`.
 *
 * retryable = true  → the same request may succeed later without changes
 *                     (back off; honour `retry-after` when present).
 * retryable = false → change the request, the state, or stop.
 *
 * Codes are never renamed or repurposed within /v1. New codes may be added;
 * clients must treat unknown codes by HTTP status class.
 */
export const ERROR_CATALOG: Record<string, { retryable: boolean }> = {
  // Request shape
  INVALID_CAMPAIGN: { retryable: false },
  INVALID_IDEMPOTENCY_KEY: { retryable: false },
  INVALID_ELIGIBILITY_REQUEST: { retryable: false },
  INVALID_ELIGIBILITY_TOKEN: { retryable: false },
  INVALID_SUBMISSION: { retryable: false },
  INVALID_SIGN_IN_REQUEST: { retryable: false },
  INVALID_MESSAGE: { retryable: false },
  INVALID_TX_HASH: { retryable: false },
  INVALID_QUERY: { retryable: false },
  INVALID_REPORT: { retryable: false },
  INVALID_ACTION: { retryable: false },
  INVALID_RESOLUTION: { retryable: false },
  INVALID_API_CLIENT: { retryable: false },
  MALFORMED_ANSWERS: { retryable: false },
  MISSING_ANSWERS: { retryable: false },
  UNSAFE_CONTENT_URL: { retryable: false },
  CAMPAIGN_START_IN_PAST: { retryable: false },

  // Authentication / authorization
  UNAUTHENTICATED: { retryable: false },
  AUTH_NOT_CONFIGURED: { retryable: false },
  NONCE_INVALID_OR_USED: { retryable: false },
  WRONG_DOMAIN: { retryable: false },
  WRONG_CHAIN: { retryable: false },
  MESSAGE_NOT_VALID_NOW: { retryable: false },
  INVALID_SIGNATURE: { retryable: false },
  NOT_CAMPAIGN_ADVERTISER: { retryable: false },
  NOT_OPERATOR: { retryable: false },
  CSRF_REJECTED: { retryable: false },
  INVALID_API_KEY: { retryable: false },
  API_KEY_WRONG_ENVIRONMENT: { retryable: false },
  API_KEY_NOT_ALLOWED: { retryable: false },
  INSUFFICIENT_SCOPE: { retryable: false },

  // Not found
  CAMPAIGN_NOT_FOUND: { retryable: false },
  MISSION_NOT_FOUND: { retryable: false },
  SUBMISSION_NOT_FOUND: { retryable: false },
  REPORT_NOT_FOUND: { retryable: false },
  API_CLIENT_NOT_FOUND: { retryable: false },
  ELIGIBILITY_NOT_FOUND: { retryable: false },

  // Conflicts and terminal state
  IDEMPOTENCY_CONFLICT: { retryable: false },
  CAMPAIGN_ALREADY_PUBLISHED: { retryable: false },
  CAMPAIGN_START_PASSED: { retryable: false },
  CAMPAIGN_NOT_OPEN: { retryable: false },
  CAMPAIGN_ENDED: { retryable: false },
  CAMPAIGN_TAKEN_DOWN: { retryable: false },
  ALREADY_LINKED: { retryable: false },
  ONCHAIN_CAMPAIGN_ALREADY_LINKED: { retryable: false },
  ADVERTISER_MISMATCH: { retryable: false },
  DRAFT_MISMATCH: { retryable: false },
  PARAMETERS_MISMATCH: { retryable: false },
  TX_REVERTED: { retryable: false },
  ALREADY_COMPLETED: { retryable: false },
  ALREADY_CLAIMED: { retryable: false },
  ATTEMPT_LIMIT_REACHED: { retryable: false },
  SUBMISSION_NOT_ACCEPTED: { retryable: false },
  INVALID_ELIGIBILITY: { retryable: false },
  ELIGIBILITY_EXPIRED: { retryable: false },
  ELIGIBILITY_CAMPAIGN_MISMATCH: { retryable: false },
  ELIGIBILITY_CLAIMANT_MISMATCH: { retryable: false },
  PARTICIPANT_WALLET_MISMATCH: { retryable: false },
  WALLET_ALREADY_BOUND: { retryable: false },
  VERIFICATION_FAILED: { retryable: false },
  INVALID_PROOF_PAYLOAD: { retryable: false },
  ACTION_MISMATCH: { retryable: false },
  ENVIRONMENT_MISMATCH: { retryable: false },
  INVALID_TRANSITION: { retryable: false },
  REPORT_ALREADY_RESOLVED: { retryable: false },
  REPORT_CAMPAIGN_MISMATCH: { retryable: false },
  API_CLIENT_LIMIT_REACHED: { retryable: false },
  CHAIN_NOT_CONFIGURED: { retryable: false },
  WORLD_ID_NOT_CONFIGURED: { retryable: false },
  COMPREHENSION_FAILED: { retryable: false },

  // Retry later: time, chain progress or capacity
  CAMPAIGN_NOT_ACTIVE: { retryable: true },
  CAMPAIGN_NOT_STARTED: { retryable: true },
  CAMPAIGN_NOT_APPROVED: { retryable: true },
  CAMPAIGN_CAP_REACHED: { retryable: true },
  NO_CAMPAIGN_CREATED_EVENT: { retryable: true },
  TX_PENDING: { retryable: true },
  NOT_CREATED_YET: { retryable: true },
  TX_UNCONFIRMED: { retryable: true },
  CHAIN_HALTED: { retryable: true },
  DAILY_LIMIT_REACHED: { retryable: true },
  RATE_LIMITED: { retryable: true },

  // Dependencies unavailable
  CHAIN_UNAVAILABLE: { retryable: true },
  RPC_UNAVAILABLE: { retryable: true },
  PROVIDER_UNAVAILABLE: { retryable: true },
  AUTHORIZATION_UNAVAILABLE: { retryable: true },
  SIGNER_UNAVAILABLE: { retryable: true },
  SIGNER_MISMATCH: { retryable: true },
};

export function isRetryable(code: string, statusCode: number): boolean {
  return (
    ERROR_CATALOG[code]?.retryable ?? (statusCode >= 500 || statusCode === 429)
  );
}

/** Adds `retryable` (and `requestId` when missing) to every error body. */
export function registerErrorModel(app: FastifyInstance) {
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      reply.statusCode < 400 ||
      typeof payload !== "string" ||
      payload.length > 100_000 ||
      !String(reply.getHeader("content-type") ?? "").includes("json")
    ) {
      return payload;
    }

    try {
      const body = JSON.parse(payload) as {
        error?: { code?: unknown; retryable?: unknown; requestId?: unknown };
      };

      if (
        typeof body.error !== "object" ||
        body.error === null ||
        typeof body.error.code !== "string"
      ) {
        return payload;
      }

      body.error.retryable ??= isRetryable(body.error.code, reply.statusCode);
      body.error.requestId ??= request.id;
      return JSON.stringify(body);
    } catch {
      return payload;
    }
  });
}
