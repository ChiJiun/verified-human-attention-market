import { bytesToHex, hexToBytes, stringToBytes, verifyMessage } from "viem";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createRpSigner,
  hashToField,
  rpSignatureMessage,
} from "../src/identity/rp-signature.js";
import { signedInAs } from "./support/auth.js";

/** Official vectors: https://docs.world.org/world-id/idkit/signatures (2026-10-13). */
const KEY = `0x${"ab".repeat(32)}`;
const RANDOM = Uint8Array.from({ length: 32 }, (_unused, index) => index);
const NONCE =
  "0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd";
const CREATED_AT = 1_700_000_000;

describe("World ID RP signatures", () => {
  it("hash_to_field matches the official vectors", () => {
    expect(hashToField(new Uint8Array())).toBe(
      "0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4",
    );
    expect(hashToField(stringToBytes("test_signal"))).toBe(
      "0x00c1636e0a961a3045054c4d61374422c31a95846b8442f0927ad2ff1d6112ed",
    );
    expect(hashToField(hexToBytes("0x010203"))).toBe(
      "0x00f1885eda54b7a053318cd41e2093220dab15d65381b1157a3633a83bfd5c92",
    );
    expect(hashToField(stringToBytes("hello"))).toBe(
      "0x001c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36dea",
    );
    expect(hashToField(RANDOM)).toBe(NONCE);
  });

  it("builds the 49- and 81-byte messages", () => {
    const prefix = `0x01${NONCE.slice(2)}000000006553f100000000006553f22c`;
    const base = {
      nonce: NONCE,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 300,
    } as const;

    expect(bytesToHex(rpSignatureMessage(base))).toBe(prefix);
    expect(
      bytesToHex(rpSignatureMessage({ ...base, action: "test-action" })),
    ).toBe(
      `${prefix}00aa0ce59768ae5b1c52f07a9387f14f09f277422c0d2f8a268c7bad0c60a46a`,
    );
  });

  it("signs session and uniqueness requests exactly like the reference", async () => {
    const signer = createRpSigner(KEY.slice(2));
    const now = new Date(CREATED_AT * 1000);

    const session = await signer.sign({ now, random: RANDOM });
    expect(session).toEqual({
      nonce: NONCE,
      createdAt: CREATED_AT,
      expiresAt: CREATED_AT + 300,
      sig: "0x14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9e4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa4021b",
    });

    const uniqueness = await signer.sign({
      now,
      random: RANDOM,
      action: "test-action",
    });
    expect(uniqueness.sig).toBe(
      "0x05594adb6c1495768a38d523d7d6ee6356b2c31231919198794ed022ade7d08f73753f83bd167067d99c9b969d28e9222315837c66af25867b041273a6d5056f1b",
    );
  });

  it("uses a fresh nonce per request and rejects malformed keys", async () => {
    const signer = createRpSigner(KEY);
    const now = new Date();
    const [first, second] = await Promise.all([
      signer.sign({ now, action: "a" }),
      signer.sign({ now, action: "a" }),
    ]);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.nonce.slice(0, 4)).toBe("0x00");
    expect(() => createRpSigner("0x1234")).toThrow();
  });
});

describe("POST /v1/campaigns/:id/world-id/request", () => {
  async function setup(configured: boolean) {
    const signer = createRpSigner(KEY);
    const now = new Date("2026-10-05T10:00:00.000Z");
    const app = buildApp({
      authenticate: signedInAs(),
      worldIdRequest: configured
        ? {
            signer,
            rpId: "rp_test123",
            appId: "app_test123",
            environment: "staging",
          }
        : null,
      now: () => now,
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "rp-request" },
      payload: {
        advertiser: "0x1234567890abcdef1234567890abcdef12345678",
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
      },
    });
    return { app, signer, id: created.json<{ id: string }>().id };
  }

  it("returns the campaign action and a verifiable rp_context", async () => {
    const { app, signer, id } = await setup(true);
    const response = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/world-id/request`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      appId: string;
      action: string;
      environment: string;
      rpContext: {
        rp_id: string;
        nonce: `0x${string}`;
        created_at: number;
        expires_at: number;
        signature: `0x${string}`;
      };
    }>();
    expect(body).toMatchObject({
      appId: "app_test123",
      environment: "staging",
      action: `vham-campaign-${id}`,
      rpContext: { rp_id: "rp_test123", expires_at: 1_791_194_400 + 300 },
    });
    expect(response.body).not.toContain(KEY.slice(2));
    expect(
      await verifyMessage({
        address: signer.address,
        message: {
          raw: rpSignatureMessage({
            nonce: body.rpContext.nonce,
            createdAt: body.rpContext.created_at,
            expiresAt: body.rpContext.expires_at,
            action: body.action,
          }),
        },
        signature: body.rpContext.signature,
      }),
    ).toBe(true);
    await app.close();
  });

  it("fails closed when RP signing is not configured", async () => {
    const { app, id } = await setup(false);
    const response = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${id}/world-id/request`,
    });
    expect(response.json()).toMatchObject({
      error: { code: "WORLD_ID_NOT_CONFIGURED" },
    });
    const missing = await app.inject({
      method: "POST",
      url: "/v1/campaigns/00000000-0000-4000-8000-000000000999/world-id/request",
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
