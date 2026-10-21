import { worldIdSignal, type WorldIdSignalSalt } from "@vham/shared/world-id";
import { describe, expect, it, vi } from "vitest";

import {
  campaignAction,
  HttpWorldIdVerifier,
  LocalSimulatedWorldIdVerifier,
  normalizeFieldElement,
  signalHash,
} from "../src/identity/world-id.js";

const CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
const ACTION = campaignAction(CAMPAIGN_ID);
const NULLIFIER_HEX =
  "0x2bf8406809dcefb1486dadc96c0a897db9bab002053054cf64272db512c6fbd8";
const NULLIFIER_DEC = BigInt(NULLIFIER_HEX).toString(10);
const WALLET_A = `0x${"a".repeat(40)}`;
const WALLET_B = `0x${"b".repeat(40)}`;
const SALT = `0x${"11".repeat(32)}` as WorldIdSignalSalt;
const BOUND = { campaignId: CAMPAIGN_ID, claimant: WALLET_A, salt: SALT };
const SIGNAL = worldIdSignal(BOUND);
const SIGNAL_HASH = signalHash(SIGNAL);
const EMPTY_SIGNAL_HASH =
  "0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4";

const LEGACY_ITEM = {
  identifier: "orb",
  proof: "0xproof",
  merkle_root: "0xroot",
  nullifier: NULLIFIER_HEX,
  signal_hash: SIGNAL_HASH,
};

function responseItem(overrides: Record<string, unknown> = {}) {
  return {
    identifier: "proof_of_human",
    issuer_schema_id: 1,
    proof: ["0x111", "0x222", "0x333", "0x444", "0x555"],
    nullifier: NULLIFIER_HEX,
    signal_hash: SIGNAL_HASH,
    expires_at_min: 1791194400,
    ...overrides,
  };
}

function idkitResponse(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "4.0",
    nonce: "0x1234",
    action: ACTION,
    environment: "production",
    responses: [responseItem()],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function worldAccepting() {
  return vi.fn(async () =>
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
    const fetchMock = worldAccepting();

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({ action: ACTION, signal: SIGNAL, idkitResponse: payload });

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

  it("accepts the signal hash in decimal form", async () => {
    const result = await verifierWith(
      worldAccepting() as unknown as typeof fetch,
    ).verify({
      action: ACTION,
      signal: SIGNAL,
      idkitResponse: idkitResponse({
        responses: [
          responseItem({ signal_hash: BigInt(SIGNAL_HASH).toString(10) }),
        ],
      }),
    });

    expect(result).toEqual({ ok: true, nullifier: NULLIFIER_DEC });
  });

  it.each([
    ["no signal", [responseItem({ signal_hash: undefined })]],
    ["a zero signal hash", [responseItem({ signal_hash: "0x0" })]],
    [
      "the empty-signal default",
      [responseItem({ signal_hash: EMPTY_SIGNAL_HASH })],
    ],
    [
      "another wallet's signal",
      [
        responseItem({
          signal_hash: signalHash(
            worldIdSignal({ ...BOUND, claimant: WALLET_B }),
          ),
        }),
      ],
    ],
    [
      "another salt",
      [
        responseItem({
          signal_hash: signalHash(
            worldIdSignal({
              ...BOUND,
              salt: `0x${"22".repeat(32)}` as WorldIdSignalSalt,
            }),
          ),
        }),
      ],
    ],
    [
      "another campaign's signal",
      [
        responseItem({
          signal_hash: signalHash(
            worldIdSignal({
              ...BOUND,
              campaignId: "00000000-0000-4000-8000-000000000002",
            }),
          ),
        }),
      ],
    ],
    [
      "one bound and one unbound credential",
      [responseItem(), responseItem({ signal_hash: undefined })],
    ],
  ])(
    "refuses a proof made with %s without calling World",
    async (_label, responses) => {
      const fetchMock = vi.fn();

      const result = await verifierWith(
        fetchMock as unknown as typeof fetch,
      ).verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: idkitResponse({ responses }),
      });

      expect(result).toEqual({ ok: false, code: "SIGNAL_MISMATCH" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects proofs for another action without calling World", async () => {
    const fetchMock = vi.fn();

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({
      action: ACTION,
      signal: SIGNAL,
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
      signal: SIGNAL,
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
      signal: SIGNAL,
      idkitResponse: idkitResponse({
        protocol_version: "3.0",
        responses: [
          {
            identifier: "orb",
            proof: "0xproof",
            merkle_root: "0xroot",
            nullifier: legacyNullifier,
            signal_hash: SIGNAL_HASH,
          },
        ],
      }),
    });

    expect(result).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a legacy item", [LEGACY_ITEM]],
    ["a legacy item next to a 4.0 item", [responseItem(), LEGACY_ITEM]],
  ])(
    "refuses a 4.0 payload that carries %s without calling World",
    async (_label, responses) => {
      const fetchMock = worldAccepting();

      const result = await verifierWith(
        fetchMock as unknown as typeof fetch,
      ).verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: idkitResponse({ responses }),
      });

      expect(result).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a proof of four elements", { proof: ["0x1", "0x2", "0x3", "0x4"] }],
    [
      "a proof of six elements",
      { proof: ["0x1", "0x2", "0x3", "0x4", "0x5", "0x6"] },
    ],
    ["a proof that is one string", { proof: "0xproof" }],
    [
      "a proof element that is not a string",
      { proof: ["0x1", "0x2", "0x3", "0x4", 5] },
    ],
    ["no identifier", { identifier: undefined }],
    ["no issuer_schema_id", { issuer_schema_id: undefined }],
    ["a fractional issuer_schema_id", { issuer_schema_id: 1.5 }],
    ["no expires_at_min", { expires_at_min: undefined }],
    ["an expires_at_min that is a string", { expires_at_min: "1791194400" }],
    ["a signal_hash that is not a string", { signal_hash: 0 }],
  ])(
    "refuses a 4.0 item with %s without calling World",
    async (_label, overrides) => {
      const fetchMock = worldAccepting();

      const result = await verifierWith(
        fetchMock as unknown as typeof fetch,
      ).verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: idkitResponse({ responses: [responseItem(overrides)] }),
      });

      expect(result).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("forwards the optional and unknown fields of a 4.0 payload unchanged", async () => {
    const payload = idkitResponse({
      user_presence_completed: true,
      responses: [responseItem({ signal_hash: SIGNAL_HASH, sybil_score: 3 })],
    });
    const fetchMock = worldAccepting();

    const result = await verifierWith(
      fetchMock as unknown as typeof fetch,
    ).verify({ action: ACTION, signal: SIGNAL, idkitResponse: payload });

    expect(result).toEqual({ ok: true, nullifier: NULLIFIER_DEC });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual(payload);
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
    ).verify({ action: ACTION, signal: SIGNAL, idkitResponse: payload });

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
      signal: SIGNAL,
      idkitResponse: idkitResponse(),
    });

    expect(result).toEqual({ ok: false, code });
  });

  it("treats network errors and timeouts as provider unavailability", async () => {
    const result = await verifierWith((async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch).verify({
      action: ACTION,
      signal: SIGNAL,
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

describe("normalizeFieldElement", () => {
  it("canonicalizes hex and decimal forms", () => {
    expect(normalizeFieldElement(NULLIFIER_HEX)).toBe(NULLIFIER_DEC);
    expect(normalizeFieldElement(NULLIFIER_DEC)).toBe(NULLIFIER_DEC);
    expect(normalizeFieldElement("0x0A")).toBe("10");
  });

  it("rejects non-numeric values", () => {
    expect(normalizeFieldElement("abc")).toBeNull();
    expect(normalizeFieldElement("0x")).toBeNull();
    expect(normalizeFieldElement("-1")).toBeNull();
  });
});

describe("LocalSimulatedWorldIdVerifier", () => {
  const alice = { action: ACTION, simulatedHuman: "alice", signal: SIGNAL };

  it("can only be constructed for the local anvil chain", () => {
    expect(() => new LocalSimulatedWorldIdVerifier(84532)).toThrow();
    expect(() => new LocalSimulatedWorldIdVerifier(8453)).toThrow();
    expect(() => new LocalSimulatedWorldIdVerifier(31337)).not.toThrow();
  });

  it("checks the action and derives a stable nullifier", async () => {
    const verifier = new LocalSimulatedWorldIdVerifier(31337);
    const first = await verifier.verify({
      action: ACTION,
      signal: SIGNAL,
      idkitResponse: alice,
    });
    const again = await verifier.verify({
      action: ACTION,
      signal: SIGNAL,
      idkitResponse: alice,
    });

    expect(first.ok).toBe(true);
    expect(again).toEqual(first);
    expect(
      await verifier.verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: { ...alice, action: "other" },
      }),
    ).toEqual({ ok: false, code: "ACTION_MISMATCH" });
    expect(
      await verifier.verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: { action: ACTION, signal: SIGNAL },
      }),
    ).toEqual({ ok: false, code: "INVALID_PROOF_PAYLOAD" });
  });

  it("refuses a simulated proof whose signal is another wallet's, missing or malformed as a signal mismatch", async () => {
    const verifier = new LocalSimulatedWorldIdVerifier(31337);

    expect(
      await verifier.verify({
        action: ACTION,
        signal: worldIdSignal({ ...BOUND, claimant: WALLET_B }),
        idkitResponse: alice,
      }),
    ).toEqual({ ok: false, code: "SIGNAL_MISMATCH" });
    expect(
      await verifier.verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: { action: ACTION, simulatedHuman: "alice" },
      }),
    ).toEqual({ ok: false, code: "SIGNAL_MISMATCH" });
    expect(
      await verifier.verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: { ...alice, signal: "0x1234" },
      }),
    ).toEqual({ ok: false, code: "SIGNAL_MISMATCH" });
  });

  it("accepts the bound signal in either hex case", async () => {
    const verifier = new LocalSimulatedWorldIdVerifier(31337);

    expect(
      await verifier.verify({
        action: ACTION,
        signal: SIGNAL,
        idkitResponse: {
          ...alice,
          signal: SIGNAL.toUpperCase().replace("0X", "0x"),
        },
      }),
    ).toMatchObject({ ok: true });
  });
});
