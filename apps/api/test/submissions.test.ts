import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { signedInAs } from "./support/auth.js";
import { InMemoryCampaignRepository } from "../src/campaigns/repository.js";
import type { CampaignRecord, CampaignStatus } from "../src/campaigns/types.js";
import { InMemoryEligibilityRepository } from "../src/eligibility/repository.js";
import {
  campaignAction,
  type WorldIdResult,
  type WorldIdVerifier,
} from "../src/identity/world-id.js";
import {
  ClaimIssueError,
  type ClaimIssueInput,
  type ClaimRepository,
} from "../src/claims/repository.js";
import type { ClaimPreparation, ClaimTerms } from "../src/claims/service.js";
import {
  SignerUnavailableError,
  type SignedClaim,
} from "../src/claims/signer.js";
import { InMemorySubmissionRepository } from "../src/submissions/repository.js";
import {
  submitCompletion,
  type SubmissionServiceDependencies,
} from "../src/submissions/service.js";

const apps: ReturnType<typeof buildApp>[] = [];
const SECRET = "submission-test-secret-0123456789abcdef";
const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** Campaign status comes from on-chain reconciliation (#16); simulated here. */
class StatusOverrideCampaignRepository extends InMemoryCampaignRepository {
  status: CampaignStatus = "active";

  override async getById(id: string): Promise<CampaignRecord | null> {
    const record = await super.getById(id);
    return record ? { ...record, status: this.status } : null;
  }
}

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
      {
        id: "q2",
        prompt: "Pick b",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    ],
    answerKey: { q1: "a", q2: "b" },
  },
};

const CORRECT = [
  { questionId: "q1", choiceId: "a" },
  { questionId: "q2", choiceId: "b" },
];
const WRONG = [
  { questionId: "q1", choiceId: "b" },
  { questionId: "q2", choiceId: "b" },
];

async function setup() {
  let now = new Date("2026-10-05T10:00:00.000Z");
  const campaigns = new StatusOverrideCampaignRepository();
  const eligibility = new InMemoryEligibilityRepository();
  const submissions = new InMemorySubmissionRepository(eligibility);
  const app = buildApp({
    authenticate: signedInAs(),
    campaignRepository: campaigns,
    eligibilityRepository: eligibility,
    submissionRepository: submissions,
    worldIdVerifier: new FakeWorldId(),
    participantKeySecret: SECRET,
    now: () => now,
  });
  apps.push(app);

  const created = await app.inject({
    method: "POST",
    url: "/v1/campaigns",
    headers: { "idempotency-key": "campaign" },
    payload: campaignPayload,
  });
  const campaignId = created.json<{ id: string }>().id;
  now = new Date("2026-10-05T10:30:00.000Z");

  async function verify(human: string, claimant: string) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/eligibility/verify`,
      payload: {
        claimant,
        idkitResponse: { action: campaignAction(campaignId), human },
      },
    });
    return response.json<{ eligibilityToken: string }>().eligibilityToken;
  }

  function submit(
    key: string,
    body: { eligibilityToken: string; claimant: string; answers: unknown },
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/campaigns/${campaignId}/submissions`,
      headers: { "idempotency-key": key },
      payload: body,
    });
  }

  return {
    app,
    campaigns,
    eligibility,
    submissions,
    campaignId,
    verify,
    submit,
    setNow: (value: Date) => {
      now = value;
    },
  };
}

function signedFor(claimant: string): SignedClaim {
  return {
    payload: {
      campaignId: 1n,
      draftRef: `0x${"11".repeat(32)}`,
      claimant: claimant as `0x${string}`,
      amount: 1000000n,
      nonce: `0x${"22".repeat(32)}`,
      issuedAt: 1n,
      expiresAt: 901n,
    },
    signature: `0x${"33".repeat(65)}`,
    chainId: 84532,
    contractAddress: `0x${"44".repeat(20)}`,
  };
}

const TERMS: ClaimTerms = {
  campaignId: "prepared-campaign",
  now: new Date("2026-10-05T10:30:00.000Z"),
  canIssue: true,
  alreadyClaimed: false,
  onchainPaidCompletions: 0,
  sign: async () => signedFor(WALLET_A),
};
const SIGNABLE: ClaimPreparation = { ok: true, payable: true, terms: TERMS };

function serviceDependencies(
  s: Awaited<ReturnType<typeof setup>>,
  prepareClaim: SubmissionServiceDependencies["prepareClaim"],
  issueOnce: ClaimRepository["issueOnce"] = async () => {
    throw new Error("no authorization is issued here");
  },
): SubmissionServiceDependencies {
  return {
    campaigns: s.campaigns,
    deployment: null,
    chainHalted: async () => false,
    eligibility: s.eligibility,
    submissions: s.submissions,
    claims: { within: () => ({ issueOnce }) },
    now: () => new Date("2026-10-05T10:30:00.000Z"),
    prepareClaim,
  };
}

describe("acceptance and authorization are one persisted result (ADR-0011)", () => {
  it.each([
    [
      "the campaign closed since the live check",
      new ClaimIssueError("CAMPAIGN_NOT_ACTIVE"),
      409,
      "CAMPAIGN_NOT_ACTIVE",
    ],
    [
      "the signing service is down",
      new SignerUnavailableError("signing service unreachable"),
      503,
      "SIGNER_UNAVAILABLE",
    ],
    [
      "the campaign cap was reached meanwhile",
      new ClaimIssueError("CAMPAIGN_CAP_REACHED"),
      409,
      "CAMPAIGN_CAP_REACHED",
    ],
    [
      "the daily payout limit is reached",
      new ClaimIssueError("DAILY_LIMIT_REACHED"),
      503,
      "DAILY_LIMIT_REACHED",
    ],
  ])(
    "records nothing when %s, and accepts the same request once signing works",
    async (_reason, refusal, status, code) => {
      const s = await setup();
      const token = await s.verify("human-1", WALLET_A);
      let refuse = true;
      const issued: ClaimIssueInput[] = [];
      const claim = signedFor(WALLET_A);
      const dependencies = serviceDependencies(
        s,
        async () => SIGNABLE,
        async (input) => {
          issued.push(input);
          if (refuse) {
            throw refusal;
          }
          return { created: true, claim };
        },
      );
      const input = {
        campaignId: s.campaignId,
        eligibilityToken: token,
        claimantAddress: WALLET_A,
        idempotencyKey: "attempt-1",
        answers: CORRECT,
      };

      // Correct answers, but no authorization can be issued: the acceptance
      // is rolled back, the attempt is not consumed and the reason is given.
      expect(await submitCompletion(dependencies, input)).toEqual({
        ok: false,
        status,
        code,
      });
      expect(issued).toHaveLength(1);
      expect(await s.submissions.findAcceptedByEligibility(token)).toBeNull();
      expect(await s.submissions.countByEligibility(token)).toBe(0);
      expect(
        await s.submissions.findByIdempotencyKey(s.campaignId, "attempt-1"),
      ).toBeNull();

      // The same request succeeds once the authorization can be signed, and
      // the signature is returned with the acceptance.
      refuse = false;
      const accepted = await submitCompletion(dependencies, input);
      expect(accepted).toMatchObject({
        ok: true,
        created: true,
        submission: { result: "accepted" },
      });
      if (!accepted.ok) return;
      expect(accepted.claim).toBe(claim);
      expect(issued).toEqual([
        { ...TERMS, submissionId: issued[0]?.submissionId },
        { ...TERMS, submissionId: accepted.submission.id },
      ]);

      // A replay returns the stored acceptance without signing again.
      expect(await submitCompletion(dependencies, input)).toMatchObject({
        ok: true,
        created: false,
        claim: null,
      });
      expect(issued).toHaveLength(2);
    },
  );

  it("never calls the signer for a rejected completion", async () => {
    const s = await setup();
    const token = await s.verify("human-2", WALLET_B);
    let calls = 0;
    const outcome = await submitCompletion(
      serviceDependencies(
        s,
        async () => SIGNABLE,
        async () => {
          calls += 1;
          throw new SignerUnavailableError("signing service unreachable");
        },
      ),
      {
        campaignId: s.campaignId,
        eligibilityToken: token,
        claimantAddress: WALLET_B,
        idempotencyKey: "wrong-1",
        answers: WRONG,
      },
    );
    expect(outcome).toMatchObject({
      ok: true,
      submission: { result: "rejected", rejectionCode: "COMPREHENSION_FAILED" },
      claim: null,
    });
    expect(calls).toBe(0);
    expect(await s.submissions.countByEligibility(token)).toBe(1);
  });

  it.each([
    [
      "the chain cannot be read",
      { ok: false as const, status: 503, code: "CHAIN_UNAVAILABLE" },
    ],
    [
      "the contract would not pay the campaign",
      { ok: true as const, payable: false, terms: null },
    ],
  ])(
    "records no attempt when %s, before the answers are evaluated",
    async (_reason, preparation) => {
      const s = await setup();
      const token = await s.verify("human-3", WALLET_A);
      const dependencies = serviceDependencies(s, async () => preparation);
      const request = {
        campaignId: s.campaignId,
        eligibilityToken: token,
        claimantAddress: WALLET_A,
        answers: WRONG,
      };

      expect(
        await submitCompletion(dependencies, {
          ...request,
          idempotencyKey: "pre-1",
        }),
      ).toEqual(
        preparation.ok
          ? { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" }
          : preparation,
      );
      expect(await s.submissions.countByEligibility(token)).toBe(0);

      const recorded = await submitCompletion(
        serviceDependencies(s, async () => ({
          ok: true,
          payable: true,
          terms: null,
        })),
        { ...request, idempotencyKey: "pre-2" },
      );
      expect(recorded).toMatchObject({
        ok: true,
        created: true,
        submission: { result: "rejected" },
      });
    },
  );
});

describe("POST /v1/campaigns/:id/submissions", () => {
  it("records quality reason codes for advertisers but never shows them to participants (#25)", async () => {
    const { app, campaignId, verify, submit, setNow } = await setup();

    // Submitted the same second as verification: too fast to have read.
    const fast = await submit("fast", {
      eligibilityToken: await verify("human-fast", WALLET_A),
      claimant: WALLET_A,
      answers: CORRECT,
    });
    expect(fast.statusCode).toBe(201);
    expect(fast.body).not.toContain("FAST_COMPLETION");
    expect(fast.body).not.toContain("quality");

    // Wrong, then right on the second attempt, after a realistic read.
    const token = await verify("human-retry", WALLET_B);
    setNow(new Date("2026-10-05T10:30:30.000Z"));
    await submit("retry-1", {
      eligibilityToken: token,
      claimant: WALLET_B,
      answers: WRONG,
    });
    await submit("retry-2", {
      eligibilityToken: token,
      claimant: WALLET_B,
      answers: CORRECT,
    });

    const analytics = await app.inject({
      method: "GET",
      url: `/v1/campaigns/${campaignId}/analytics`,
    });
    expect(analytics.json()).toMatchObject({
      submissions: {
        accepted: 2,
        rejected: 1,
        flaggedAccepted: 2,
        adjustedAccepted: 0,
        flagReasons: { FAST_COMPLETION: 1, PASSED_ON_RETRY: 1 },
      },
    });
  });

  it("accepts a verified human with correct answers", async () => {
    const { verify, submit } = await setup();
    const token = await verify("human-1", WALLET_A);

    const response = await submit("k1", {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: CORRECT,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "accepted",
      rejectionCode: null,
      claimant: WALLET_A,
      claim: { status: "pending_authorization" },
    });
  });

  it("replays the original outcome for the same idempotency key", async () => {
    const { verify, submit, setNow } = await setup();
    const token = await verify("human-1", WALLET_A);
    const body = {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: CORRECT,
    };

    const first = await submit("k1", body);
    // Even after the campaign ends, a retry returns the stored result.
    setNow(new Date("2026-10-05T12:00:00.000Z"));
    const second = await submit("k1", body);

    expect(second.statusCode).toBe(200);
    expect(second.json<{ submissionId: string }>().submissionId).toBe(
      first.json<{ submissionId: string }>().submissionId,
    );

    const changed = await submit("k1", { ...body, answers: WRONG });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("blocks a second completion by the same human", async () => {
    const { verify, submit } = await setup();
    const token = await verify("human-1", WALLET_A);
    await submit("k1", {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: CORRECT,
    });

    const again = await submit("k2", {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: CORRECT,
    });

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: "ALREADY_COMPLETED" },
    });
  });

  it("rejects wrong answers without revealing which were wrong", async () => {
    const { verify, submit } = await setup();
    const token = await verify("human-1", WALLET_A);

    const response = await submit("k1", {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: WRONG,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      status: "rejected",
      rejectionCode: "COMPREHENSION_FAILED",
      claim: null,
    });
    expect(response.body).not.toContain("correct");
    expect(response.body).not.toContain("score");
  });

  it("caps attempts per verified human to stop brute forcing", async () => {
    const { verify, submit } = await setup();
    const token = await verify("human-1", WALLET_A);
    const base = { eligibilityToken: token, claimant: WALLET_A };

    expect((await submit("k1", { ...base, answers: WRONG })).statusCode).toBe(
      201,
    );
    expect((await submit("k2", { ...base, answers: WRONG })).statusCode).toBe(
      201,
    );

    const third = await submit("k3", { ...base, answers: CORRECT });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      error: { code: "ATTEMPT_LIMIT_REACHED" },
    });
  });

  it("allows a retry after one failed attempt", async () => {
    const { verify, submit } = await setup();
    const token = await verify("human-1", WALLET_A);
    const base = { eligibilityToken: token, claimant: WALLET_A };

    await submit("k1", { ...base, answers: WRONG });
    const retry = await submit("k2", { ...base, answers: CORRECT });

    expect(retry.json()).toMatchObject({ status: "accepted" });
  });

  it("refuses someone else's eligibility token or wallet", async () => {
    const { verify, submit } = await setup();
    const tokenA = await verify("human-a", WALLET_A);
    await verify("human-b", WALLET_B);

    const stolen = await submit("k1", {
      eligibilityToken: tokenA,
      claimant: WALLET_B,
      answers: CORRECT,
    });
    const unknown = await submit("k2", {
      eligibilityToken: "00000000-0000-4000-8000-000000000000",
      claimant: WALLET_A,
      answers: CORRECT,
    });

    expect(stolen.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(403);
    expect(stolen.json()).toMatchObject({
      error: { code: "INVALID_ELIGIBILITY" },
    });
  });

  it("creates no liability when the campaign is not active", async () => {
    const { verify, submit, campaigns, setNow } = await setup();
    const token = await verify("human-1", WALLET_A);
    const body = {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: CORRECT,
    };

    campaigns.status = "closed";
    const closed = await submit("k1", body);

    campaigns.status = "active";
    setNow(new Date("2026-10-05T10:05:00.000Z"));
    const early = await submit("k2", body);

    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({
      error: { code: "CAMPAIGN_NOT_ACTIVE" },
    });
    expect(early.json()).toMatchObject({
      error: { code: "CAMPAIGN_NOT_STARTED" },
    });

    // Neither counted as an attempt: the human can still complete.
    setNow(new Date("2026-10-05T10:30:00.000Z"));
    expect((await submit("k3", body)).json()).toMatchObject({
      status: "accepted",
    });
  });

  it("does not store or count malformed answers", async () => {
    const { verify, submit } = await setup();
    const token = await verify("human-1", WALLET_A);
    const base = { eligibilityToken: token, claimant: WALLET_A };

    for (const [key, answers] of [
      ["m1", "free text"],
      ["m2", [{ questionId: "q1", choiceId: "zzz" }]],
      ["m3", [{ questionId: "q9", choiceId: "a" }]],
    ] as const) {
      const response = await submit(key, { ...base, answers });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: "MALFORMED_ANSWERS" },
      });
    }

    expect((await submit("ok", { ...base, answers: CORRECT })).statusCode).toBe(
      201,
    );
  });

  it("validates headers, body and campaign id", async () => {
    const { app, campaignId, verify } = await setup();
    const token = await verify("human-1", WALLET_A);
    const url = `/v1/campaigns/${campaignId}/submissions`;
    const payload = {
      eligibilityToken: token,
      claimant: WALLET_A,
      answers: CORRECT,
    };

    expect(
      (await app.inject({ method: "POST", url, payload })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "idempotency-key": "x" },
          payload: { ...payload, claimant: "nope" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/campaigns/not-a-uuid/submissions",
          headers: { "idempotency-key": "x" },
          payload,
        })
      ).statusCode,
    ).toBe(404);
  });
});
