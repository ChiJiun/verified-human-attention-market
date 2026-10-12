import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import {
  EligibilityConflictError,
  type EligibilityRepository,
  type NewEligibility,
} from "../../src/eligibility/repository.js";
import { IdempotencyConflictError } from "../../src/persistence/errors.js";
import { deriveParticipantKey } from "../../src/privacy/participant-key.js";
import {
  DuplicateCompletionError,
  hashSubmissionRequest,
  SubmissionEligibilityError,
  type AnswerInput,
  type NewSubmission,
  type SubmissionRepository,
} from "../../src/submissions/repository.js";

export interface PersistenceHarness {
  eligibility: EligibilityRepository;
  submissions: SubmissionRepository;
  /** Creates a campaign row (where required) and returns its id. */
  createCampaign(): Promise<string>;
}

const SECRET = "test-participant-key-secret-0123456789abcdef";
const NOW = new Date("2026-10-05T10:20:00.000Z");
const LATER = new Date("2026-10-05T11:20:00.000Z");

function wallet(): string {
  return `0x${randomUUID().replaceAll("-", "")}${"0".repeat(8)}`;
}

function eligibilityInput(
  campaignId: string,
  overrides: Partial<NewEligibility> = {},
): NewEligibility {
  return {
    id: randomUUID(),
    campaignId,
    participantKey: deriveParticipantKey(SECRET, campaignId, randomUUID()),
    claimantAddress: wallet(),
    provider: "world_id",
    verifiedAt: NOW,
    expiresAt: LATER,
    ...overrides,
  };
}

const ANSWERS: AnswerInput[] = [
  { questionId: "q2", normalizedAnswer: { choice: "b" }, score: "1.0000" },
  { questionId: "q1", normalizedAnswer: { choice: "a" }, score: "1.0000" },
];

function submissionInput(
  eligibility: NewEligibility,
  overrides: Partial<NewSubmission> = {},
): NewSubmission {
  const answers = overrides.answers ?? ANSWERS;

  return {
    id: randomUUID(),
    campaignId: eligibility.campaignId,
    eligibilityId: eligibility.id,
    idempotencyKey: randomUUID(),
    requestHash: hashSubmissionRequest({
      campaignId: eligibility.campaignId,
      claimantAddress: eligibility.claimantAddress,
      answers,
    }),
    claimantAddress: eligibility.claimantAddress,
    result: "accepted",
    rejectionCode: null,
    answers,
    createdAt: NOW,
    ...overrides,
  };
}

/**
 * Behaviour every Eligibility/Submission repository implementation must
 * satisfy. Registered once per implementation so in-memory test doubles
 * cannot drift from PostgreSQL semantics.
 */
export function definePersistenceContract(harness: () => PersistenceHarness) {
  async function setupEligible(overrides: Partial<NewEligibility> = {}) {
    const { eligibility, createCampaign } = harness();
    const input = eligibilityInput(await createCampaign(), overrides);
    await eligibility.recordIdempotent(input);
    return input;
  }

  it("records eligibility and replays the same participant + wallet", async () => {
    const { eligibility, createCampaign } = harness();
    const input = eligibilityInput(await createCampaign());

    const first = await eligibility.recordIdempotent(input);
    const second = await eligibility.recordIdempotent({
      ...input,
      id: randomUUID(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.eligibility.id).toBe(first.eligibility.id);
    expect(await eligibility.getById(input.id)).toMatchObject({
      campaignId: input.campaignId,
      participantKey: input.participantKey,
    });
  });

  it("normalizes claimant addresses to lowercase", async () => {
    const { eligibility, createCampaign } = harness();
    const lower = wallet();
    const input = eligibilityInput(await createCampaign(), {
      claimantAddress: lower.toUpperCase().replace("0X", "0x"),
    });

    const result = await eligibility.recordIdempotent(input);

    expect(result.eligibility.claimantAddress).toBe(lower);
  });

  it("rejects the same human binding a second wallet in one campaign", async () => {
    const { eligibility } = harness();
    const input = await setupEligible();

    await expect(
      eligibility.recordIdempotent({
        ...input,
        id: randomUUID(),
        claimantAddress: wallet(),
      }),
    ).rejects.toMatchObject({
      name: "EligibilityConflictError",
      code: "PARTICIPANT_WALLET_MISMATCH",
    });
  });

  it("rejects one wallet being bound to two humans in one campaign", async () => {
    const { eligibility } = harness();
    const input = await setupEligible();

    const attempt = eligibility.recordIdempotent(
      eligibilityInput(input.campaignId, {
        claimantAddress: input.claimantAddress,
      }),
    );

    await expect(attempt).rejects.toBeInstanceOf(EligibilityConflictError);
    await expect(attempt).rejects.toMatchObject({
      code: "WALLET_ALREADY_BOUND",
    });
  });

  it("scopes participants per campaign", async () => {
    const { eligibility, createCampaign } = harness();
    const first = eligibilityInput(await createCampaign());
    const second = eligibilityInput(await createCampaign(), {
      participantKey: first.participantKey,
      claimantAddress: first.claimantAddress,
    });

    await eligibility.recordIdempotent(first);
    const result = await eligibility.recordIdempotent(second);

    expect(result.created).toBe(true);
  });

  it("refuses raw (non-derived) participant identifiers", async () => {
    const { eligibility, createCampaign } = harness();

    await expect(
      eligibility.recordIdempotent(
        eligibilityInput(await createCampaign(), {
          participantKey: "0x-raw-world-id-nullifier",
        }),
      ),
    ).rejects.toThrow(/derived/);
  });

  it("persists an accepted submission with its answers", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const input = submissionInput(eligible);

    const result = await submissions.recordIdempotent(input);
    const loaded = await submissions.getById(input.id);

    expect(result.created).toBe(true);
    expect(loaded).toMatchObject({
      id: input.id,
      result: "accepted",
      rejectionCode: null,
      claimNonce: null,
      requestHash: input.requestHash,
    });
    expect(loaded?.answers.map((answer) => answer.questionId)).toEqual([
      "q1",
      "q2",
    ]);
    expect(loaded?.answers[0]).toMatchObject({
      normalizedAnswer: { choice: "a" },
      score: "1.0000",
    });
  });

  it("replays the same idempotency key without duplicating state", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const input = submissionInput(eligible);

    const first = await submissions.recordIdempotent(input);
    const second = await submissions.recordIdempotent({
      ...input,
      id: randomUUID(),
    });

    expect(second.created).toBe(false);
    expect(second.submission.id).toBe(first.submission.id);
    expect(second.submission.answers).toHaveLength(ANSWERS.length);
  });

  it("rejects reuse of an idempotency key with a different request", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const input = submissionInput(eligible);
    await submissions.recordIdempotent(input);

    await expect(
      submissions.recordIdempotent({
        ...input,
        id: randomUUID(),
        requestHash: "different-request-hash",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("blocks a second accepted completion under a new idempotency key", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const first = await submissions.recordIdempotent(submissionInput(eligible));

    const attempt = submissions.recordIdempotent(submissionInput(eligible));

    await expect(attempt).rejects.toBeInstanceOf(DuplicateCompletionError);
    await expect(attempt).rejects.toMatchObject({
      existingSubmissionId: first.submission.id,
    });
    expect((await submissions.findAcceptedByEligibility(eligible.id))?.id).toBe(
      first.submission.id,
    );
  });

  it("allows retrying after rejections, then accepts once", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const rejected = submissionInput(eligible, {
      result: "rejected",
      rejectionCode: "COMPREHENSION_FAILED",
    });

    await submissions.recordIdempotent(rejected);
    await submissions.recordIdempotent({
      ...rejected,
      id: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const accepted = await submissions.recordIdempotent(
      submissionInput(eligible),
    );

    expect(accepted.created).toBe(true);
    expect(await submissions.getById(rejected.id)).toMatchObject({
      result: "rejected",
      rejectionCode: "COMPREHENSION_FAILED",
    });
  });

  it("allows exactly one of many concurrent accepted completions", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        submissions.recordIdempotent(submissionInput(eligible)),
      ),
    );

    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const outcome of rejected) {
      expect(outcome.reason).toBeInstanceOf(DuplicateCompletionError);
    }
  });

  it("collapses concurrent retries of the same request into one record", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const input = submissionInput(eligible);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        submissions.recordIdempotent({ ...input, id: randomUUID() }),
      ),
    );

    expect(new Set(results.map((result) => result.submission.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("rejects submissions that do not match the eligibility record", async () => {
    const { submissions, createCampaign } = harness();
    const eligible = await setupEligible();

    await expect(
      submissions.recordIdempotent(
        submissionInput(eligible, { claimantAddress: wallet() }),
      ),
    ).rejects.toMatchObject({ code: "ELIGIBILITY_CLAIMANT_MISMATCH" });

    await expect(
      submissions.recordIdempotent(
        submissionInput(eligible, { campaignId: await createCampaign() }),
      ),
    ).rejects.toMatchObject({ code: "ELIGIBILITY_CAMPAIGN_MISMATCH" });

    await expect(
      submissions.recordIdempotent(
        submissionInput(eligible, { eligibilityId: randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(SubmissionEligibilityError);
  });

  it("rejects new submissions after eligibility expires but replays old ones", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();
    const input = submissionInput(eligible);
    await submissions.recordIdempotent(input);

    const replayed = await submissions.recordIdempotent({
      ...input,
      id: randomUUID(),
      createdAt: LATER,
    });

    expect(replayed.created).toBe(false);
    await expect(
      submissions.recordIdempotent(
        submissionInput(eligible, {
          result: "rejected",
          rejectionCode: "COMPREHENSION_FAILED",
          createdAt: LATER,
        }),
      ),
    ).rejects.toMatchObject({ code: "ELIGIBILITY_EXPIRED" });
  });

  it("validates result / rejection code consistency", async () => {
    const { submissions } = harness();
    const eligible = await setupEligible();

    await expect(
      submissions.recordIdempotent(
        submissionInput(eligible, { result: "rejected", rejectionCode: null }),
      ),
    ).rejects.toThrow(/rejection code/);

    await expect(
      submissions.recordIdempotent(
        submissionInput(eligible, { rejectionCode: "UNEXPECTED" }),
      ),
    ).rejects.toThrow(/rejection code/);
  });
}
