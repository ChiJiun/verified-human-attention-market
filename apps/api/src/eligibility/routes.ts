import { worldIdSignalSaltSchema } from "@vham/shared/world-id";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { isRetiredDeployment } from "../campaigns/types.js";
import {
  campaignAction,
  type WorldIdEnvironment,
} from "../identity/world-id.js";
import type { RpSigner } from "../identity/rp-signature.js";
import {
  verifyEligibility,
  type EligibilityServiceDependencies,
} from "./service.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const claimantSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address");

const verifyEligibilitySchema = z.object({
  claimant: claimantSchema,
  signalSalt: worldIdSignalSaltSchema,
  // Forwarded to World ID unchanged; validated by the verifier.
  idkitResponse: z.unknown(),
});

export type WorldIdRequestConfig =
  | {
      mode: "live";
      signer: RpSigner;
      rpId: string;
      appId: string;
      environment: WorldIdEnvironment;
    }
  | { mode: "simulated" };

export async function registerEligibilityRoutes(
  app: FastifyInstance,
  dependencies: EligibilityServiceDependencies & {
    worldIdRequest?: WorldIdRequestConfig | null;
  },
) {
  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/world-id/request",
    async (request, reply) => {
      const fail = (status: number, code: string, message: string) =>
        reply.status(status).send({
          error: { code, message, requestId: request.id },
        });

      if (!UUID_PATTERN.test(request.params.id)) {
        return fail(404, "CAMPAIGN_NOT_FOUND", "Campaign was not found");
      }

      const campaign = await dependencies.campaigns.getById(request.params.id);

      if (!campaign) {
        return fail(404, "CAMPAIGN_NOT_FOUND", "Campaign was not found");
      }

      const now = dependencies.now();

      if (
        now >= campaign.endAt ||
        !["draft", "active"].includes(campaign.status) ||
        isRetiredDeployment(campaign, dependencies.deployment)
      ) {
        return fail(409, "CAMPAIGN_NOT_OPEN", "Campaign is not open");
      }

      if (await dependencies.chainHalted()) {
        return fail(
          503,
          "CHAIN_HALTED",
          "Participation is paused while on-chain state is being recovered",
        );
      }

      const config = dependencies.worldIdRequest;

      if (!config) {
        return fail(
          503,
          "WORLD_ID_NOT_CONFIGURED",
          "World ID requests are not configured",
        );
      }

      const action = campaignAction(campaign.id);

      if (config.mode === "simulated") {
        return reply.send({ mode: "simulated", action });
      }

      const signature = await config.signer.sign({ action, now });

      return reply.send({
        mode: "live",
        appId: config.appId,
        action,
        environment: config.environment,
        rpContext: {
          rp_id: config.rpId,
          nonce: signature.nonce,
          created_at: signature.createdAt,
          expires_at: signature.expiresAt,
          signature: signature.sig,
        },
      });
    },
  );

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
            message: "claimant, signalSalt and idkitResponse are required",
            requestId: request.id,
          },
        });
      }

      const outcome = await verifyEligibility(dependencies, {
        campaignId: request.params.id,
        claimantAddress: parsed.data.claimant,
        signalSalt: parsed.data.signalSalt,
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
