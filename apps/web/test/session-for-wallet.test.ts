import { describe, expect, it } from "vitest";

import { sessionForWallet } from "../lib/siwe";

const session = {
  address: "0x1111111111111111111111111111111111111111",
  expiresAt: "2026-10-21T12:00:00.000Z",
};

describe("sessionForWallet", () => {
  it("returns the session of the connected wallet, whatever its case", () => {
    expect(
      sessionForWallet(session, {
        address: "0x1111111111111111111111111111111111111111",
      }),
    ).toBe(session);
    expect(
      sessionForWallet(
        { ...session, address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" },
        { address: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD" },
      ),
    ).not.toBeNull();
  });

  it("returns no session for another wallet or without a wallet", () => {
    expect(
      sessionForWallet(session, {
        address: "0x2222222222222222222222222222222222222222",
      }),
    ).toBeNull();
    expect(sessionForWallet(session, null)).toBeNull();
    expect(
      sessionForWallet(null, {
        address: "0x1111111111111111111111111111111111111111",
      }),
    ).toBeNull();
  });
});
