/** Thin client for the API, reached same-origin through /api (next.config). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

/** A fixed route, or a path built from validated ids (campaign-link.ts). */
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
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: { code?: string };
  };

  if (!response.ok && response.status !== 202) {
    throw new ApiError(response.status, data.error?.code ?? "UNKNOWN_ERROR");
  }

  return { status: response.status, data };
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
    PARAMETERS_MISMATCH:
      "The on-chain campaign does not match this draft. Use the values shown.",
    ADVERTISER_MISMATCH: "The transaction was sent from a different wallet.",
    ALREADY_LINKED: "This draft is already linked to an on-chain campaign.",
    AUTH_NOT_CONFIGURED: "Sign-in is disabled on this API (SIWE_DOMAIN).",
    NONCE_INVALID_OR_USED: "Sign-in expired. Please try again.",
    WRONG_DOMAIN:
      "Sign-in domain mismatch: set SIWE_DOMAIN to this site's host.",
    WRONG_CHAIN: "Sign-in chain mismatch.",
    INVALID_ELIGIBILITY:
      "This verification belongs to another wallet or campaign. Verify again.",
    ELIGIBILITY_EXPIRED: "Your verification expired with the campaign.",
    PARTICIPANT_WALLET_MISMATCH:
      "You already verified for this campaign with a different wallet.",
    WALLET_ALREADY_BOUND:
      "This wallet is already used by another person in this campaign.",
    WORLD_ID_NOT_CONFIGURED: "World ID is not configured on this API.",
    VERIFICATION_FAILED: "World ID verification failed.",
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
