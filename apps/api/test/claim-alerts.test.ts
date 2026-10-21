import { toFunctionSelector } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { draftRefFor } from "../src/campaigns/onchain.js";
import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";
import { InMemoryChainEventRepository } from "../src/chain/events-repository.js";
import { RpcError } from "../src/chain/rpc.js";
import {
  createClaimSigner,
  SignerUnavailableError,
  type ClaimSigner,
} from "../src/claims/signer.js";
import {
  campaignAction,
  type WorldIdResult,
  type WorldIdVerifier,
} from "../src/identity/world-id.js";
import { PayoutAnomalyDetector } from "../src/observability/payout-anomaly.js";
import { signedInAs } from "./support/auth.js";
import { FakeChain } from "./support/fake-chain.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

class FakeWorldId implements WorldIdVerifier {
  async verify(request: {
    action: string;
    idkitResponse: unknown;
  }): Promise<WorldIdResult> {
    const proof = request.idkitResponse as { action: string; human: string };
    return proof.action === request.action
      ? { ok: true, nullifier: proof.human }
      : { ok: false, code: "ACTION_MISMATCH" };
  }
}

class SignerChain extends FakeChain {
  onchainSigner: string | null = null;

  override async call(
    to: string,
    data: string,
    block?: bigint,
  ): Promise<string> {
    if (data.startsWith(toFunctionSelector("authorizedSigner()"))) {
      if (this.onchainSigner === null) throw new RpcError("down");
      return `0x${"0".repeat(24)}${this.onchainSigner.slice(2).toLowerCase()}`;
    }
    if (data.startsWith(toFunctionSelector("claimedWallet(uint256,address)"))) {
      return `0x${"0".repeat(64)}`;
    }
    return super.call(to, data, block);
  }
}

const SALT = "claim-alerts-secret-0123456789abcdef";

interface LogLine {
  level: number;
  msg: string;
  requestId?: string;
  [key: string]: unknown;
}

const ERROR = 50;
const WARN = 40;

const REAL = createClaimSigner(`0x${"11".repeat(32)}`);
const OTHER_SIGNER = `0x${"44".repeat(20)}`;
const CONTRACT = `0x${"c8".repeat(20)}`;
const ADVERTISER = "0x1234567890abcdef1234567890abcdef12345678";
const CORRECT = [{ questionId: "q1", choiceId: "a" }];
const wallet = (n: number) =>
  `0x${(0x8900 + n).toString(16).padStart(40, "0")}`;

async function setup(options: {
  claimSigner: ClaimSigner;
  onchainSigner: string | null;
  dailyPayoutLimitAtomic?: bigint;
  payoutAnomalies?: PayoutAnomalyDetector;
}) {
  const logs: LogLine[] = [];
  let now = new Date("2026-10-05T10:00:00.000Z");
  const rpc = new SignerChain(CONTRACT);
  rpc.onchainSigner = options.onchainSigner;
  const campaigns = new InMemoryCampaignRepository();
  const events = new InMemoryChainEventRepository();
  const app = buildApp({
    logStream: {
      write: (line) => {
        logs.push(JSON.parse(line) as LogLine);
      },
    },
    authenticate: signedInAs(),
    campaignRepository: campaigns,
    worldIdVerifier: new FakeWorldId(),
    participantKeySecret: SALT,
    claimSigner: options.claimSigner,
    dailyPayoutLimitAtomic: options.dailyPayoutLimitAtomic ?? null,
    ...(options.payoutAnomalies
      ? { payoutAnomalies: options.payoutAnomalies }
      : {}),
    chain: {
      rpc,
      chain: {
        chainId: 84532,
        contractAddress: CONTRACT,
        usdcAddress: `0x${"d8".repeat(20)}`,
      },
      events,
      now: () => now,
    },
    now: () => now,
  });
  apps.push(app);

  const created = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: { "idempotency-key": "campaign" },
    payload: {
      advertiser: ADVERTISER,
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
  const campaignId = created.json<{ id: string }>().id;
  await campaigns.linkOnchain(campaignId, {
    onchainCampaignId: "8",
    contractAddress: CONTRACT,
    publishTxHash: null,
    status: "active",
    updatedAt: now,
  } as never);
  rpc.campaignIdByDraft.set(`${ADVERTISER}:${draftRefFor(campaignId)}`, {
    id: 8,
    block: 0n,
  });
  rpc.campaignStructs.set("8", {
    advertiser: ADVERTISER,
    fundedBudget: 10_000_000n,
    rewardPerCompletion: 1_000_000n,
    maxCompletions: 10,
    startTime: Date.parse("2026-10-05T10:15:00.000Z") / 1000,
    endTime: Date.parse("2026-10-05T11:15:00.000Z") / 1000,
  });
  now = new Date("2026-10-05T10:30:00.000Z");

  async function participate(human: number) {
    const claimant = wallet(human);
    const verified = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: {
        claimant,
        idkitResponse: {
          action: campaignAction(campaignId),
          human: `claim-alerts-human-${human}`,
        },
      },
    });
    const eligibilityToken = verified.json<{ eligibilityToken: string }>()
      .eligibilityToken;
    const body = { eligibilityToken, claimant, answers: CORRECT };
    const key = `claim-alerts-${human}`;
    const submit = () =>
      app.inject({
        method: "POST",
        url: `/v1/campaigns/${campaignId}/submissions`,
        headers: { "idempotency-key": key },
        payload: body,
      });
    return { eligibilityToken, submit, submitted: await submit() };
  }

  const authorize = (submissionId: string, eligibilityToken: string) =>
    app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions/${submissionId}/authorization`,
      payload: { eligibilityToken },
    });

  async function series(name: string): Promise<Record<string, number>> {
    const response = await app.inject({ method: "GET", url: "/metrics" });
    const result: Record<string, number> = {};
    for (const line of response.body.split("\n")) {
      const match = line.match(new RegExp(`^${name}\\{(.+)\\} (\\d+)$`));
      if (match) result[match[1]!] = Number(match[2]);
    }
    return result;
  }

  return {
    rpc,
    events,
    logs,
    campaignId,
    participate,
    authorize,
    series,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

const AUTHORIZATIONS = "vham_claim_authorizations_total";
const ANOMALIES = "vham_payout_anomalies_total";

describe("alerts see authorization outcomes on every route (#89)", () => {
  it("counts a signer mismatch at acceptance", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: OTHER_SIGNER });
    const { submitted } = await s.participate(1);
    expect(submitted.statusCode).toBe(503);
    expect(await s.series(AUTHORIZATIONS)).toEqual({
      'outcome="SIGNER_MISMATCH"': 1,
    });
  });

  it("counts an unavailable signer at acceptance", async () => {
    const failing: ClaimSigner = {
      address: REAL.address,
      sign: async () => {
        throw new SignerUnavailableError("KMS timeout");
      },
    };
    const s = await setup({
      claimSigner: failing,
      onchainSigner: REAL.address,
    });
    const { submitted } = await s.participate(2);
    expect(submitted.statusCode).toBe(503);
    expect(await s.series(AUTHORIZATIONS)).toEqual({
      'outcome="SIGNER_UNAVAILABLE"': 1,
    });
  });

  it("counts the daily payout limit at acceptance", async () => {
    const s = await setup({
      claimSigner: REAL,
      onchainSigner: REAL.address,
      dailyPayoutLimitAtomic: 1_500_000n,
    });
    expect((await s.participate(3)).submitted.statusCode).toBe(201);
    expect((await s.participate(4)).submitted.statusCode).toBe(503);
    expect(await s.series(AUTHORIZATIONS)).toEqual({
      'outcome="DAILY_LIMIT_REACHED"': 1,
      'outcome="success"': 1,
    });
  });

  it("counts a refused re-authorization on a submissions replay with its code", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: REAL.address });
    const first = await s.participate(5);
    expect(first.submitted.statusCode).toBe(201);
    s.rpc.onchainSigner = OTHER_SIGNER;
    s.setNow(new Date("2026-10-05T10:46:00.000Z"));

    const replay = await first.submit();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      claim: { status: "pending_authorization", code: "SIGNER_MISMATCH" },
    });
    expect(await s.series(AUTHORIZATIONS)).toEqual({
      'outcome="SIGNER_MISMATCH"': 1,
      'outcome="success"': 1,
    });
  });

  it("feeds the payout anomaly detector once per created authorization", async () => {
    const s = await setup({
      claimSigner: REAL,
      onchainSigner: REAL.address,
      payoutAnomalies: new PayoutAnomalyDetector({
        windowMs: 6 * 60 * 60_000,
        perCampaign: 2,
        global: 100,
      }),
    });
    const accepted: Awaited<ReturnType<typeof s.participate>>[] = [];
    for (const human of [6, 7, 8]) accepted.push(await s.participate(human));
    const idOf = (r: (typeof accepted)[number]) =>
      r.submitted.json<{ submissionId: string }>().submissionId;
    expect(await s.series(ANOMALIES)).toEqual({ 'scope="campaign"': 1 });

    for (const r of accepted) {
      expect((await r.submit()).statusCode).toBe(200);
      expect((await s.authorize(idOf(r), r.eligibilityToken)).statusCode).toBe(
        200,
      );
    }
    expect(await s.series(ANOMALIES)).toEqual({ 'scope="campaign"': 1 });

    s.setNow(new Date("2026-10-05T10:46:00.000Z"));
    const [first, second] = accepted;
    const viaRoute = await s.authorize(idOf(first!), first!.eligibilityToken);
    expect(viaRoute.statusCode).toBe(201);
    expect(await s.series(ANOMALIES)).toEqual({ 'scope="campaign"': 2 });

    const viaReplay = await second!.submit();
    expect(viaReplay.json()).toMatchObject({ claim: { status: "authorized" } });
    expect(await s.series(ANOMALIES)).toEqual({ 'scope="campaign"': 3 });
  });
});

describe("authorization failures are logged with the request id (#89)", () => {
  const lines = (logs: LogLine[], event: string) =>
    logs.filter((line) => line.event === event);
  const idOf = (response: { json: <T>() => T }) =>
    response.json<{ submissionId: string }>().submissionId;

  it("logs an operator refusal at acceptance once, at error level", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: OTHER_SIGNER });
    const { submitted } = await s.participate(11);
    expect(submitted.statusCode).toBe(503);

    expect(lines(s.logs, "submissions")).toEqual([
      expect.objectContaining({
        level: ERROR,
        outcome: "SIGNER_MISMATCH",
        statusCode: 503,
        campaignId: s.campaignId,
        requestId: submitted.headers["x-request-id"],
      }),
    ]);
    expect(lines(s.logs, "claim_authorizations")).toEqual([]);
  });

  it("logs a refused re-authorization on a replay that answers 200", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: REAL.address });
    const first = await s.participate(12);
    s.rpc.onchainSigner = OTHER_SIGNER;
    s.setNow(new Date("2026-10-05T10:46:00.000Z"));

    const replay = await first.submit();
    expect(replay.statusCode).toBe(200);
    const found = lines(s.logs, "claim_authorizations");
    expect(found).toEqual([
      expect.objectContaining({
        level: ERROR,
        outcome: "SIGNER_MISMATCH",
        campaignId: s.campaignId,
        requestId: replay.headers["x-request-id"],
      }),
    ]);
    expect(found[0]).not.toHaveProperty("statusCode");
    expect(lines(s.logs, "submissions")).toEqual([]);
  });

  it("logs the payout anomaly of an acceptance with counts and request id", async () => {
    const s = await setup({
      claimSigner: REAL,
      onchainSigner: REAL.address,
      payoutAnomalies: new PayoutAnomalyDetector({
        windowMs: 6 * 60 * 60_000,
        perCampaign: 1,
        global: 100,
      }),
    });
    await s.participate(13);
    const second = await s.participate(14);

    expect(s.logs.filter((line) => line.alert === "payout_anomaly")).toEqual([
      expect.objectContaining({
        level: ERROR,
        scope: "campaign",
        campaignId: s.campaignId,
        count: 2,
        limit: 1,
        requestId: second.submitted.headers["x-request-id"],
      }),
    ]);
  });

  it("logs the payout anomaly of a route-issued authorization with its request id", async () => {
    const s = await setup({
      claimSigner: REAL,
      onchainSigner: REAL.address,
      payoutAnomalies: new PayoutAnomalyDetector({
        windowMs: 6 * 60 * 60_000,
        perCampaign: 2,
        global: 100,
      }),
    });
    const first = await s.participate(15);
    await s.participate(16);
    s.setNow(new Date("2026-10-05T10:46:00.000Z"));
    const response = await s.authorize(
      idOf(first.submitted),
      first.eligibilityToken,
    );
    expect(response.statusCode).toBe(201);

    expect(s.logs.filter((line) => line.alert === "payout_anomaly")).toEqual([
      expect.objectContaining({
        count: 3,
        limit: 2,
        requestId: response.headers["x-request-id"],
      }),
    ]);
  });

  it("logs a non-operator 5xx of the authorization route at error level", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: REAL.address });
    const { submitted, eligibilityToken } = await s.participate(17);
    await s.events.haltForReorg(
      { chainId: 84532, contractAddress: CONTRACT },
      12n,
      new Date("2026-10-05T10:30:00.000Z"),
    );

    const response = await s.authorize(idOf(submitted), eligibilityToken);
    expect(response.statusCode).toBe(503);
    expect(lines(s.logs, "claim_authorizations")).toEqual([
      expect.objectContaining({
        level: ERROR,
        outcome: "CHAIN_HALTED",
        statusCode: 503,
        campaignId: s.campaignId,
        requestId: response.headers["x-request-id"],
      }),
    ]);
  });

  it("logs a refused authorization request at warn level", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: REAL.address });
    const { submitted } = await s.participate(18);

    const response = await s.authorize(
      idOf(submitted),
      "00000000-0000-4000-8000-000000000000",
    );
    expect(response.statusCode).toBe(403);
    expect(lines(s.logs, "claim_authorizations")).toEqual([
      expect.objectContaining({
        level: WARN,
        outcome: "INVALID_ELIGIBILITY",
        statusCode: 403,
        requestId: response.headers["x-request-id"],
      }),
    ]);
  });

  it("logs a thrown error at error level", async () => {
    const throwing: ClaimSigner = {
      address: REAL.address,
      sign: async () => {
        throw new Error("signer exploded");
      },
    };
    const s = await setup({
      claimSigner: throwing,
      onchainSigner: REAL.address,
    });
    const { submitted } = await s.participate(19);
    expect(submitted.statusCode).toBe(500);
    expect(lines(s.logs, "submissions")).toEqual([
      expect.objectContaining({
        level: ERROR,
        statusCode: 500,
        requestId: submitted.headers["x-request-id"],
      }),
    ]);
  });

  it("counts a refusal once however many lines it logs", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: REAL.address });
    const { submitted } = await s.participate(20);
    await s.authorize(idOf(submitted), "00000000-0000-4000-8000-000000000000");
    expect(await s.series(AUTHORIZATIONS)).toEqual({
      'outcome="success"': 1,
      'outcome="INVALID_ELIGIBILITY"': 1,
    });
  });

  it("never writes a signature or the participant key salt to a log line", async () => {
    const s = await setup({ claimSigner: REAL, onchainSigner: REAL.address });
    const first = await s.participate(21);
    const signature = first.submitted.json<{
      claim: { authorization: { signature: string } };
    }>().claim.authorization.signature;
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    s.rpc.onchainSigner = OTHER_SIGNER;
    s.setNow(new Date("2026-10-05T10:46:00.000Z"));
    await first.submit();
    await s.authorize(idOf(first.submitted), first.eligibilityToken);

    expect(s.logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(s.logs);
    expect(text).not.toContain(signature);
    expect(text).not.toContain(SALT);
    expect(text).not.toContain("claim-alerts-human");
  });
});
