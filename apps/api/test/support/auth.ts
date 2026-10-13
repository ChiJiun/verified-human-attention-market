import type { Authenticate } from "../../src/auth/siwe.js";

/** Advertiser used by the campaign fixtures in non-auth test files. */
export const TEST_ADVERTISER = "0x1234567890abcdef1234567890abcdef12345678";

/**
 * Treats every request as signed in by `address`. Only for tests of
 * features other than authentication; auth.test.ts uses real SIWE.
 */
export function signedInAs(address: string = TEST_ADVERTISER): Authenticate {
  return async () => ({
    sessionId: "00000000-0000-4000-8000-00000000a11c",
    address: address.toLowerCase(),
    chainId: 84532,
    expiresAt: new Date("2100-01-01T00:00:00.000Z"),
  });
}
