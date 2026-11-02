import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError, apiErrorFrom, describeError } from "../lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("api errors", () => {
  it("keeps the code of a reconciling answer and marks it retryable", () => {
    const error = apiErrorFrom(503, {
      status: "reconciling",
      code: "RPC_UNAVAILABLE",
      retryAfterSeconds: 10,
    });

    expect(error).toMatchObject({
      status: 503,
      code: "RPC_UNAVAILABLE",
      retryable: true,
    });
  });

  it("takes code and retryable from the catalog error body", () => {
    expect(
      apiErrorFrom(422, {
        error: { code: "DRAFT_MISMATCH", retryable: false, requestId: "r" },
      }),
    ).toMatchObject({ code: "DRAFT_MISMATCH", retryable: false });
    expect(
      apiErrorFrom(429, { error: { code: "RATE_LIMITED", retryable: true } }),
    ).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });

  it("judges a body without the catalog fields by its status", () => {
    expect(apiErrorFrom(502, {})).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: true,
    });
    expect(apiErrorFrom(400, null)).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
    });
  });

  it("throws a reconciling 503 with its code instead of UNKNOWN_ERROR", async () => {
    respond(503, { status: "reconciling", code: "RPC_UNAVAILABLE" });

    const failure = await api("/v1/chain").catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "RPC_UNAVAILABLE", retryable: true });
    expect(describeError(failure)).not.toMatch(/UNKNOWN_ERROR/);
  });

  it("returns a 202 reconciling answer instead of throwing", async () => {
    respond(202, { status: "reconciling", code: "NOT_CREATED_YET" });

    await expect(api("/v1/chain")).resolves.toEqual({
      status: 202,
      data: { status: "reconciling", code: "NOT_CREATED_YET" },
    });
  });
});

describe("error copy", () => {
  // Every code creating and linking on-chain can answer (API_SPEC, ADR-0011).
  const adr0011Codes = [
    "TX_PENDING",
    "TX_UNCONFIRMED",
    "NOT_CREATED_YET",
    "RPC_UNAVAILABLE",
    "INVALID_TX_HASH",
    "CAMPAIGN_NOT_FOUND",
    "ALREADY_LINKED",
    "ONCHAIN_CAMPAIGN_ALREADY_LINKED",
    "WRONG_CHAIN",
    "TX_REVERTED",
    "NO_CAMPAIGN_CREATED_EVENT",
    "ADVERTISER_MISMATCH",
    "DRAFT_MISMATCH",
    "PARAMETERS_MISMATCH",
    "CAMPAIGN_ALREADY_PUBLISHED",
    "DRAFT_ALREADY_CREATED",
    "CAMPAIGN_START_PASSED",
    "CHAIN_NOT_CONFIGURED",
    "CHAIN_HALTED",
  ];

  it.each(adr0011Codes)("has a specific message for %s", (code) => {
    const message = describeError(new ApiError(409, code));

    expect(message).not.toMatch(/^Request failed/);
    expect(message).not.toContain(code);
  });

  it("gives each of them its own message", () => {
    const messages = adr0011Codes.map((code) =>
      describeError(new ApiError(409, code)),
    );

    expect(new Set(messages).size).toBe(messages.length);
  });

  it("falls back to the code for an unknown one", () => {
    expect(describeError(new ApiError(418, "NEW_CODE"))).toBe(
      "Request failed (NEW_CODE).",
    );
  });
});
