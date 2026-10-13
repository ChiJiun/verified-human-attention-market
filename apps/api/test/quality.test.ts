import { describe, expect, it } from "vitest";

import {
  computeQualityFlags,
  DEFAULT_QUALITY_CONFIG,
} from "../src/quality/signals.js";

const verifiedAt = new Date("2026-10-05T10:00:00.000Z");
const at = (seconds: number) => new Date(verifiedAt.getTime() + seconds * 1000);

describe("completion-quality signals (#25)", () => {
  it("is clean for a normal, first-attempt completion", () => {
    expect(
      computeQualityFlags({
        result: "accepted",
        verifiedAt,
        submittedAt: at(60),
        priorAttempts: 0,
        recentCampaignSubmissions: 3,
      }),
    ).toEqual([]);
  });

  it("flags fast completions, passes on retry and campaign bursts", () => {
    expect(
      computeQualityFlags({
        result: "accepted",
        verifiedAt,
        submittedAt: at(DEFAULT_QUALITY_CONFIG.minEngagementSeconds - 1),
        priorAttempts: 1,
        recentCampaignSubmissions: DEFAULT_QUALITY_CONFIG.burstThreshold - 1,
      }),
    ).toEqual(["FAST_COMPLETION", "PASSED_ON_RETRY", "CAMPAIGN_BURST"]);
  });

  it("does not call a rejected retry a pass on retry", () => {
    expect(
      computeQualityFlags({
        result: "rejected",
        verifiedAt,
        submittedAt: at(120),
        priorAttempts: 1,
        recentCampaignSubmissions: 0,
      }),
    ).toEqual([]);
  });

  it("is deterministic for the same facts (auditable)", () => {
    const facts = {
      result: "accepted" as const,
      verifiedAt,
      submittedAt: at(5),
      priorAttempts: 0,
      recentCampaignSubmissions: 0,
    };
    expect(computeQualityFlags(facts)).toEqual(computeQualityFlags(facts));
  });
});
