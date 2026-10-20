import { describe, expect, it, vi } from "vitest";

import {
  campaignAction,
  HttpWorldIdVerifier,
  LocalSimulatedWorldIdVerifier,
  normalizeNullifier,
} from "../src/identity/world-id.js";

const ACTION = campaignAction("00000000-0000-4000-8000-000000000001");
const NULLIFIER_HEX =
  "0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8";
const NULLIFIER_DEC = BigInt(NULLIFIER_HEX).toString(10);

function idkitResponse(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "4.0",
    nonce: "0x1234",
    action: ACTION,
    environment: "production",
    responses: [
      {
        identifier: "proof_of_human",
        issuer_schema_id: 1,
        proof: ["0x111", "0x222", "0x333", "0x444", "0x555"],
        nullifier: NULLIFIER_HEX,
        expires_at_min: 1791194400,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function verifierWith(fetchImpl: typeof fetch) {
  return new HttpWorldIdVerifier({
    rpId: "rp_test123",
    environment: "production",
    baseUrl: "https://world.example",
    fetch: fetchImpl,
  });
}

describe("HttpWorldIdVerifier", () => {
  it("forwards the IDKit result unchanged and returns the decimal nullifier", async () => {
    const payload = idkitResponse();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        success: true,
        environment: "production",
        results: [
          {
            identifier: "proof_of_human",
            success: true,
            nullifier: NULLIFIER_HEX,
          },
        ],
      }),
    );

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({ action: ACTION, idkitResponse: payload });

    expect(result).toEqual({ ok: true, nullifier: NULLIFIER_DEC });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://world.example/api/v4/verify/rp_test123");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("rejects proofs for another action without calling World", async () => {
    const fetchMock = vi.fn();

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({
      action: ACTION,
      idkitResponse: idkitResponse({ action: "vham-campaign-other" }),
    });

    expect(result).toEqual({ ok: false, code: "ACTION_MISMATCH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects staging proofs in production", async () => {
    const fetchMock = vi.fn();

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({
      action: ACTION,
      idkitResponse: idkitResponse({ environment: "staging" }),
    });

    expect(result).toEqual({ ok: false, code: "ENVIRONMENT_MISMATCH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a legacy World ID 3.0 result without calling World", async () => {
    const legacyNullifier = "0x0123456789abcdef";
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        success: true,
        environment: "production",
        results: [
          { identifier: "orb", success: true, nullifier: legacyNullifier },
        ],
      }),
    );

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({
      action: ACTION,
      idkitResponse: idkitResponse({
        protocol_version: "3.0",
        responses: [
          {
            identifier: "orb",
            proof: "0xproof",
            merkle_root: "0xroot",
            nullifier: legacyNullifier,
          },
        ],
      }),
    });

    expect(result).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not an object", "proof"],
    ["missing responses", { protocol_version: "4.0", action: ACTION }],
    [
      "session proof without action",
      { protocol_version: "4.0", responses: [] },
    ],
  ])("rejects an invalid payload: %s", async (_label, payload) => {
    const fetchMock = vi.fn();

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({ action: ACTION, idkitResponse: payload });

    expect(result).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "400 from World",
      () =>
        jsonResponse(400, { success: false, code: "all_verifications_failed" }),
      "VERIFICATION_FAILED",
    ],
    ["500 from World", () => jsonResponse(500, {}), "PROVIDER_UNAVAILABLE"],
    ["404 app not found", () => jsonResponse(404, {}), "PROVIDER_UNAVAILABLE"],
    [
      "success: false",
      () => jsonResponse(200, { success: false }),
      "VERIFICATION_FAILED",
    ],
    [
      "environment mismatch in response",
      () =>
        jsonResponse(200, {
          success: true,
          environment: "staging",
          nullifier: NULLIFIER_HEX,
        }),
      "ENVIRONMENT_MISMATCH",
    ],
    [
      "nullifier the user did not submit",
      () => jsonResponse(200, { success: true, nullifier: "0x01" }),
      "VERIFICATION_FAILED",
    ],
    [
      "only failed per-credential results",
      () =>
        jsonResponse(200, {
          success: true,
          results: [{ success: false, nullifier: NULLIFIER_HEX }],
        }),
      "VERIFICATION_FAILED",
    ],
    [
      "non-JSON body",
      () => new Response("oops", { status: 200 }),
      "PROVIDER_UNAVAILABLE",
    ],
  ])("maps %s", async (_label, respond, code) => {
    const result = await verifierWith((async () =>
      respond()) as unknown as typeof fetch).verify({
      action: ACTION,
      idkitResponse: idkitResponse(),
    });

    expect(result).toEqual({ ok: false, code });
  });

  it("treats network errors and timeouts as provider unavailability", async () => {
    const result = await verifierWith((async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch).verify({
      action: ACTION,
      idkitResponse: idkitResponse(),
    });

    expect(result).toEqual({ ok: false, code: "PROVIDER_UNAVAILABLE" });
  });

  it("refuses an unexpected rp id format", () => {
    expect(
      () =>
        new HttpWorldIdVerifier({
          rpId: "../admin",
          environment: "production",
        }),
    ).toThrow();
  });
});

describe("normalizeNullifier", () => {
  it("canonicalizes hex and decimal forms", () => {
    expect(normalizeNullifier(NULLIFIER_HEX)).toBe(NULLIFIER_DEC);
    expect(normalizeNullifier(NULLIFIER_DEC)).toBe(NULLIFIER_DEC);
    expect(normalizeNullifier("0x0A")).toBe("10");
  });

  it("rejects non-numeric values", () => {
    expect(normalizeNullifier("abc")).toBeNull();
    expect(normalizeNullifier("0x")).toBeNull();
    expect(normalizeNullifier("-1")).toBeNull();
  });
});

describe("LocalSimulatedWorldIdVerifier", () => {
  it("can only be constructed for the local anvil chain", () => {
    expect(() => new LocalSimulatedWorldIdVerifier(84532)).toThrow();
    expect(() => new LocalSimulatedWorldIdVerifier(8453)).toThrow();
    expect(() => new LocalSimulatedWorldIdVerifier(31337)).not.toThrow();
  });

  it("checks the action and derives a stable nullifier", async () => {
    const verifier = new LocalSimulatedWorldIdVerifier(31337);
    const first = await verifier.verify({
      action: ACTION,
      idkitResponse: { action: ACTION, simulatedHuman: "alice" },
    });
    const again = await verifier.verify({
      action: ACTION,
      idkitResponse: { action: ACTION, simulatedHuman: "alice" },
    });

    expect(first.ok).toBe(true);
    expect(again).toEqual(first);
    expect(
      await verifier.verify({
        action: ACTION,
        idkitResponse: { action: "other", simulatedHuman: "alice" },
      }),
    ).toEqual({ ok: false, code: "ACTION_MISMATCH" });
    expect(
      await verifier.verify({
        action: ACTION,
        idkitResponse: { action: ACTION },
      }),
    ).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
  });
});
