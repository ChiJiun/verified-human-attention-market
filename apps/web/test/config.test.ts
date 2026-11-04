import { SUPPORTED_CHAINS } from "@vham/shared/chains";
import { baseSepolia, foundry } from "viem/chains";
import { describe, expect, it } from "vitest";

import { formatUsdc, resolveChain } from "../lib/config";

describe("NEXT_PUBLIC_CHAIN_ID", () => {
  it("defaults to Base Sepolia when unset", () => {
    expect(resolveChain(undefined)).toBe(baseSepolia);
  });

  it.each([
    ["84532", baseSepolia],
    ["31337", foundry],
  ])("maps %s to viem's chain", (configured, expected) => {
    expect(resolveChain(configured)).toBe(expected);
  });

  it.each([
    // Base mainnet: deliberately absent from the supported list (#29).
    "8453",
    "1",
    "",
    "base-sepolia",
    "NaN",
    "84532.0",
    " 84532",
    "0x14a34",
  ])("fails fast on %j instead of falling back to Base Sepolia", (value) => {
    expect(() => resolveChain(value)).toThrow(
      `NEXT_PUBLIC_CHAIN_ID must be one of 31337, 84532, got "${value}"`,
    );
  });

  it("knows a viem chain for every chain @vham/shared supports", () => {
    for (const supported of Object.values(SUPPORTED_CHAINS)) {
      expect(resolveChain(String(supported.chainId)).id).toBe(
        supported.chainId,
      );
    }
  });
});

describe("USDC amounts", () => {
  it.each([
    ["1000000", "1 USDC"],
    ["1500000", "1.5 USDC"],
    ["1", "0.000001 USDC"],
    ["0", "0 USDC"],
  ])("shows %s atomic units as %s", (atomic, shown) => {
    expect(formatUsdc(atomic)).toBe(shown);
  });
});
