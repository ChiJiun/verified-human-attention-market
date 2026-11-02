/** Thin client for the API, reached same-origin through /api (next.config). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /**
     * The same request may succeed later without changes: the body said
     * `retryable`, or it was a `{ status: "reconciling" }` answer.
     */
    readonly retryable = false,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

/**
 * The error for a non-2xx answer. A `{ status: "reconciling", code }` body
 * (e.g. `503 RPC_UNAVAILABLE` while linking) is not a failure but "retry
 * later" (API_SPEC), so it keeps its code and is retryable. A body without
 * the catalog's `retryable` (a proxy error page) is judged by its status.
 */
export function apiErrorFrom(status: number, body: unknown): ApiError {
  const fields = (typeof body === "object" && body !== null ? body : {}) as {
    status?: unknown;
    code?: unknown;
    error?: { code?: unknown; retryable?: unknown } | null;
  };

  if (fields.status === "reconciling" && typeof fields.code === "string") {
    return new ApiError(status, fields.code, true);
  }

  const error =
    typeof fields.error === "object" && fields.error !== null
      ? fields.error
      : {};
  return new ApiError(
    status,
    typeof error.code === "string" ? error.code : "UNKNOWN_ERROR",
    typeof error.retryable === "boolean"
      ? error.retryable
      : status >= 500 || status === 429,
  );
}

export type ApiPath =
  | "/v1/auth/logout"
  | "/v1/auth/nonce"
  | "/v1/auth/session"
  | "/v1/auth/verify"
  | "/v1/campaigns"
  | "/v1/chain"
  | (string & { readonly __brand: "ApiPath" });

export interface ApiOptions {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
}

export async function api<T>(
  path: ApiPath,
  options: ApiOptions = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey) {
    headers["idempotency-key"] = options.idempotencyKey;
  }

  const response = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const data: unknown = await response.json().catch(() => ({}));

  if (!response.ok && response.status !== 202) {
    throw apiErrorFrom(response.status, data);
  }

  return { status: response.status, data: data as T };
}

/** Human-readable messages for the error codes the UI can hit. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Unexpected error";
  }

  const messages: Record<string, string> = {
    UNAUTHENTICATED: "Please sign in with your wallet first.",
    CSRF_REJECTED:
      "The request did not come from this site. Reload the page and try again.",
    NOT_CAMPAIGN_ADVERTISER: "This wallet is not the campaign's advertiser.",
    INVALID_CAMPAIGN: "Some campaign fields are invalid.",
    CAMPAIGN_START_IN_PAST: "The start time must be in the future.",
    CAMPAIGN_START_PASSED:
      "The start time has passed; create a new campaign with a later start.",
    CHAIN_NOT_CONFIGURED: "The API has no chain configuration.",
    IDEMPOTENCY_CONFLICT:
      "This request was already used with different values. Reload the page and try again.",
    INVALID_TX_HASH: "That is not a valid transaction hash.",
    CAMPAIGN_NOT_FOUND: "This campaign does not exist on this API.",
    // Creating and linking on-chain (ADR-0011).
    CAMPAIGN_ALREADY_PUBLISHED:
      "This campaign is already on-chain. Refresh the page.",
    DRAFT_ALREADY_CREATED:
      "This draft's campaign is already on-chain and waiting for confirmations, so nothing was sent. The page links it once it is final.",
    TX_PENDING:
      "The transaction is not mined yet. Do not send it again; checking never sends a transaction.",
    TX_UNCONFIRMED:
      "The campaign is created on-chain and waiting for confirmations. Do not send it again.",
    NOT_CREATED_YET:
      "No confirmed on-chain campaign for this draft yet. If you sent the transaction it may still be mined; do not send it again.",
    RPC_UNAVAILABLE:
      "The API cannot reach the chain right now. Please try again in a minute.",
    TX_REVERTED: "The transaction reverted, so it created no campaign.",
    NO_CAMPAIGN_CREATED_EVENT:
      "That transaction did not create a campaign on this platform's contract.",
    DRAFT_MISMATCH:
      "That on-chain campaign was created for a different draft, so it was not linked here.",
    PARAMETERS_MISMATCH:
      "The on-chain campaign does not match this draft. Use the values shown.",
    ADVERTISER_MISMATCH: "The transaction was sent from a different wallet.",
    ALREADY_LINKED: "This draft is already linked to an on-chain campaign.",
    ONCHAIN_CAMPAIGN_ALREADY_LINKED:
      "That on-chain campaign is already linked to another draft.",
    AUTH_NOT_CONFIGURED: "Sign-in is disabled on this API (SIWE_DOMAIN).",
    NONCE_INVALID_OR_USED: "Sign-in expired. Please try again.",
    MESSAGE_NOT_VALID_NOW:
      "The sign-in message is expired or not valid yet. Check your computer's clock and try again.",
    INVALID_SIGNATURE: "The sign-in signature is not valid. Please try again.",
    WRONG_DOMAIN:
      "Sign-in domain mismatch: set SIWE_DOMAIN to this site's host.",
    // Sign-in and linking both answer this when the network differs.
    WRONG_CHAIN:
      "Network mismatch: this sign-in or campaign belongs to a different chain than the API serves.",
    RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
    INTERNAL_ERROR: "The API hit an unexpected error. Please try again.",
    INVALID_ELIGIBILITY:
      "This verification belongs to another wallet or campaign. Verify again.",
    ELIGIBILITY_EXPIRED: "Your verification expired with the campaign.",
    PARTICIPANT_WALLET_MISMATCH:
      "You already verified for this campaign with a different wallet.",
    WALLET_ALREADY_BOUND:
      "This wallet is already used by another person in this campaign.",
    WORLD_ID_NOT_CONFIGURED: "World ID is not configured on this API.",
    VERIFICATION_FAILED: "World ID verification failed.",
    SIGNAL_MISMATCH:
      "This World ID result does not match this verification. Start the verification again.",
    CAMPAIGN_NOT_OPEN: "This campaign is no longer open.",
    CAMPAIGN_NOT_ACTIVE: "This campaign is not active right now.",
    CAMPAIGN_NOT_STARTED: "This campaign has not started yet.",
    CAMPAIGN_ENDED: "This campaign has ended.",
    MALFORMED_ANSWERS: "Please answer every question.",
    ATTEMPT_LIMIT_REACHED: "You have used all attempts for this campaign.",
    ALREADY_COMPLETED: "You already completed this campaign.",
    ALREADY_CLAIMED: "This reward was already paid to your wallet.",
    CAMPAIGN_CAP_REACHED:
      "All rewards for this campaign are currently allocated. Try again later.",
    CHAIN_UNAVAILABLE: "The chain is unreachable. Please retry shortly.",
    CHAIN_HALTED:
      "Paused while on-chain state is being recovered. Please try again later.",
    CAMPAIGN_NOT_APPROVED:
      "This campaign is awaiting moderation review and cannot be published or joined yet.",
    CAMPAIGN_TAKEN_DOWN: "This campaign was removed after review.",
    SIGNER_UNAVAILABLE: "Rewards are temporarily unavailable. Please retry.",
    DAILY_LIMIT_REACHED:
      "Today's reward limit has been reached. Please try again later.",
    UNSAFE_CONTENT_URL:
      "The content URL is not allowed (https on a public domain, no credentials or ports).",
  };

  return messages[error.code] ?? `Request failed (${error.code}).`;
}
