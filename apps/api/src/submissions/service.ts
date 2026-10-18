import { randomUUID } from "node:crypto";

import type { LiveCampaignState } from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type { ClaimOutcome } from "../claims/service.js";
import type { SignedClaim } from "../claims/signer.js";
import type { PersistenceScope } from "../db/client.js";
import type { Deployment } from "@vham/shared/deployment";

import {
  isRetiredDeployment,
  type CampaignRecord,
} from "../campaigns/types.js";
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
  /** Configured deployment; campaigns linked elsewhere are retired. */
  deployment: Deployment | null;
  /**
   * True while the indexer worker has recorded a reorg deeper than the
   * confirmation depth: no participation until recovery (ADR-0011).
   */
  chainHalted: () => Promise<boolean>;
  /**
   * Live on-chain state of the campaign (not the indexed copy): its link is
   * still this draft's canonical creation with the draft's parameters, and
   * it is funded, open and within its window. A completion is accepted only
   * when the contract would pay it, even if the indexer lags or is down.
   * null = no chain configured (nothing can be paid anyway).
   */
  liveCampaign:
    ((campaign: CampaignRecord) => Promise<LiveCampaignState>) | null;
  eligibility: EligibilityRepository;
  submissions: SubmissionRepository;
  /**
   * Signs the claim authorization inside the transaction that records an
   * accepted completion (ADR-0011): either both are persisted or neither,
   * so no accepted completion can exist that the contract would not pay
   * (campaign closed between the checks and the signature, signer down,
   * payout limit reached, cap reached). The participant's attempt is then
   * not consumed and the same request can be retried. null = no signer
   * configured (local development without a chain).
   */
  authorize?:
    | ((
        submission: SubmissionRecord,
        scope: PersistenceScope,
      ) => Promise<ClaimOutcome>)
    | null;
  now: () => Date;
  maxAttempts?: number;
  quality?: QualityConfig;
}

/** The authorization could not be issued: the acceptance is rolled back. */
class AuthorizationRefusedError extends Error {
  constructor(readonly outcome: { status: number; code: string }) {
    super(`Claim authorization refused: ${outcome.code}`);
    this.name = "AuthorizationRefusedError";
  }
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
  | "MALFORMED_ANSWERS"
  | "CHAIN_HALTED"
  | "CHAIN_UNAVAILABLE"
  // Authorization refused at acceptance (nothing was recorded).
  | "CAMPAIGN_CAP_REACHED"
  | "ALREADY_CLAIMED"
  | "DAILY_LIMIT_REACHED"
  | "SIGNER_UNAVAILABLE"
  | "SIGNER_MISMATCH"
  | "AUTHORIZATION_UNAVAILABLE";

export type SubmissionOutcome =
  | {
      ok: true;
      submission: SubmissionRecord;
      created: boolean;
      /** Signed with a new acceptance; null for replays or without a signer. */
      claim: SignedClaim | null;
    }
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

    return { ok: true, submission: existing, created: false, claim: null };
  }

  const campaign = await dependencies.campaigns.getById(input.campaignId);

  if (!campaign) {
    return { ok: false, status: 404, code: "CAMPAIGN_NOT_FOUND" };
  }

  // Its rewards could not be signed for on the configured contract.
  if (isRetiredDeployment(campaign, dependencies.deployment)) {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
  }

  if (await dependencies.chainHalted()) {
    return { ok: false, status: 503, code: "CHAIN_HALTED" };
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

  // Last check before any completion is recorded, and only for a verified
  // participant (no RPC call for unauthenticated requests): the contract
  // must still pay this draft's campaign right now (ADR-0011, #13).
  if (campaign.onchainCampaignId !== null && dependencies.liveCampaign) {
    const live = await dependencies.liveCampaign(campaign);
    if (live === "unavailable") {
      return { ok: false, status: 503, code: "CHAIN_UNAVAILABLE" };
    }
    if (live !== "payable") {
      return { ok: false, status: 409, code: "CAMPAIGN_NOT_ACTIVE" };
    }
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

  const authorize = dependencies.authorize ?? null;
  let signed: SignedClaim | null = null;

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
      ...(evaluation.result === "accepted" && authorize
        ? {
            // Acceptance means payable: sign in the same transaction and
            // roll the acceptance back if no authorization can be issued.
            beforeCommit: async (submission, scope) => {
              const outcome = await authorize(submission, scope);
              if (!outcome.ok) {
                throw new AuthorizationRefusedError(outcome);
              }
              signed = outcome.claim;
            },
          }
        : {}),
    });

    return { ok: true, ...result, claim: signed };
  } catch (error) {
    if (error instanceof AuthorizationRefusedError) {
      return {
        ok: false,
        status: error.outcome.status,
        code: error.outcome.code as SubmissionFailureCode,
      };
    }

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
