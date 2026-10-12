import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  submitCompletion,
  type SubmissionServiceDependencies,
} from "./service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const submissionBodySchema = z.object({
  eligibilityToken: z.string().regex(UUID_PATTERN),
  claimant: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  answers: z.unknown(),
});

export async function registerSubmissionRoutes(
  app: FastifyInstance,
  dependencies: SubmissionServiceDependencies,
) {
  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/submissions",
    async (request, reply) => {
      const fail = (status: number, code: string, message: string) =>
        reply.status(status).send({
          error: { code, message, requestId: request.id },
        });

      if (!UUID_PATTERN.test(request.params.id)) {
        return fail(404, "CAMPAIGN_NOT_FOUND", "Campaign was not found");
      }

      const idempotencyKey = request.headers["idempotency-key"];

      if (
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 200
      ) {
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
      });

      if (!outcome.ok) {
        return fail(
          outcome.status,
          outcome.code,
          "Submission was not accepted",
        );
      }

      const { submission } = outcome;

      return reply.status(outcome.created ? 201 : 200).send({
        submissionId: submission.id,
        campaignId: submission.campaignId,
        claimant: submission.claimantAddress,
        status: submission.result,
        // Only the reason code: which answers were wrong is not revealed.
        rejectionCode: submission.rejectionCode,
        claim:
          submission.result === "accepted"
            ? { status: "pending_authorization" }
            : null,
      });
    },
  );
}
