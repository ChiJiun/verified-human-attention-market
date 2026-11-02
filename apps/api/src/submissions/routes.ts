import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";

import { serializeClaim } from "../claims/routes.js";
import type { ClaimOutcome } from "../claims/service.js";
import { sendError } from "../errors/catalog.js";
import { EVM_ADDRESS, readIdempotencyKey, UUID } from "../http/validation.js";
import { OPERATOR_OUTCOMES } from "../observability/instrumentation.js";

import {
  submitCompletion,
  type SubmissionServiceDependencies,
} from "./service.js";

const submissionBodySchema = z.object({
  eligibilityToken: z.string().regex(UUID),
  claimant: z.string().regex(EVM_ADDRESS),
  answers: z.unknown(),
});

export async function registerSubmissionRoutes(
  app: FastifyInstance,
  dependencies: SubmissionServiceDependencies & {
    /**
     * Returns the authorization of an accepted completion on a replay (the
     * one signed at acceptance, reissued if it expired), or ALREADY_CLAIMED
     * once the wallet was paid. New acceptances are signed inside their own
     * transaction (ADR-0011). null = no signer.
     */
    issueAuthorization:
      | ((input: {
          campaignId: string;
          submissionId: string;
          eligibilityToken: string;
          log?: FastifyBaseLogger;
        }) => Promise<ClaimOutcome>)
      | null;
  },
) {
  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/submissions",
    async (request, reply) => {
      const fail = (status: number, code: string, message: string) =>
        sendError(request, reply, status, { code, message });

      if (!UUID.test(request.params.id)) {
        return fail(404, "CAMPAIGN_NOT_FOUND", "Campaign was not found");
      }

      const idempotencyKey = readIdempotencyKey(request);

      if (!idempotencyKey) {
        return fail(
          400,
          "INVALID_IDEMPOTENCY_KEY",
          "A valid Idempotency-Key header is required",
        );
      }

      const parsed = submissionBodySchema.safeParse(request.body);

      if (!parsed.success) {
        return fail(
          400,
          "INVALID_SUBMISSION",
          "eligibilityToken, claimant and answers are required",
        );
      }

      const outcome = await submitCompletion(dependencies, {
        campaignId: request.params.id,
        eligibilityToken: parsed.data.eligibilityToken,
        claimantAddress: parsed.data.claimant,
        idempotencyKey,
        answers: parsed.data.answers,
        log: request.log,
      });

      if (!outcome.ok) {
        return fail(
          outcome.status,
          outcome.code,
          "Submission was not accepted",
        );
      }

      const { submission } = outcome;
      let claim: Record<string, unknown> | null = null;

      if (submission.result === "accepted") {
        // A new acceptance was signed in its own transaction; a replay
        // returns the stored authorization (reissued if it expired).
        const authorization = outcome.claim
          ? { ok: true as const, claim: outcome.claim }
          : dependencies.issueAuthorization
            ? await dependencies.issueAuthorization({
                campaignId: request.params.id,
                submissionId: submission.id,
                eligibilityToken: parsed.data.eligibilityToken,
                log: request.log,
              })
            : null;

        if (
          authorization &&
          !authorization.ok &&
          OPERATOR_OUTCOMES.has(authorization.code)
        ) {
          request.log.error(
            {
              event: "claim_authorizations",
              outcome: authorization.code,
              campaignId: submission.campaignId,
            },
            "Critical path failed",
          );
        }
        const refusal =
          authorization && !authorization.ok ? authorization.code : null;
        if (authorization?.ok) {
          claim = {
            status: "authorized",
            authorization: serializeClaim(authorization.claim),
          };
        } else if (refusal === "ALREADY_CLAIMED") {
          // Final: the wallet was paid, and the authorization route answers
          // 409 with the same code (#82).
          claim = { status: "claimed", code: refusal };
        } else {
          // Why it could not be signed now (it can be requested again).
          claim = { status: "pending_authorization", code: refusal };
        }
      }

      return reply.status(outcome.created ? 201 : 200).send({
        submissionId: submission.id,
        campaignId: submission.campaignId,
        claimant: submission.claimantAddress,
        status: submission.result,
        // Only the reason code: which answers were wrong is not revealed.
        rejectionCode: submission.rejectionCode,
        claim,
      });
    },
  );
}
