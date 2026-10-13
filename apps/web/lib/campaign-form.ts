import { parseUnits } from "viem";

import { USDC_DECIMALS } from "./config";

export interface QuestionDraft {
  prompt: string;
  choices: string[];
  correctIndex: number;
}

export interface CampaignDraft {
  contentUrl: string;
  /** Decimal USDC, e.g. "1" or "0.5". Converted to atomic units. */
  reward: string;
  maxCompletions: number;
  /** datetime-local values (browser local time). */
  startAt: string;
  endAt: string;
  questions: QuestionDraft[];
}

export function emptyQuestion(): QuestionDraft {
  return { prompt: "", choices: ["", ""], correctIndex: 0 };
}

/**
 * Builds the POST /v1/campaigns payload. Money is converted with integer
 * arithmetic (parseUnits); floating point never touches amounts.
 */
export function toCampaignPayload(draft: CampaignDraft, advertiser: string) {
  const errors: string[] = [];

  if (!/^\d+(\.\d{1,6})?$/.test(draft.reward.trim())) {
    errors.push("Reward must be a USDC amount with at most 6 decimals.");
  }
  if (!draft.contentUrl.startsWith("https://")) {
    errors.push("Content URL must start with https://");
  }

  const start = new Date(draft.startAt);
  const end = new Date(draft.endAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    errors.push("Start and end time are required.");
  } else if (end.getTime() - start.getTime() < 15 * 60_000) {
    errors.push("The campaign must last at least 15 minutes.");
  } else if (end.getTime() - start.getTime() > 24 * 60 * 60_000) {
    errors.push("The campaign cannot last more than 24 hours.");
  }

  draft.questions.forEach((question, index) => {
    if (!question.prompt.trim()) {
      errors.push(`Question ${index + 1} needs a prompt.`);
    }
    if (question.choices.some((choice) => !choice.trim())) {
      errors.push(`Question ${index + 1} has an empty choice.`);
    }
  });

  if (errors.length > 0) {
    return { ok: false as const, errors };
  }

  const questions = draft.questions.map((question, index) => ({
    id: `q${index + 1}`,
    prompt: question.prompt.trim(),
    choices: question.choices.map((label, choiceIndex) => ({
      id: String.fromCharCode(97 + choiceIndex),
      label: label.trim(),
    })),
  }));

  return {
    ok: true as const,
    payload: {
      advertiser,
      contentUrl: draft.contentUrl.trim(),
      rewardPerCompletion: parseUnits(
        draft.reward.trim(),
        USDC_DECIMALS,
      ).toString(),
      maxCompletions: draft.maxCompletions,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      mission: {
        questions,
        answerKey: Object.fromEntries(
          draft.questions.map((question, index) => [
            `q${index + 1}`,
            String.fromCharCode(97 + question.correctIndex),
          ]),
        ),
      },
    },
  };
}
