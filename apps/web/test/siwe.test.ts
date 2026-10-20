import type { WalletClient } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/api";
import {
  restoreSession,
  sessionForWallet,
  signInWithEthereum,
} from "../lib/siwe";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const session = { address: ADDRESS, expiresAt: "2026-10-21T12:00:00.000Z" };
const wallet = {
  signMessage: async () => `0x${"11".repeat(65)}`,
} as unknown as WalletClient;

type Route = (body: unknown) => Response;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

function fakeApi(routes: Record<string, Route>) {
  const requests: { route: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const route = `${init.method ?? "GET"} ${url}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ route, body });
    const answer = routes[route];
    if (!answer) throw new Error(`unexpected request ${route}`);
    return answer(body);
  });
  return requests;
}

const signInRoutes = (
  verify: Route,
  sessionCheck: Route,
): Record<string, Route> => ({
  "POST /api/v1/auth/nonce": () => json(200, { nonce: "abcdefgh12345678" }),
  "POST /api/v1/auth/verify": verify,
  "GET /api/v1/auth/session": sessionCheck,
});

const cookieVerify: Route = () =>
  json(200, { transport: "cookie", chainId: 84532, ...session });

beforeEach(() => {
  vi.stubGlobal("window", {
    location: { host: "app.vham.test", origin: "https://app.vham.test" },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signInWithEthereum", () => {
  it("asks for a cookie session and returns the session the cookie holds", async () => {
    const requests = fakeApi(
      signInRoutes(cookieVerify, () =>
        json(200, { chainId: 84532, ...session }),
      ),
    );

    await expect(signInWithEthereum(wallet, ADDRESS)).resolves.toEqual(session);
    expect(
      requests.find(({ route }) => route === "POST /api/v1/auth/verify")?.body,
    ).toMatchObject({ transport: "cookie" });
  });

  it("refuses an API that answers with a bearer token", async () => {
    fakeApi(
      signInRoutes(
        () =>
          json(200, { token: "t".repeat(43), tokenType: "Bearer", ...session }),
        () => json(204),
      ),
    );

    await expect(signInWithEthereum(wallet, ADDRESS)).rejects.toThrow(
      /did not start a cookie session/,
    );
  });

  it.each([
    ["no cookie", () => json(204)],
    [
      "a cookie without a session",
      () => json(401, { error: { code: "UNAUTHENTICATED" } }),
    ],
  ])(
    "reports a browser that sends back %s after sign-in",
    async (_label, sessionCheck) => {
      fakeApi(signInRoutes(cookieVerify, sessionCheck));

      await expect(signInWithEthereum(wallet, ADDRESS)).rejects.toThrow(
        /did not keep the session cookie/,
      );
    },
  );
});

describe("restoreSession", () => {
  it("returns the session the cookie holds", async () => {
    fakeApi({
      "GET /api/v1/auth/session": () =>
        json(200, { chainId: 84532, ...session }),
    });

    await expect(restoreSession()).resolves.toEqual(session);
  });

  it.each([
    ["no credential", () => json(204)],
    ["a stale cookie", () => json(401, { error: { code: "UNAUTHENTICATED" } })],
  ])("returns no session for %s", async (_label, answer) => {
    fakeApi({ "GET /api/v1/auth/session": answer });

    await expect(restoreSession()).resolves.toBeNull();
  });

  it("throws when the API fails", async () => {
    fakeApi({
      "GET /api/v1/auth/session": () =>
        json(503, { error: { code: "UNAVAILABLE" } }),
    });

    await expect(restoreSession()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("sessionForWallet", () => {
  it("returns the session of the connected wallet, whatever its case", () => {
    expect(sessionForWallet(session, { address: ADDRESS })).toBe(session);
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
    expect(sessionForWallet(null, { address: ADDRESS })).toBeNull();
  });
});
