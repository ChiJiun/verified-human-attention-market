import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  verifyEligibility,
  type EligibilityServiceDependencies,
} from "./service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const verifyEligibilitySchema = z.object({
  claimant: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address"),
  // Forwarded to World ID unchanged; validated by the verifier.
  idkitResponse: z.unknown(),
});

export async function registerEligibilityRoutes(
  app: FastifyInstance,
  dependencies: EligibilityServiceDependencies,
) {
  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/eligibility/verify",
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return reply.status(404).send({
          error: {
            code: "CAMPAIGN_NOT_FOUND",
            message: "Campaign was not found",
            requestId: request.id,
          },
        });
      }

      const parsed = verifyEligibilitySchema.safeParse(request.body);

      if (!parsed.success || parsed.data.idkitResponse === undefined) {
        return reply.status(400).send({
          error: {
            code: "INVALID_ELIGIBILITY_REQUEST",
            message: "claimant and idkitResponse are required",
            requestId: request.id,
          },
        });
      }

      const outcome = await verifyEligibility(dependencies, {
        campaignId: request.params.id,
        claimantAddress: parsed.data.claimant,
        idkitResponse: parsed.data.idkitResponse,
      });

      if (!outcome.ok) {
        // Never echo proof material back or into logs.
        return reply.status(outcome.status).send({
          error: {
            code: outcome.code,
            message: "Eligibility verification was not successful",
            requestId: request.id,
          },
        });
      }

      return reply.status(outcome.created ? 201 : 200).send({
        // Opaque handle for the submission step. It cannot redirect funds:
        // rewards are bound to the claimant wallet recorded here.
        eligibilityToken: outcome.eligibility.id,
        campaignId: outcome.eligibility.campaignId,
        claimant: outcome.eligibility.claimantAddress,
        expiresAt: outcome.eligibility.expiresAt.toISOString(),
      });
    },
  );
}
