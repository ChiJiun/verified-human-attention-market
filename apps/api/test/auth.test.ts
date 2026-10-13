import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

import { buildApp } from "../src/app.js";

const DOMAIN = "app.vham.test";
const CHAIN_ID = 84532;
const advertiser = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"b2".repeat(32)}`);

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(options: { configured?: boolean } = {}) {
  let now = new Date("2026-10-05T10:00:00.000Z");
  const app = buildApp({
    siwe:
      options.configured === false
        ? null
        : { domain: DOMAIN, chainId: CHAIN_ID, sessionTtlMs: 60 * 60_000 },
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

  function verify(text: string, signature: string) {
    return app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { message: text, signature },
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

  function createCampaign(token: string | null, owner = advertiser.address) {
    return app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: {
        "idempotency-key": `key-${owner}-${token ?? "none"}`.slice(0, 200),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: campaignPayload(owner),
    });
  }

  return {
    app,
    nonce,
    message,
    verify,
    signIn,
    createCampaign,
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
    expect((await createCampaign(null)).statusCode).toBe(401);
  });
});

describe("advertiser-only endpoints", () => {
  it("only lets the signed-in wallet create campaigns as itself", async () => {
    const { signIn, createCampaign } = setup();
    const token = await signIn(advertiser);

    expect((await createCampaign(null)).statusCode).toBe(401);
    expect((await createCampaign("not-a-real-token-xxxxxxxx")).statusCode).toBe(
      401,
    );

    const impersonation = await createCampaign(token, stranger.address);
    expect(impersonation.statusCode).toBe(403);
    expect(impersonation.json()).toMatchObject({
      error: { code: "NOT_CAMPAIGN_ADVERTISER" },
    });

    expect((await createCampaign(token)).statusCode).toBe(201);
  });

  it("restricts analytics, publish and linking to the campaign advertiser", async () => {
    const { app, signIn, createCampaign } = setup();
    const ownerToken = await signIn(advertiser);
    const strangerToken = await signIn(stranger);
    const id = (await createCampaign(ownerToken)).json<{ id: string }>().id;

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
