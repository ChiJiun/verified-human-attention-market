import { randomUUID } from "node:crypto";

import type { CampaignRepository } from "../campaigns/repository.js";
import {
  campaignAction,
  type WorldIdFailureCode,
  type WorldIdVerifier,
} from "../identity/world-id.js";
import { deriveParticipantKey } from "../privacy/participant-key.js";
import {
  EligibilityConflictError,
  type EligibilityRecord,
  type EligibilityRepository,
} from "./repository.js";

export interface EligibilityServiceDependencies {
  campaigns: CampaignRepository;
  eligibility: EligibilityRepository;
  worldId: WorldIdVerifier;
  /** null when not configured: eligibility is refused (fail closed). */
  participantKeySecret: string | null;
  now: () => Date;
}

export type EligibilityFailureCode =
  | WorldIdFailureCode
  | "CAMPAIGN_NOT_FOUND"
  | "CAMPAIGN_NOT_OPEN"
  | "PARTICIPANT_WALLET_MISMATCH"
  | "WALLET_ALREADY_BOUND";

export type EligibilityOutcome =
  | { ok: true; eligibility: EligibilityRecord; created: boolean }
  | { ok: false; status: number; code: EligibilityFailureCode };

const WORLD_ID_STATUS: Record<WorldIdFailureCode, number> = {
  WORLD_ID_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  INVALID_PROOF_PAYLOAD: 400,
  ACTION_MISMATCH: 403,
  ENVIRONMENT_MISMATCH: 403,
  VERIFICATION_FAILED: 403,
};

/**
 * Verifies a World ID proof for one campaign and binds the verified human to
 * exactly one payout wallet. Proof of Human only: engagement is verified
 * separately (missions/verifier.ts).
 */
export async function verifyEligibility(
  dependencies: EligibilityServiceDependencies,
  input: {
    campaignId: string;
    claimantAddress: string;
    idkitResponse: unknown;
  },
): Promise<EligibilityOutcome> {
  const campaign = await dependencies.campaigns.getById(input.campaignId);

  if (!campaign) {
    return { ok: false, status: 404, code: "CAMPAIGN_NOT_FOUND" };
  }

  const now = dependencies.now();

  if (now >= campaign.endAt || !["draft", "active"].includes(campaign.status)) {
    return { ok: false, status: 409, code: "CAMPAIGN_NOT_OPEN" };
  }

  if (!dependencies.participantKeySecret) {
    return { ok: false, status: 503, code: "WORLD_ID_NOT_CONFIGURED" };
  }

  const verification = await dependencies.worldId.verify({
    action: campaignAction(campaign.id),
    idkitResponse: input.idkitResponse,
  });

  if (!verification.ok) {
    return {
      ok: false,
      status: WORLD_ID_STATUS[verification.code],
      code: verification.code,
    };
  }

  try {
    const result = await dependencies.eligibility.recordIdempotent({
      id: randomUUID(),
      campaignId: campaign.id,
      participantKey: deriveParticipantKey(
        dependencies.participantKeySecret,
        campaign.id,
        verification.nullifier,
      ),
      claimantAddress: input.claimantAddress,
      provider: "world_id",
      verifiedAt: now,
      expiresAt: campaign.endAt,
    });

    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof EligibilityConflictError) {
      return { ok: false, status: 409, code: error.code };
    }

    throw error;
  }
}
