import { createHmac } from "node:crypto";

const DOMAIN = "vham:participant-key:v1";
/** Shared with the World ID signal, which is keyed with the same secret. */
export const MIN_SECRET_LENGTH = 32;

export const PARTICIPANT_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Derives the campaign-scoped participant key stored in `eligibility`.
 *
 * The raw identity-provider subject (e.g. a World ID nullifier) is never
 * persisted. Only this keyed HMAC is stored, so:
 * - a database leak alone does not reveal provider identifiers;
 * - keys for the same human differ across campaigns, preventing a
 *   cross-campaign behaviour graph from the eligibility table.
 */
export function deriveParticipantKey(
  secret: string,
  campaignId: string,
  providerSubject: string,
): string {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `Participant key secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  if (campaignId.length === 0 || providerSubject.length === 0) {
    throw new Error("campaignId and providerSubject are required");
  }

  return createHmac("sha256", secret)
    .update(`${DOMAIN}\u0000${campaignId}\u0000${providerSubject}`)
    .digest("hex");
}
