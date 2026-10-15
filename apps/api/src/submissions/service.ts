import { randomUUID } from "node:crypto";

import type { CampaignRepository } from "../campaigns/repository.js";
import { isRetiredDeployment } from "../campaigns/types.js";
import type { EligibilityRepository } from "../eligibility/repository.js";
import { IdempotencyConflictError } from "../persistence/errors.js";
import {
  evaluateSubmission,
  type EngagementRejectionCode,
} from "../missions/verifier.js";
import {
  computeQualityFlags,
  DEFAULT_QUALITY_CONFIG,
  type QualityConfig,
} from "../quality/signals.js";
import {
  DuplicateCompletionError,
  hashSubmissionRequest,
  SubmissionEligibilityError,
  type SubmissionRecord,
  type SubmissionRepository,
} from "./repository.js";

/**
 * POC attempt cap per verified human per campaign. Without it a 1-3 question
 * multiple-choice check is trivially brute-forced by retrying.
 */
export const MAX_ATTEMPTS_PER_ELIGIBILITY = 2;

export interface SubmissionServiceDependencies {
  campaigns: CampaignRepository;
  /** Configured CampaignManager; campaigns linked elsewhere are retired. */
  campaignManagerAddress: string | null;
  eligibility: EligibilityRepository;
  submissions: SubmissionRepository;
  now: () => Date;
  maxAttempts?: number;
  quality?: QualityConfig;
}

export type SubmissionFailureCode =
  | "CAMPAIGN_NOT_FOUND"
  | "MISSION_NOT_FOUND"
  | "INVALID_ELIGIBILITY"
  | "ELIGIBILITY_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "ALREADY_COMPLETED"
  | "ATTEMPT_LIMIT_REACHED"
  | "CAMPAIGN_NOT_ACTIVE"
  | "CAMPAIGN_NOT_STARTED"
  | "CAMPAIGN_ENDED"
  | "MALFORMED_ANSWERS";

export type SubmissionOutcome =
  | { ok: true; submission: SubmissionRecord; created: boolean }
  | { ok: false; status: number; code: SubmissionFailureCode };

/** Rejections that are not genuine attempts and are therefore not stored. */
const NOT_PERSISTED: Partial<
  Record<EngagementRejectionCode, { status: number }>
> = {
  CAMPAIGN_NOT_ACTIVE: { status: 409 },
  CAMPAIGN_NOT_STARTED: { status: 409 },
  CAMPAIGN_ENDED: { status: 409 },
  MALFORMED_ANSWERS: { status: 400 },
};

function canonicalAnswers(raw: unknown) {
  if (!Array.isArray(raw)) {
    return [{ questionId: "", normalizedAnswer: raw ?? null }];
  }

  return raw.map((entry: unknown) => {
    const value = (entry ?? {}) as { questionId?: unknown; choiceId?: unknown };
    return {
      questionId: String(value.questionId ?? ""),
      normalizedAnswer: { choiceId: value.choiceId ?? null },
    };
  });
}

/**
 * Engagement submission: eligibility (World ID, #9) + deterministic verifier
 * (#15) + idempotent persistence (#8). Claim authorization is issued
 * separately for accepted submissions (#10).
 */
export async function submitCompletion(
  dependencies: SubmissionServiceDependencies,
  input: {
    campaignId: string;
    eligibilityToken: string;
    claimantAddress: string;
    idempotencyKey: string;
    answers: unknown;
  },
): Promise<SubmissionOutcome> {
  const claimantAddress = input.claimantAddress.toLowerCase();
  const requestHash = hashSubmissionRequest({
    campaignId: input.campaignId,
    claimantAddress,
    answers: canonicalAnswers(input.answers),
  });

  // Replays return the original outcome even if the campaign has since ended.
  const existing = await dependencies.submissions.findByIdempotencyKey(
    input.campaignId,
    input.idempotencyKey,
  );

  if (existing) {
    if (
      existing.requestHash !== requestHash ||
      existing.eligibilityId !== input.eligibilityToken
    ) {
      return { ok: false, status: 409, code: "IDEMPOTENCY_CONFLICT" };
    }

    return { ok: true, submission: existing, created: false };
  }

  const campaign = await dependencies.campaigns.getById(input.campaignId);

  if (!campaign) {
    return { ok: false, status: 404, code: "CAMPAIGN_NOT_FOUND" };
  }

  // Its rewards could not be signed for on the configured contract.
  if (isRetiredDeployment(campaign, dependencies.campaignManagerAddress)) {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
  }

  const mission = await dependencies.campaigns.getMission(campaign.id);

  if (!mission) {
    return { ok: false, status: 404, code: "MISSION_NOT_FOUND" };
  }

  const eligibility = await dependencies.eligibility.getById(
    input.eligibilityToken,
  );

  if (
    !eligibility ||
    eligibility.campaignId !== campaign.id ||
    eligibility.claimantAddress !== claimantAddress
  ) {
    // Deliberately not distinguishing "unknown" from "someone else's".
    return { ok: false, status: 403, code: "INVALID_ELIGIBILITY" };
  }

  const now = dependencies.now();

  if (eligibility.expiresAt <= now) {
    return { ok: false, status: 403, code: "ELIGIBILITY_EXPIRED" };
  }

  if (
    await dependencies.submissions.findAcceptedByEligibility(eligibility.id)
  ) {
    return { ok: false, status: 409, code: "ALREADY_COMPLETED" };
  }

  const maxAttempts = dependencies.maxAttempts ?? MAX_ATTEMPTS_PER_ELIGIBILITY;

  const priorAttempts = await dependencies.submissions.countByEligibility(
    eligibility.id,
  );

  if (priorAttempts >= maxAttempts) {
    return { ok: false, status: 429, code: "ATTEMPT_LIMIT_REACHED" };
  }

  const evaluation = evaluateSubmission(mission, input.answers, {
    now,
    campaign,
  });

  if (evaluation.rejectionCode) {
    const notPersisted = NOT_PERSISTED[evaluation.rejectionCode];

    if (notPersisted) {
      return {
        ok: false,
        status: notPersisted.status,
        code: evaluation.rejectionCode as SubmissionFailureCode,
      };
    }
  }

  const quality = dependencies.quality ?? DEFAULT_QUALITY_CONFIG;
  const qualityFlags = computeQualityFlags(
    {
      result: evaluation.result,
      verifiedAt: eligibility.verifiedAt,
      submittedAt: now,
      priorAttempts,
      recentCampaignSubmissions:
        await dependencies.submissions.countRecentByCampaign(
          campaign.id,
          new Date(now.getTime() - quality.burstWindowMs),
        ),
    },
    quality,
  );

  try {
    const result = await dependencies.submissions.recordIdempotent({
      id: randomUUID(),
      campaignId: campaign.id,
      eligibilityId: eligibility.id,
      missionId: mission.id,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      claimantAddress,
      result: evaluation.result,
      rejectionCode: evaluation.rejectionCode,
      answers: evaluation.answers,
      qualityFlags,
      createdAt: now,
    });

    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof DuplicateCompletionError) {
      return { ok: false, status: 409, code: "ALREADY_COMPLETED" };
    }

    if (error instanceof IdempotencyConflictError) {
      return { ok: false, status: 409, code: "IDEMPOTENCY_CONFLICT" };
    }

    if (error instanceof SubmissionEligibilityError) {
      return {
        ok: false,
        status: 403,
        code:
          error.code === "ELIGIBILITY_EXPIRED"
            ? "ELIGIBILITY_EXPIRED"
            : "INVALID_ELIGIBILITY",
      };
    }

    throw error;
  }
}
