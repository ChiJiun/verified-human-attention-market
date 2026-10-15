import type { SignedClaim } from "./signer.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { authorizeClaim, type ClaimDependencies } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ eligibilityToken: z.string().regex(UUID) });

export async function registerClaimRoutes(
  app: FastifyInstance,
  dependencies: ClaimDependencies,
) {
  app.post<{ Params: { id: string; submissionId: string } }>(
    "/v1/campaigns/:id/submissions/:submissionId/authorization",
    async (request, reply) => {
      const fail = (status: number, code: string) =>
        reply.status(status).send({
          error: {
            code,
            message: "Claim authorization unavailable",
            requestId: request.id,
          },
        });

      if (
        !UUID.test(request.params.id) ||
        !UUID.test(request.params.submissionId)
      ) {
        return fail(404, "SUBMISSION_NOT_FOUND");
      }

      const body = bodySchema.safeParse(request.body);
      if (!body.success) return fail(400, "INVALID_ELIGIBILITY_TOKEN");

      const outcome = await authorizeClaim(dependencies, {
        campaignId: request.params.id,
        submissionId: request.params.submissionId,
        eligibilityToken: body.data.eligibilityToken,
      });
      if (!outcome.ok) return fail(outcome.status, outcome.code);

      return reply
        .status(outcome.created ? 201 : 200)
        .send(serializeClaim(outcome.claim));
    },
  );
}

/** JSON shape of a signed authorization, as the web app submits it. */
export function serializeClaim(claim: SignedClaim) {
  const { payload, signature, chainId, contractAddress } = claim;
  return {
    campaignId: payload.campaignId.toString(),
    draftRef: payload.draftRef,
    claimant: payload.claimant,
    amount: payload.amount.toString(),
    nonce: payload.nonce,
    issuedAt: Number(payload.issuedAt),
    expiresAt: Number(payload.expiresAt),
    signature,
    chainId,
    contractAddress,
  };
}
