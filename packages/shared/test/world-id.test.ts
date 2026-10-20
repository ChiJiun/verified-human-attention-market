import {
  concatHex,
  getAddress,
  padHex,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  newWorldIdSignalSalt,
  worldIdSignal,
  worldIdSignalSaltSchema,
  worldIdSignalSchema,
  type WorldIdSignalSalt,
} from "../src/world-id.js";

const CAMPAIGN = "00000000-0000-4000-8000-000000000071";
const CLAIMANT: Hex = `0x${"a".repeat(40)}`;
const SALT = `0x${"0123456789abcdef".repeat(4)}` as WorldIdSignalSalt;
/**
 * keccak256 of the ABI layout written out in the first test, computed with
 * @noble/hashes keccak_256 over hand-assembled bytes (no viem involved).
 */
const SIGNAL =
  "0xef3c395e4e9277232b7fc1a85d2d5fb5d9b472584cbabc40020d6a8b3d6e41d1";

const word = (value: bigint | Hex) =>
  padHex(typeof value === "bigint" ? toHex(value) : value, { size: 32 });
const utf8Word = (text: string) => {
  const hex = stringToHex(text);
  const length = (hex.length - 2) / 2;
  return concatHex([
    word(BigInt(length)),
    padHex(hex, { dir: "right", size: 32 * Math.ceil(length / 32) }),
  ]);
};

describe("worldIdSignal", () => {
  it("is keccak256(abi.encode(domain, campaignId, claimant, salt))", () => {
    const signal = worldIdSignal({
      campaignId: CAMPAIGN,
      claimant: CLAIMANT,
      salt: SALT,
    });

    expect(signal).toBe(SIGNAL);
    expect(
      concatHex([
        word(128n),
        word(192n),
        word(CLAIMANT),
        SALT,
        utf8Word("vham:world-id-signal:v2"),
        utf8Word(CAMPAIGN),
      ]),
    ).toHaveLength(2 + 288 * 2);
  });

  it("gives the same signal whatever the case of the address or the campaign id", () => {
    for (const claimant of [
      getAddress(CLAIMANT),
      CLAIMANT.toUpperCase().replace("0X", "0x"),
    ]) {
      expect(
        worldIdSignal({ campaignId: CAMPAIGN, claimant, salt: SALT }),
      ).toBe(SIGNAL);
    }
    expect(
      worldIdSignal({
        campaignId: CAMPAIGN.toUpperCase(),
        claimant: CLAIMANT,
        salt: SALT,
      }),
    ).toBe(SIGNAL);
  });

  it("differs per wallet, per campaign and per salt", () => {
    expect(
      worldIdSignal({
        campaignId: CAMPAIGN,
        claimant: `0x${"b".repeat(40)}`,
        salt: SALT,
      }),
    ).not.toBe(SIGNAL);
    expect(
      worldIdSignal({
        campaignId: "00000000-0000-4000-8000-000000000072",
        claimant: CLAIMANT,
        salt: SALT,
      }),
    ).not.toBe(SIGNAL);
    expect(
      worldIdSignal({
        campaignId: CAMPAIGN,
        claimant: CLAIMANT,
        salt: `0x${"11".repeat(32)}` as WorldIdSignalSalt,
      }),
    ).not.toBe(SIGNAL);
  });
});

describe("newWorldIdSignalSalt", () => {
  it("returns 32 random bytes as 0x hex, fresh on every call", () => {
    const salt = newWorldIdSignalSalt();

    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newWorldIdSignalSalt()).not.toBe(salt);
  });
});

describe("salt and signal schemas", () => {
  it("accept a 0x 32-byte hex string", () => {
    const salt: WorldIdSignalSalt = worldIdSignalSaltSchema.parse(SALT);
    expect(salt).toBe(SALT);
    expect(worldIdSignalSchema.parse(SIGNAL)).toBe(SIGNAL);
  });

  it.each([
    ["31 bytes", `0x${"11".repeat(31)}`],
    ["33 bytes", `0x${"11".repeat(33)}`],
    ["no 0x prefix", "11".repeat(32)],
    ["non-hex characters", `0x${"11".repeat(31)}zz`],
    ["not a string", 11],
  ])("refuse %s", (_label, value) => {
    expect(worldIdSignalSaltSchema.safeParse(value).success).toBe(false);
    expect(worldIdSignalSchema.safeParse(value).success).toBe(false);
  });
});
