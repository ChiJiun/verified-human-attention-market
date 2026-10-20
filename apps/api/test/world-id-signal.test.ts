import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { signalHash, worldIdSignal } from "../src/identity/world-id-signal.js";
import { deriveParticipantKey } from "../src/privacy/participant-key.js";

const SECRET = "world-id-signal-test-secret-0123456789abcdef";
const CAMPAIGN = "00000000-0000-4000-8000-000000000071";
const CLAIMANT = `0x${"a".repeat(40)}`;

describe("worldIdSignal", () => {
  it("is one 32-byte value per wallet, whatever the address case", () => {
    const signal = worldIdSignal(SECRET, CAMPAIGN, CLAIMANT);

    expect(signal).toMatch(/^0x[0-9a-f]{64}$/);
    expect(worldIdSignal(SECRET, CAMPAIGN, getAddress(CLAIMANT))).toBe(signal);
  });

  it("differs per wallet, per campaign and per secret", () => {
    const signal = worldIdSignal(SECRET, CAMPAIGN, CLAIMANT);

    expect(worldIdSignal(SECRET, CAMPAIGN, `0x${"b".repeat(40)}`)).not.toBe(
      signal,
    );
    expect(
      worldIdSignal(SECRET, "00000000-0000-4000-8000-000000000072", CLAIMANT),
    ).not.toBe(signal);
    expect(worldIdSignal(`${SECRET}-other`, CAMPAIGN, CLAIMANT)).not.toBe(
      signal,
    );
  });

  it("is domain-separated from the participant key", () => {
    expect(worldIdSignal(SECRET, CAMPAIGN, CLAIMANT).slice(2)).not.toBe(
      deriveParticipantKey(SECRET, CAMPAIGN, CLAIMANT),
    );
  });

  it("refuses a short secret", () => {
    expect(() => worldIdSignal("short", CAMPAIGN, CLAIMANT)).toThrow();
  });
});

describe("signalHash", () => {
  // Vectors from `hashSignal` in @worldcoin/idkit-core 4.4.0
  // (dist/hashing.js), computed on 2026-10-20 with the installed package.
  it("matches IDKit's hashSignal for a 0x hex signal", () => {
    expect(signalHash(`0x${"11".repeat(32)}`)).toBe(
      "0x00b569321de72d0af89c2fb48a484de3fc9343f31600ae1f3e13d633cb48cbf8",
    );

    const signal = worldIdSignal(SECRET, CAMPAIGN, CLAIMANT);
    expect(signal).toBe(
      "0x4121a22cb3c4235896c8d56447fc0a52261a53d0b9615c14339c94ebb92da669",
    );
    expect(signalHash(signal)).toBe(
      "0x0035dc5da2e0cd5b9b9bc2f33db299cf1212a12f3e6c3b54767c268051cfc01a",
    );
  });
});
