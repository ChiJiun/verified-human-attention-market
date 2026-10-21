import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  loadWorldIdConfig,
  WorldIdConfigError,
} from "../src/identity/world-id-config.js";
import { signedInAs } from "./support/auth.js";

const KEY: Hex = `0x${"ab".repeat(32)}`;
const LIVE = {
  WORLD_ID_RP_ID: "rp_0123456789abcdef",
  RP_SIGNING_KEY: KEY,
  WORLD_ID_APP_ID: "app_staging_0123456789abcdef",
};

function problemsOf(env: Record<string, string | undefined>, chainId = 84532) {
  try {
    loadWorldIdConfig(env, chainId);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(WorldIdConfigError);
    return (error as WorldIdConfigError).problems;
  }
}

describe("loadWorldIdConfig", () => {
  it("is disabled, with one warning, when no live variable is set", () => {
    for (const env of [
      {},
      { WORLD_ID_RP_ID: "", RP_SIGNING_KEY: "", WORLD_ID_APP_ID: "" },
      { WORLD_ID_MODE: "live", WORLD_ID_ENVIRONMENT: "staging" },
    ]) {
      expect(loadWorldIdConfig(env, 84532)).toEqual({
        config: null,
        warnings: [
          "World ID is disabled: set WORLD_ID_RP_ID, RP_SIGNING_KEY and WORLD_ID_APP_ID",
        ],
      });
    }
  });

  it("parses a complete live configuration", () => {
    const { config, warnings } = loadWorldIdConfig(
      { ...LIVE, WORLD_ID_ENVIRONMENT: "staging" },
      84532,
    );

    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      mode: "live",
      rpId: "rp_0123456789abcdef",
      appId: "app_staging_0123456789abcdef",
      environment: "staging",
    });
    expect(config?.mode === "live" && config.signer.address).toBe(
      privateKeyToAccount(KEY).address,
    );
    expect(loadWorldIdConfig(LIVE, 8453).config).toMatchObject({
      environment: "production",
    });
  });

  it("refuses a partial live configuration instead of half-enabling it", () => {
    expect(problemsOf({ WORLD_ID_RP_ID: LIVE.WORLD_ID_RP_ID })).toEqual([
      "RP_SIGNING_KEY is required when World ID is live",
      "WORLD_ID_APP_ID is required when World ID is live",
    ]);
    expect(
      problemsOf({
        RP_SIGNING_KEY: KEY,
        WORLD_ID_APP_ID: LIVE.WORLD_ID_APP_ID,
      }),
    ).toEqual(["WORLD_ID_RP_ID is required when World ID is live"]);
  });

  it.each([
    "app_0123456789abcdef",
    "rp_test123",
    "rp_",
    "rp_0123456789abcdef0",
    "rp_+12",
    "../admin",
  ])("refuses the rp id %s", (rpId) => {
    expect(problemsOf({ ...LIVE, WORLD_ID_RP_ID: rpId })).toEqual([
      "WORLD_ID_RP_ID must be rp_ followed by 1 to 16 hex digits",
    ]);
  });

  it.each(["rp_1", "rp_ABCDEF0123456789"])("accepts the rp id %s", (rpId) => {
    expect(problemsOf({ ...LIVE, WORLD_ID_RP_ID: rpId })).toEqual([]);
  });

  it.each(["rp_0123456789abcdef", "app_", "app_ id", "APP_x"])(
    "refuses the app id %s",
    (appId) => {
      expect(problemsOf({ ...LIVE, WORLD_ID_APP_ID: appId })).toEqual([
        "WORLD_ID_APP_ID must start with app_",
      ]);
    },
  );

  it("refuses a malformed signing key, environment or mode", () => {
    expect(problemsOf({ ...LIVE, RP_SIGNING_KEY: "0x1234" })).toEqual([
      "RP_SIGNING_KEY must be 32 bytes of hex",
    ]);
    expect(problemsOf({ ...LIVE, WORLD_ID_ENVIRONMENT: "sandbox" })).toEqual([
      "WORLD_ID_ENVIRONMENT must be production or staging",
    ]);
    expect(problemsOf({ WORLD_ID_MODE: "off" })).toEqual([
      "WORLD_ID_MODE must be live or simulated",
    ]);
  });

  it("allows the simulation on the local anvil chain only", () => {
    expect(loadWorldIdConfig({ WORLD_ID_MODE: "simulated" }, 31337)).toEqual({
      config: { mode: "simulated" },
      warnings: ["WORLD_ID_MODE=simulated: local anvil demo only"],
    });
    expect(problemsOf({ WORLD_ID_MODE: "simulated" }, 84532)).toEqual([
      "WORLD_ID_MODE=simulated is only allowed on the local chain 31337",
    ]);
  });
});

describe("buildApp with a World ID config", () => {
  const verifyBody = {
    claimant: `0x${"a".repeat(40)}`,
    signalSalt: `0x${"11".repeat(32)}`,
    idkitResponse: { not: "a proof" },
  };

  async function verifyOnce(app: ReturnType<typeof buildApp>) {
    const created = await app.inject({
      method: "POST",
      url: "/v1/campaigns",
      headers: { "idempotency-key": "world-id-config" },
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
    const response = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${created.json<{ id: string }>().id}/eligibility/verify`,
      payload: verifyBody,
    });
    await app.close();
    return response;
  }

  const options = {
    authenticate: signedInAs(),
    participantKeySecret: "world-id-config-secret-0123456789abcdef",
    now: () => new Date("2026-10-05T10:00:00.000Z"),
  };

  it("verifies live proofs with World when the config is live", async () => {
    const response = await verifyOnce(
      buildApp({ ...options, worldId: loadWorldIdConfig(LIVE, 84532).config }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_PROOF_PAYLOAD" },
    });
  });

  it("refuses every proof when World ID is not configured", async () => {
    const response = await verifyOnce(buildApp({ ...options, worldId: null }));

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "WORLD_ID_NOT_CONFIGURED" },
    });
  });

  it("builds the simulation for its own chain id, so only anvil can run it", async () => {
    expect(() => buildApp({ worldId: { mode: "simulated" } })).toThrow(
      "Simulated World ID is only allowed on the local chain 31337",
    );
    await buildApp({ worldId: { mode: "simulated" }, chainId: 31337 }).close();
  });
});
