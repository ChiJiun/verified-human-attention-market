import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

import { buildApp } from "../src/app.js";
import { SESSION_COOKIE, webOriginFrom } from "../src/auth/credential.js";

const DOMAIN = "app.vham.test";
const WEB_ORIGIN = `https://${DOMAIN}`;
const CHAIN_ID = 84532;
const advertiser = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const browserAdvertiser = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const otherBrowser = privateKeyToAccount(`0x${"d4".repeat(32)}`);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  options: {
    configured?: boolean;
    webOrigin?: string | null;
    operators?: string[];
  } = {},
) {
  let now = new Date("2026-10-05T10:00:00.000Z");
  const app = buildApp({
    siwe:
      options.configured === false
        ? null
        : { domain: DOMAIN, chainId: CHAIN_ID, sessionTtlMs: 60 * 60_000 },
    webOrigin: options.webOrigin === undefined ? WEB_ORIGIN : options.webOrigin,
    moderation: {
      mode: "open",
      operators: options.operators ?? [],
      advertiserAllowlist: [],
    },
    now: () => now,
  });
  apps.push(app);

  async function nonce() {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/nonce",
    });
    return response.json<{ nonce: string }>().nonce;
  }

  async function message(
    account = advertiser,
    overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {},
  ) {
    return createSiweMessage({
      address: account.address,
      chainId: CHAIN_ID,
      domain: DOMAIN,
      uri: `https://${DOMAIN}`,
      version: "1",
      nonce: await nonce(),
      issuedAt: now,
      ...overrides,
    });
  }

  function verify(
    text: string,
    signature: string,
    options: {
      transport?: "bearer" | "cookie";
      headers?: Record<string, string>;
    } = {},
  ) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      headers: options.headers ?? {},
      payload: {
        message: text,
        signature,
        ...(options.transport ? { transport: options.transport } : {}),
      },
    });
  }

  async function signIn(account = advertiser) {
    const text = await message(account);
    const response = await verify(
      text,
      await account.signMessage({ message: text }),
    );
    return response.json<{ token: string }>().token;
  }

  async function signInWithCookie(account: typeof advertiser) {
    const text = await message(account);
    const response = await verify(
      text,
      await account.signMessage({ message: text }),
      { transport: "cookie", headers: { "sec-fetch-site": "same-origin" } },
    );
    const token = /^__Host-vham_session=([^;]*)/.exec(
      String(response.headers["set-cookie"]),
    )?.[1];
    return { response, token: token ?? "" };
  }

  const campaignPayload = (owner: string) => ({
    advertiser: owner,
    contentUrl: "https://example.com/sponsored",
    rewardPerCompletion: "1000000",
    maxCompletions: 10,
    startAt: "2026-10-05T10:15:00.000Z",
    endAt: "2026-10-05T11:15:00.000Z",
    mission: {
      questions: [
        {
          id: "q1",
          prompt: "Pick a",
          choices: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      ],
      answerKey: { q1: "a" },
    },
  });

  function createCampaign(
    headers: Record<string, string>,
    owner = advertiser.address,
  ) {
    return app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": randomUUID(), ...headers },
      payload: campaignPayload(owner),
    });
  }

  function session(headers: Record<string, string>) {
    return app.inject({ method: "GET", url: "/v1/auth/session", headers });
  }

  function logout(headers: Record<string, string>, payload?: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  return {
    app,
    nonce,
    message,
    verify,
    signIn,
    signInWithCookie,
    createCampaign,
    session,
    logout,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

describe("Sign-In with Ethereum", () => {
  it("issues a session for a valid signature and exposes it", async () => {
    const { app, message, verify } = setup();
    const text = await message();

    const response = await verify(
      text,
      await advertiser.signMessage({ message: text }),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; address: string }>();
    expect(body.address).toBe(advertiser.address.toLowerCase());

    const session = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(session.json()).toMatchObject({
      address: advertiser.address.toLowerCase(),
      chainId: CHAIN_ID,
    });
  });

  it("rejects a replayed message because the nonce is single-use", async () => {
    const { message, verify } = setup();
    const text = await message();
    const signature = await advertiser.signMessage({ message: text });

    expect((await verify(text, signature)).statusCode).toBe(200);

    const replay = await verify(text, signature);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({
      error: { code: "NONCE_INVALID_OR_USED" },
    });
  });

  it("rejects a nonce the server never issued", async () => {
    const { verify } = setup();
    const text = createSiweMessage({
      address: advertiser.address,
      chainId: CHAIN_ID,
      domain: DOMAIN,
      uri: `https://${DOMAIN}`,
      version: "1",
      nonce: "forgednonce12345",
      issuedAt: new Date("2026-10-05T10:00:00.000Z"),
    });

    const response = await verify(
      text,
      await advertiser.signMessage({ message: text }),
    );
    expect(response.json()).toMatchObject({
      error: { code: "NONCE_INVALID_OR_USED" },
    });
  });

  it.each([
    ["another domain", { domain: "evil.example" }, "WRONG_DOMAIN"],
    ["another chain", { chainId: 1 }, "WRONG_CHAIN"],
    [
      "an expired message",
      { expirationTime: new Date("2026-10-05T09:59:00.000Z") },
      "MESSAGE_NOT_VALID_NOW",
    ],
    [
      "a future issuedAt",
      { issuedAt: new Date("2026-10-05T10:05:00.000Z") },
      "MESSAGE_NOT_VALID_NOW",
    ],
  ])("rejects %s", async (_label, overrides, code) => {
    const { message, verify } = setup();
    const text = await message(advertiser, overrides);

    const response = await verify(
      text,
      await advertiser.signMessage({ message: text }),
    );

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code } });
  });

  it("rejects a signature from a different wallet", async () => {
    const { message, verify } = setup();
    const text = await message(advertiser);

    const response = await verify(
      text,
      await stranger.signMessage({ message: text }),
    );

    expect(response.json()).toMatchObject({
      error: { code: "INVALID_SIGNATURE" },
    });
  });

  it("rejects malformed messages", async () => {
    const { verify } = setup();

    expect((await verify("hello", "0x1234")).statusCode).toBe(400);
    expect((await verify("", "0x")).statusCode).toBe(400);
  });

  it("expires and revokes sessions", async () => {
    const { app, signIn, setNow } = setup();
    const token = await signIn();
    const session = () =>
      app.inject({
        method: "GET",
        url: "/v1/auth/session",
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await session()).statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((await session()).statusCode).toBe(401);

    const second = await signIn();
    setNow(new Date("2026-10-05T11:00:01.000Z"));
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/auth/session",
          headers: { authorization: `Bearer ${second}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("fails closed when SIWE is not configured", async () => {
    const { message, verify, createCampaign } = setup({ configured: false });
    const text = await message();

    expect(
      (
        await verify(text, await advertiser.signMessage({ message: text }))
      ).json(),
    ).toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
    expect((await createCampaign({})).statusCode).toBe(401);
  });
});

describe("advertiser-only endpoints", () => {
  it("only lets the signed-in wallet create campaigns as itself", async () => {
    const { signIn, createCampaign } = setup();
    const token = await signIn(advertiser);

    expect((await createCampaign({})).statusCode).toBe(401);
    expect(
      (await createCampaign(bearer("not-a-real-token-xxxxxxxx"))).statusCode,
    ).toBe(401);

    const impersonation = await createCampaign(bearer(token), stranger.address);
    expect(impersonation.statusCode).toBe(403);
    expect(impersonation.json()).toMatchObject({
      error: { code: "NOT_CAMPAIGN_ADVERTISER" },
    });

    expect((await createCampaign(bearer(token))).statusCode).toBe(201);
  });

  it("restricts analytics, publish and linking to the campaign advertiser", async () => {
    const { app, signIn, createCampaign } = setup();
    const ownerToken = await signIn(advertiser);
    const strangerToken = await signIn(stranger);
    const id = (await createCampaign(bearer(ownerToken))).json<{ id: string }>()
      .id;

    for (const [method, url] of [
      ["GET", `/v1/campaigns/${id}/analytics`],
      ["POST", `/v1/campaigns/${id}/publish`],
      ["POST", `/v1/campaigns/${id}/onchain`],
    ] as const) {
      const body = method === "POST" ? { payload: {} } : {};
      const anonymous = await app.inject({ method, url, ...body });
      const foreign = await app.inject({
        method,
        url,
        ...body,
        headers: { authorization: `Bearer ${strangerToken}` },
      });

      expect(anonymous.statusCode).toBe(401);
      expect(foreign.statusCode).toBe(403);
    }

    const own = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${id}/analytics`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(own.statusCode).toBe(200);
  });
});

describe("session cookie credential", () => {
  it("authenticates GET requests from the cookie and never caches them", async () => {
    const { signIn, session } = setup();
    const token = await signIn(browserAdvertiser);

    const response = await session(cookie(token));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      address: browserAdvertiser.address.toLowerCase(),
    });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("reads only the Authorization header when one is present", async () => {
    const { signIn, session } = setup();
    const headerToken = await signIn(browserAdvertiser);
    const cookieToken = await signIn(otherBrowser);

    const both = await session({
      ...bearer(headerToken),
      ...cookie(cookieToken),
    });
    expect(both.json()).toMatchObject({
      address: browserAdvertiser.address.toLowerCase(),
    });

    const invalidHeader = await session({
      authorization: "Bearer not-a-real-token-xxxxxxxx",
      ...cookie(cookieToken),
    });
    expect(invalidHeader.statusCode).toBe(401);
  });

  it("treats API-key-shaped or ambiguous cookies as no credential", async () => {
    const { signIn, createCampaign } = setup();
    const token = await signIn(browserAdvertiser);

    for (const header of [
      `${SESSION_COOKIE}=vhamk_test_${token}`,
      `${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}`,
      `vham_session=${token}`,
    ]) {
      const response = await createCampaign(
        { cookie: header, "sec-fetch-site": "same-origin" },
        browserAdvertiser.address,
      );
      expect(response.statusCode).toBe(401);
    }
  });

  it.each([
    ["a cross-site request", { "sec-fetch-site": "cross-site" }, 403],
    ["a same-site request", { "sec-fetch-site": "same-site" }, 403],
    ["a same-origin request", { "sec-fetch-site": "same-origin" }, 201],
    ["the web origin without Fetch Metadata", { origin: WEB_ORIGIN }, 201],
    [
      "another origin without Fetch Metadata",
      { origin: "https://evil.example" },
      403,
    ],
    ["no Fetch Metadata and no Origin", {}, 403],
  ])("cookie mutation from %s", async (_label, headers, status) => {
    const { signIn, createCampaign } = setup();
    const token = await signIn(browserAdvertiser);

    const response = await createCampaign(
      { ...cookie(token), ...headers },
      browserAdvertiser.address,
    );

    expect(response.statusCode).toBe(status);
    if (status === 403) {
      expect(response.json()).toMatchObject({
        error: { code: "CSRF_REJECTED", retryable: false },
      });
    }
  });

  it("accepts no Origin fallback without WEB_ORIGIN", async () => {
    const { signIn, createCampaign } = setup({ webOrigin: null });
    const token = await signIn(browserAdvertiser);

    const response = await createCampaign(
      { ...cookie(token), origin: WEB_ORIGIN },
      browserAdvertiser.address,
    );

    expect(response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });

  it("leaves bearer requests out of the CSRF check", async () => {
    const { signIn, createCampaign } = setup();
    const token = await signIn(browserAdvertiser);

    const response = await createCampaign(
      { ...bearer(token), "sec-fetch-site": "cross-site" },
      browserAdvertiser.address,
    );

    expect(response.statusCode).toBe(201);
  });

  it.each([
    ["https://app.vham.test", "app.vham.test", "https://app.vham.test"],
    ["http://localhost:3000", "localhost:3000", "http://localhost:3000"],
    ["https://app.vham.test/", "app.vham.test", null],
    ["https://app.vham.test/path", "app.vham.test", null],
    ["https://other.vham.test", "app.vham.test", null],
    ["ftp://app.vham.test", "app.vham.test", null],
    ["app.vham.test", "app.vham.test", null],
    ["https://app.vham.test", null, null],
  ])("WEB_ORIGIN %s with SIWE domain %s", (value, domain, expected) => {
    expect(webOriginFrom(value, domain)).toBe(expected);
  });
});

describe("cookie transport", () => {
  it("sets the session cookie and keeps the token out of the body", async () => {
    const { signInWithCookie, session, createCampaign } = setup();

    const { response, token } = await signInWithCookie(browserAdvertiser);

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toMatch(
      /^__Host-vham_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      transport: "cookie",
      address: browserAdvertiser.address.toLowerCase(),
      chainId: CHAIN_ID,
      expiresAt: "2026-10-05T11:00:00.000Z",
    });

    expect((await session(cookie(token))).statusCode).toBe(200);
    const created = await createCampaign(
      { ...cookie(token), "sec-fetch-site": "same-origin" },
      browserAdvertiser.address,
    );
    expect(created.statusCode).toBe(201);
  });

  it("keeps the bearer transport as the default", async () => {
    const { message, verify } = setup();
    const text = await message(browserAdvertiser);

    const response = await verify(
      text,
      await browserAdvertiser.signMessage({ message: text }),
    );

    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      tokenType: "Bearer",
    });
  });

  it("refuses a cross-site cookie sign-in and leaves the nonce usable", async () => {
    const { message, verify } = setup();
    const text = await message(browserAdvertiser);
    const signature = await browserAdvertiser.signMessage({ message: text });

    const crossSite = await verify(text, signature, {
      transport: "cookie",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json()).toMatchObject({
      error: { code: "CSRF_REJECTED" },
    });
    expect(crossSite.headers["set-cookie"]).toBeUndefined();

    const sameOrigin = await verify(text, signature, {
      transport: "cookie",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it("revokes the cookie session that a new cookie sign-in replaces", async () => {
    const { message, verify, signInWithCookie, session } = setup();
    const { token: previous } = await signInWithCookie(browserAdvertiser);
    const text = await message(otherBrowser);

    const response = await verify(
      text,
      await otherBrowser.signMessage({ message: text }),
      {
        transport: "cookie",
        headers: { ...cookie(previous), "sec-fetch-site": "same-origin" },
      },
    );

    expect(response.statusCode).toBe(200);
    expect((await session(cookie(previous))).statusCode).toBe(401);
  });

  it("keeps the cookie session when a new sign-in fails", async () => {
    const { message, verify, signInWithCookie, session } = setup();
    const { token: previous } = await signInWithCookie(browserAdvertiser);
    const text = await message(otherBrowser);

    const response = await verify(
      text,
      await stranger.signMessage({ message: text }),
      {
        transport: "cookie",
        headers: { ...cookie(previous), "sec-fetch-site": "same-origin" },
      },
    );

    expect(response.statusCode).toBe(401);
    expect((await session(cookie(previous))).statusCode).toBe(200);
  });

  it("logs out by clearing the cookie and revoking the session", async () => {
    const { app, signInWithCookie, session } = setup();
    const { token } = await signInWithCookie(browserAdvertiser);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { ...cookie(token), "sec-fetch-site": "same-origin" },
    });

    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toBe(
      "__Host-vham_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
    );
    expect((await session(cookie(token))).statusCode).toBe(401);
  });
});

describe("logout", () => {
  const sameOrigin = { "sec-fetch-site": "same-origin" };

  it("revokes the cookie session along with a bearer session", async () => {
    const { signIn, signInWithCookie, session, logout } = setup();
    const headerToken = await signIn(otherBrowser);
    const { token: cookieToken } = await signInWithCookie(browserAdvertiser);

    const response = await logout({
      ...bearer(headerToken),
      ...cookie(cookieToken),
      ...sameOrigin,
    });

    expect(response.statusCode).toBe(204);
    expect((await session(bearer(headerToken))).statusCode).toBe(401);
    expect((await session(cookie(cookieToken))).statusCode).toBe(401);
  });

  it("revokes the cookie session when the Authorization header is invalid", async () => {
    const { signInWithCookie, session, logout } = setup();
    const { token } = await signInWithCookie(browserAdvertiser);

    await logout({
      authorization: "Bearer not-a-real-token-xxxxxxxx",
      ...cookie(token),
      ...sameOrigin,
    });

    expect((await session(cookie(token))).statusCode).toBe(401);
  });

  it("revokes every session cookie the request carries", async () => {
    const { signInWithCookie, session, logout } = setup();
    const { token: first } = await signInWithCookie(browserAdvertiser);
    const { token: second } = await signInWithCookie(otherBrowser);

    await logout({
      cookie: `${SESSION_COOKIE}=${first}; ${SESSION_COOKIE}=${second}`,
      ...sameOrigin,
    });

    expect((await session(cookie(first))).statusCode).toBe(401);
    expect((await session(cookie(second))).statusCode).toBe(401);
  });

  it("sends no clearing cookie to a request without one", async () => {
    const { logout } = setup();

    const crossSiteForm = await logout(
      {
        "content-type": "text/plain",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        origin: "https://evil.example",
      },
      "",
    );

    expect(crossSiteForm.statusCode).toBe(204);
    expect(crossSiteForm.headers["set-cookie"]).toBeUndefined();
  });

  it.each([
    ["a malformed session cookie", `${SESSION_COOKIE}=not-a-session-token`],
    ["two session cookies", `${SESSION_COOKIE}=a; ${SESSION_COOKIE}=b`],
  ])(
    "refuses a cross-site logout carrying %s",
    async (_label, cookieHeader) => {
      const { logout } = setup();

      const response = await logout({
        cookie: cookieHeader,
        "sec-fetch-site": "cross-site",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "CSRF_REJECTED" },
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
    },
  );

  it("refuses a cross-site mutation that carries the cookie next to a bearer token", async () => {
    const { signIn, signInWithCookie, createCampaign } = setup();
    const headerToken = await signIn(browserAdvertiser);
    const { token: cookieToken } = await signInWithCookie(browserAdvertiser);

    const response = await createCampaign(
      {
        ...bearer(headerToken),
        ...cookie(cookieToken),
        "sec-fetch-site": "cross-site",
      },
      browserAdvertiser.address,
    );

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
  });
});

describe("routes that take header credentials only", () => {
  const sameOrigin = { "sec-fetch-site": "same-origin" };

  it("keeps API key management off the session cookie", async () => {
    const { app, signIn, signInWithCookie } = setup();
    const { token: cookieToken } = await signInWithCookie(browserAdvertiser);
    const headerToken = await signIn(browserAdvertiser);
    const keyRequest = { name: "integration", scopes: ["campaigns:write"] };

    const created = await app.inject({
      method: "POST",
      url: "/v1/api-clients",
      headers: bearer(headerToken),
      payload: keyRequest,
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    for (const [method, url, payload] of [
      ["POST", "/v1/api-clients", keyRequest],
      ["GET", "/v1/api-clients", undefined],
      ["DELETE", `/v1/api-clients/${id}`, undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { ...cookie(cookieToken), ...sameOrigin },
        ...(payload ? { payload } : {}),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: { code: "COOKIE_SESSION_NOT_ALLOWED", retryable: false },
      });
    }
  });

  it("keeps operator routes off the session cookie", async () => {
    const { app, signIn, signInWithCookie } = setup({
      operators: [browserAdvertiser.address.toLowerCase()],
    });
    const { token: cookieToken } = await signInWithCookie(browserAdvertiser);
    const headerToken = await signIn(browserAdvertiser);

    const withHeader = await app.inject({
      method: "GET",
      url: "/v1/admin/moderation",
      headers: bearer(headerToken),
    });
    const withCookie = await app.inject({
      method: "GET",
      url: "/v1/admin/moderation",
      headers: cookie(cookieToken),
    });

    expect(withHeader.statusCode).toBe(200);
    expect(withCookie.statusCode).toBe(403);
    expect(withCookie.json()).toMatchObject({
      error: { code: "COOKIE_SESSION_NOT_ALLOWED" },
    });
  });
});

describe("session check", () => {
  const cleared =
    "__Host-vham_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";

  it("answers 204 when the request presents no credential", async () => {
    const { session } = setup();

    const response = await session({});

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
  });

  it("answers 401 to an Authorization header that is not a session", async () => {
    const { session } = setup();

    const response = await session(bearer("not-a-real-token-xxxxxxxx"));

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("clears an expired session cookie", async () => {
    const { signInWithCookie, session, createCampaign, setNow } = setup();
    const { token } = await signInWithCookie(browserAdvertiser);
    setNow(new Date("2026-10-05T11:00:01.000Z"));

    const check = await session(cookie(token));
    const mutation = await createCampaign(
      { ...cookie(token), "sec-fetch-site": "same-origin" },
      browserAdvertiser.address,
    );

    expect(check.statusCode).toBe(401);
    expect(check.headers["set-cookie"]).toBe(cleared);
    expect(mutation.statusCode).toBe(401);
    expect(mutation.headers["set-cookie"]).toBe(cleared);
  });

  it("clears a session cookie that holds no session token", async () => {
    const { session } = setup();

    const response = await session({
      cookie: `${SESSION_COOKIE}=not-a-session-token`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBe(cleared);
  });

  it("keeps the cookie when the 401 is about the Authorization header", async () => {
    const { signInWithCookie, session } = setup();
    const { token } = await signInWithCookie(browserAdvertiser);

    const response = await session({
      authorization: "Basic dXNlcjpwYXNz",
      ...cookie(token),
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
