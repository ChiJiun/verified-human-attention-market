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

/**
 * Signs a request in as the wallet its bearer token names, so one test can
 * act as several wallets. Without `prefix`, any non-empty token is the
 * address (lowercased). With `prefix`, only `Bearer <prefix><lowercase 0x
 * address>` signs in, and any other bearer token (an API key) is left to the
 * route.
 */
export function bearerSession(options: { prefix?: string } = {}): Authenticate {
  const session = (address: string) => ({
    sessionId: "00000000-0000-4000-8000-000000000001",
    address,
    chainId: 84532,
    expiresAt: new Date("2100-01-01T00:00:00.000Z"),
  });
  const { prefix } = options;

  return async (request) => {
    if (prefix === undefined) {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      return token ? session(token.toLowerCase()) : null;
    }

    const expected = `Bearer ${prefix}`;
    const header = request.headers.authorization ?? "";
    const address = header.startsWith(expected)
      ? header.slice(expected.length)
      : "";
    return /^0x[0-9a-f]{40}$/.test(address) ? session(address) : null;
  };
}
