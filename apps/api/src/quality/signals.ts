/**
 * Campaign-scoped completion-quality signals (#25, ADR-0009).
 *
 * Deterministic and derived only from facts stored with the submission, so
 * every flag can be re-derived and audited. Signals never change payout in
 * the MVP: they produce machine-readable reason codes and a fraud-adjusted
 * completion count for advertisers. Participants never see them (so they
 * cannot be tuned against).
 */

export const QUALITY_FLAGS = [
  /** Submitted sooner after verification than the content can be read. */
  "FAST_COMPLETION",
  /** Accepted only after a rejected attempt (possible answer guessing). */
  "PASSED_ON_RETRY",
  /** Unusual completion rate for the campaign (possible coordinated farming). */
  "CAMPAIGN_BURST",
] as const;

export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export interface QualityConfig {
  minEngagementSeconds: number;
  burstWindowMs: number;
  /** Submissions in the window (including this one) that count as a burst. */
  burstThreshold: number;
}

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  minEngagementSeconds: 15,
  burstWindowMs: 60_000,
  burstThreshold: 20,
};

export function computeQualityFlags(
  facts: {
    result: "accepted" | "rejected";
    verifiedAt: Date;
    submittedAt: Date;
    priorAttempts: number;
    /** Submissions for the campaign within `burstWindowMs`, excluding this one. */
    recentCampaignSubmissions: number;
  },
  config: QualityConfig = DEFAULT_QUALITY_CONFIG,
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const elapsedMs = facts.submittedAt.getTime() - facts.verifiedAt.getTime();

  if (elapsedMs < config.minEngagementSeconds * 1000) {
    flags.push("FAST_COMPLETION");
  }

  if (facts.result === "accepted" && facts.priorAttempts > 0) {
    flags.push("PASSED_ON_RETRY");
  }

  if (facts.recentCampaignSubmissions + 1 >= config.burstThreshold) {
    flags.push("CAMPAIGN_BURST");
  }

  return flags;
}
