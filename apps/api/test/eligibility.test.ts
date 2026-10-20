import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { signedInAs } from "./support/auth.js";
import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";
import { InMemoryEligibilityRepository } from "../src/eligibility/repository.js";
import {
  campaignAction,
  type WorldIdResult,
  type WorldIdVerifier,
} from "../src/identity/world-id.js";
import { worldIdSignal } from "../src/identity/world-id-signal.js";

const apps: ReturnType<typeof buildApp>[] = [];
const now = new Date("2026-10-05T10:00:00.000Z");
const SECRET = "eligibility-test-secret-0123456789abcdef";
const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Fake World ID: the "proof" is just { action, human, signal }. */
class FakeWorldId implements WorldIdVerifier {
  calls: { action: string; signal: Hex; idkitResponse: unknown }[] = [];

  async verify(request: {
    action: string;
    signal: Hex;
    idkitResponse: unknown;
  }): Promise<WorldIdResult> {
    this.calls.push(request);
    const proof = request.idkitResponse as {
      action?: string;
      human?: string;
      signal?: string;
    };

    if (proof.human === "invalid") {
      return { ok: false, code: "VERIFICATION_FAILED" };
    }

    if (proof.human === "outage") {
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    if (proof.action !== request.action) {
      return { ok: false, code: "ACTION_MISMATCH" };
    }

    if (proof.signal !== request.signal) {
      return { ok: false, code: "SIGNAL_MISMATCH" };
    }

    return { ok: true, nullifier: String(proof.human) };
  }
}

const campaignPayload = {
  advertiser: "0x1234567890ABCDEF1234567890ABCDEF12345678",
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
};

async function setup(
  options: { secret?: string | null; clock?: () => Date } = {},
) {
  const worldId = new FakeWorldId();
  const eligibilityRepository = new InMemoryEligibilityRepository();
  let current = now;
  const app = buildApp({
    authenticate: signedInAs(),
    campaignRepository: new InMemoryCampaignRepository(),
    eligibilityRepository,
    worldIdVerifier: worldId,
    participantKeySecret:
      options.secret === undefined ? SECRET : options.secret,
    now: options.clock ?? (() => current),
  });
  apps.push(app);

  const created = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: { "idempotency-key": "campaign" },
    payload: campaignPayload,
  });
  const campaignId = created.json<{ id: string }>().id;

  return {
    app,
    worldId,
    eligibilityRepository,
    campaignId,
    setNow: (value: Date) => {
      current = value;
    },
    verify: (body: unknown) =>
      app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/eligibility/verify`,
        payload: body as Record<string, unknown>,
      }),
  };
}

/** The proof `human` produced for `claimant`'s wallet. */
function proof(campaignId: string, human: string, claimant = WALLET_A) {
  return {
    action: campaignAction(campaignId),
    human,
    signal: worldIdSignal(SECRET, campaignId, claimant),
  };
}

describe("POST /v1/campaigns/:id/eligibility/verify", () => {
  it("binds a verified human to one wallet and replays idempotently", async () => {
    const { campaignId, verify, worldId, eligibilityRepository } =
      await setup();

    const first = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "human-1"),
    });
    const second = await verify({
      claimant: WALLET_A.toUpperCase().replace("0X", "0x"),
      idkitResponse: proof(campaignId, "human-1"),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);

    const body = first.json<{
      eligibilityToken: string;
      claimant: string;
      expiresAt: string;
    }>();
    expect(second.json<{ eligibilityToken: string }>().eligibilityToken).toBe(
      body.eligibilityToken,
    );
    expect(body.claimant).toBe(WALLET_A);
    expect(body.expiresAt).toBe(campaignPayload.endAt);
    expect(worldId.calls[0]?.action).toBe(campaignAction(campaignId));

    // Only a derived key is stored; the raw nullifier never is.
    const record = await eligibilityRepository.getById(body.eligibilityToken);
    expect(record?.participantKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain("human-1");
    expect(first.body).not.toContain("human-1");
  });

  it("rejects the same human switching wallets", async () => {
    const { campaignId, verify } = await setup();
    await verify({ claimant: WALLET_A, idkitResponse: proof(campaignId, "h") });

    const response = await verify({
      claimant: WALLET_B,
      idkitResponse: proof(campaignId, "h", WALLET_B),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "PARTICIPANT_WALLET_MISMATCH" },
    });
  });

  it("refuses a proof made for another wallet and writes nothing", async () => {
    const { campaignId, verify } = await setup();

    const relayed = await verify({
      claimant: WALLET_B,
      idkitResponse: proof(campaignId, "h", WALLET_A),
    });

    expect(relayed.statusCode).toBe(403);
    expect(relayed.json()).toMatchObject({
      error: { code: "SIGNAL_MISMATCH" },
    });

    // Wallet B is still free for that human, proving no record was written.
    const own = await verify({
      claimant: WALLET_B,
      idkitResponse: proof(campaignId, "h", WALLET_B),
    });
    expect(own.statusCode).toBe(201);
  });

  it("rejects one wallet being used by a second human", async () => {
    const { campaignId, verify } = await setup();
    await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "h1"),
    });

    const response = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "h2"),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "WALLET_ALREADY_BOUND" },
    });
  });

  it("does not create eligibility when World ID verification fails", async () => {
    const { campaignId, verify, eligibilityRepository } = await setup();

    const invalid = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "invalid"),
    });
    const outage = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "outage"),
    });
    const wrongAction = await verify({
      claimant: WALLET_A,
      idkitResponse: { action: "vham-campaign-other", human: "h" },
    });

    expect(invalid.statusCode).toBe(403);
    expect(outage.statusCode).toBe(503);
    expect(wrongAction.statusCode).toBe(403);
    expect(invalid.body).not.toContain('invalid"');

    // Wallet A is still free, proving no record was written.
    const ok = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "h"),
    });
    expect(ok.statusCode).toBe(201);
    expect(
      await eligibilityRepository.getById(
        ok.json<{ eligibilityToken: string }>().eligibilityToken,
      ),
    ).not.toBeNull();
  });

  it("fails closed when the participant key secret is missing", async () => {
    const { campaignId, verify, worldId } = await setup({ secret: null });

    const response = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "h"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "WORLD_ID_NOT_CONFIGURED" },
    });
    expect(worldId.calls).toHaveLength(0);
  });

  it("refuses eligibility after the campaign has ended", async () => {
    const { campaignId, verify, setNow } = await setup();
    setNow(new Date(campaignPayload.endAt));

    const response = await verify({
      claimant: WALLET_A,
      idkitResponse: proof(campaignId, "h"),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "CAMPAIGN_NOT_OPEN" },
    });
  });

  it("validates the request and campaign id", async () => {
    const { app, verify } = await setup();

    expect(
      (await verify({ claimant: "nope", idkitResponse: {} })).statusCode,
    ).toBe(400);
    expect((await verify({ claimant: WALLET_A })).statusCode).toBe(400);

    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/campaigns/${id}/eligibility/verify`,
        payload: { claimant: WALLET_A, idkitResponse: {} },
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
