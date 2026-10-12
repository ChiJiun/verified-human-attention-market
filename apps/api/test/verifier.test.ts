import { describe, expect, it } from "vitest";

import {
  hashMissionDefinition,
  toMissionDefinition,
} from "../src/missions/schemas.js";
import type { MissionRecord } from "../src/missions/types.js";
import {
  evaluateSubmission,
  toPublicMission,
  type EngagementContext,
} from "../src/missions/verifier.js";

const definition = toMissionDefinition("https://example.com/article", {
  questions: [
    {
      id: "q1",
      prompt: "Which feature was highlighted?",
      choices: [
        { id: "a", label: "Speed" },
        { id: "b", label: "Price" },
      ],
    },
    {
      id: "q2",
      prompt: "Who is it for?",
      choices: [
        { id: "a", label: "Developers" },
        { id: "b", label: "Designers" },
        { id: "c", label: "Lawyers" },
      ],
    },
  ],
  answerKey: { q1: "a", q2: "c" },
});

const mission: MissionRecord = {
  ...definition,
  id: "00000000-0000-4000-8000-000000000001",
  campaignId: "00000000-0000-4000-8000-000000000002",
  version: 1,
  kind: "comprehension_check",
  definitionHash: hashMissionDefinition(definition),
  createdAt: new Date("2026-10-05T10:00:00.000Z"),
};

const activeContext: EngagementContext = {
  now: new Date("2026-10-05T10:30:00.000Z"),
  campaign: {
    status: "active",
    startAt: new Date("2026-10-05T10:15:00.000Z"),
    endAt: new Date("2026-10-05T11:15:00.000Z"),
  },
};

const correct = [
  { questionId: "q2", choiceId: "c" },
  { questionId: "q1", choiceId: "a" },
];

describe("evaluateSubmission", () => {
  it("accepts all-correct answers deterministically", () => {
    const first = evaluateSubmission(mission, correct, activeContext);
    const second = evaluateSubmission(mission, correct, activeContext);

    expect(first).toEqual(second);
    expect(first).toEqual({
      result: "accepted",
      rejectionCode: null,
      correctCount: 2,
      answers: [
        {
          questionId: "q1",
          normalizedAnswer: { choiceId: "a" },
          score: "1.0000",
        },
        {
          questionId: "q2",
          normalizedAnswer: { choiceId: "c" },
          score: "1.0000",
        },
      ],
    });
  });

  it("rejects a wrong answer with COMPREHENSION_FAILED", () => {
    const evaluation = evaluateSubmission(
      mission,
      [
        { questionId: "q1", choiceId: "a" },
        { questionId: "q2", choiceId: "b" },
      ],
      activeContext,
    );

    expect(evaluation).toMatchObject({
      result: "rejected",
      rejectionCode: "COMPREHENSION_FAILED",
      correctCount: 1,
    });
    expect(evaluation.answers).toHaveLength(2);
  });

  it("honours a lower pass threshold", () => {
    const lenient: MissionRecord = { ...mission, passThreshold: 1 };

    expect(
      evaluateSubmission(
        lenient,
        [
          { questionId: "q1", choiceId: "a" },
          { questionId: "q2", choiceId: "a" },
        ],
        activeContext,
      ).result,
    ).toBe("accepted");
  });

  it("rejects missing questions", () => {
    expect(
      evaluateSubmission(
        mission,
        [{ questionId: "q1", choiceId: "a" }],
        activeContext,
      ).rejectionCode,
    ).toBe("MISSING_ANSWERS");
  });

  it.each([
    ["not an array", { q1: "a" }],
    ["empty", []],
    ["unknown question", [...correct, { questionId: "q9", choiceId: "a" }]],
    [
      "duplicate question",
      [
        { questionId: "q1", choiceId: "a" },
        { questionId: "q1", choiceId: "b" },
      ],
    ],
    [
      "unknown choice",
      [
        { questionId: "q1", choiceId: "z" },
        { questionId: "q2", choiceId: "c" },
      ],
    ],
    ["wrong field types", [{ questionId: 1, choiceId: true }]],
    [
      "free text instead of choice id",
      [{ questionId: "q1", choiceId: "the answer is speed" }],
    ],
  ])("rejects malformed answers: %s", (_label, answers) => {
    const evaluation = evaluateSubmission(mission, answers, activeContext);

    expect(evaluation.rejectionCode).toBe("MALFORMED_ANSWERS");
    // Unvalidated input is never handed on for persistence.
    expect(evaluation.answers).toEqual([]);
  });

  it.each([
    ["draft", { status: "draft" as const }, "CAMPAIGN_NOT_ACTIVE"],
    ["closed", { status: "closed" as const }, "CAMPAIGN_NOT_ACTIVE"],
    ["expired", { status: "expired" as const }, "CAMPAIGN_NOT_ACTIVE"],
    ["settled", { status: "settled" as const }, "CAMPAIGN_NOT_ACTIVE"],
    [
      "not started",
      { startAt: new Date("2026-10-05T10:31:00.000Z") },
      "CAMPAIGN_NOT_STARTED",
    ],
    [
      "at end time",
      { endAt: new Date("2026-10-05T10:30:00.000Z") },
      "CAMPAIGN_ENDED",
    ],
  ])(
    "never accepts a completion when the campaign is %s",
    (_label, campaignOverride, code) => {
      const evaluation = evaluateSubmission(mission, correct, {
        ...activeContext,
        campaign: { ...activeContext.campaign, ...campaignOverride },
      });

      expect(evaluation).toMatchObject({
        result: "rejected",
        rejectionCode: code,
      });
    },
  );
});

describe("toPublicMission", () => {
  it("never exposes the answer key", () => {
    const publicMission = toPublicMission(mission);
    const serialized = JSON.stringify(publicMission);

    expect(publicMission).not.toHaveProperty("answerKey");
    expect(publicMission).not.toHaveProperty("passThreshold");
    expect(serialized).not.toContain("answerKey");
    expect(publicMission.questions).toHaveLength(2);
  });
});

describe("hashMissionDefinition", () => {
  it("ignores answer key insertion order", () => {
    expect(
      hashMissionDefinition({
        ...definition,
        answerKey: { q2: "c", q1: "a" },
      }),
    ).toBe(hashMissionDefinition(definition));
  });
});
