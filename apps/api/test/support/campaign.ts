import { TEST_ADVERTISER } from "./auth.js";

/**
 * `POST /v1/campaigns` body most tests use: 1 USDC × 10 completions,
 * 2026-10-05 10:15–11:15 UTC, one question whose answer is "a".
 */
export function campaignInput(
  options: { advertiser?: string; contentUrl?: string | undefined } = {},
) {
  return {
    advertiser: options.advertiser ?? TEST_ADVERTISER,
    contentUrl: options.contentUrl ?? "https://example.com/sponsored",
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
}
