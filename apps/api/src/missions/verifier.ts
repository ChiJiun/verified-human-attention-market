import type { CampaignStatus } from "../campaigns/types.js";
import { submittedAnswersSchema } from "./schemas.js";
import type { MissionRecord, PublicMission } from "./types.js";

export type EngagementRejectionCode =
  /** Campaign is not in an active, funded state. */
  | "CAMPAIGN_NOT_ACTIVE"
  | "CAMPAIGN_NOT_STARTED"
  /** Campaign end time passed; no new liabilities may be created. */
  | "CAMPAIGN_ENDED"
  /** Unknown/duplicate question, invalid choice, or wrong shape. */
  | "MALFORMED_ANSWERS"
  /** Not every question was answered. */
  | "MISSING_ANSWERS"
  /** Fewer correct answers than the mission's pass threshold. */
  | "COMPREHENSION_FAILED";

export interface EvaluatedAnswer {
  questionId: string;
  normalizedAnswer: { choiceId: string };
  score: "1.0000" | "0.0000";
}

export type EngagementEvaluation =
  | {
      result: "accepted";
      rejectionCode: null;
      correctCount: number;
      answers: EvaluatedAnswer[];
    }
  | {
      result: "rejected";
      rejectionCode: EngagementRejectionCode;
      correctCount: number;
      /** Empty for malformed input: unvalidated data is never persisted. */
      answers: EvaluatedAnswer[];
    };

export interface EngagementContext {
  now: Date;
  campaign: {
    status: CampaignStatus;
    startAt: Date;
    endAt: Date;
  };
}

function reject(
  rejectionCode: EngagementRejectionCode,
  answers: EvaluatedAnswer[] = [],
  correctCount = 0,
): EngagementEvaluation {
  return { result: "rejected", rejectionCode, correctCount, answers };
}

/**
 * Deterministic POC engagement verifier (ADR-0002): sponsored content plus a
 * short multiple-choice comprehension check.
 *
 * Pure function of (mission, submitted answers, campaign state, time). It
 * never trusts client telemetry such as dwell time, and it does not decide
 * human uniqueness (World ID) or issue claim authorizations.
 */
export function evaluateSubmission(
  mission: MissionRecord,
  rawAnswers: unknown,
  context: EngagementContext,
): EngagementEvaluation {
  const { campaign, now } = context;

  if (campaign.status !== "active") {
    return reject("CAMPAIGN_NOT_ACTIVE");
  }

  if (now < campaign.startAt) {
    return reject("CAMPAIGN_NOT_STARTED");
  }

  if (now >= campaign.endAt) {
    return reject("CAMPAIGN_ENDED");
  }

  const parsed = submittedAnswersSchema.safeParse(rawAnswers);

  if (!parsed.success) {
    return reject("MALFORMED_ANSWERS");
  }

  const questions = new Map(
    mission.questions.map((question) => [question.id, question]),
  );
  const seen = new Set<string>();

  for (const answer of parsed.data) {
    const question = questions.get(answer.questionId);

    if (
      !question ||
      seen.has(answer.questionId) ||
      !question.choices.some((choice) => choice.id === answer.choiceId)
    ) {
      return reject("MALFORMED_ANSWERS");
    }

    seen.add(answer.questionId);
  }

  const evaluated: EvaluatedAnswer[] = [...parsed.data]
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .map((answer) => ({
      questionId: answer.questionId,
      normalizedAnswer: { choiceId: answer.choiceId },
      score:
        mission.answerKey[answer.questionId] === answer.choiceId
          ? "1.0000"
          : "0.0000",
    }));

  const correctCount = evaluated.filter(
    (answer) => answer.score === "1.0000",
  ).length;

  if (seen.size !== questions.size) {
    return reject("MISSING_ANSWERS", evaluated, correctCount);
  }

  if (correctCount < mission.passThreshold) {
    return reject("COMPREHENSION_FAILED", evaluated, correctCount);
  }

  return {
    result: "accepted",
    rejectionCode: null,
    correctCount,
    answers: evaluated,
  };
}

/** Strips server-only fields (answer key, threshold, hashes). */
export function toPublicMission(mission: MissionRecord): PublicMission {
  return {
    missionId: mission.id,
    campaignId: mission.campaignId,
    version: mission.version,
    kind: mission.kind,
    contentUrl: mission.contentUrl,
    questions: mission.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      choices: question.choices.map((choice) => ({
        id: choice.id,
        label: choice.label,
      })),
    })),
  };
}
