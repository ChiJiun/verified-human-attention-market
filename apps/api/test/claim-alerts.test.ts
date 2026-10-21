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

const REAL = createClaimSigner(`0x${"11".repeat(32)}`);
const OTHER_SIGNER = `0x${"44".repeat(20)}`;
const CONTRACT = `0x${"c8".repeat(20)}`;
const ADVERTISER = "0x1234567890abcdef1234567890abcdef12345678";
const CORRECT = [{ questionId: "q1", choiceId: "a" }];
const wallet = (n: number) => `0x${(0x8900 + n).toString(16).padStart(40, "0")}`;

async function setup(options: {
  claimSigner: ClaimSigner;
  onchainSigner: string | null;
  dailyPayoutLimitAtomic?: bigint;
  payoutAnomalies?: PayoutAnomalyDetector;
}) {
  let now = new Date("2026-10-05T10:00:00.000Z");
  const rpc = new SignerChain(CONTRACT);
  rpc.onchainSigner = options.onchainSigner;
  const campaigns = new InMemoryCampaignRepository();
  const app = buildApp({
    authenticate: signedInAs(),
    campaignRepository: campaigns,
    worldIdVerifier: new FakeWorldId(),
    participantKeySecret: "claim-alerts-secret-0123456789abcdef",
    claimSigner: options.claimSigner,
    dailyPayoutLimitAtomic: options.dailyPayoutLimitAtomic ?? null,
    payoutAnomalies: options.payoutAnomalies,
    chain: {
      rpc,
      chain: {
        chainId: 84532,
        contractAddress: CONTRACT,
        usdcAddress: `0x${"d8".repeat(20)}`,
      },
      events: new InMemoryChainEventRepository(),
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
    const s = await setup({ claimSigner: failing, onchainSigner: REAL.address });
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
    const accepted = [];
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
