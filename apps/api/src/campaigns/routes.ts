import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  IdempotencyConflictError,
  type CampaignRepository,
} from "./repository.js";
import { createCampaignSchema } from "./schemas.js";
import type { CampaignRecord } from "./types.js";

interface CampaignRoutesOptions {
  repository: CampaignRepository;
  chainId: number;
  now?: () => Date;
}

function serializeCampaign(campaign: CampaignRecord) {
  return {
    id: campaign.id,
    chainId: campaign.chainId,
    onchainCampaignId: campaign.onchainCampaignId,
    advertiser: campaign.advertiserAddress,
    contentUrl: campaign.contentUrl,
    rewardPerCompletion: campaign.rewardAtomic,
    maxCompletions: campaign.maxCompletions,
    startAt: campaign.startAt.toISOString(),
    endAt: campaign.endAt.toISOString(),
    status: campaign.status,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

export async function registerCampaignRoutes(
  app: FastifyInstance,
  options: CampaignRoutesOptions,
) {
  const now = options.now ?? (() => new Date());

  app.post("/v1/campaigns", async (request, reply) => {
    const idempotencyKey = request.headers["idempotency-key"];

    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 200
    ) {
      return reply.status(400).send({
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "A valid Idempotency-Key header is required",
          requestId: request.id,
        },
      });
    }

    const parsed = createCampaignSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_CAMPAIGN",
          message: "Campaign input is invalid",
          requestId: request.id,
          details: parsed.error.flatten(),
        },
      });
    }

    const createdAt = now();

    if (parsed.data.startAt < createdAt) {
      return reply.status(400).send({
        error: {
          code: "CAMPAIGN_START_IN_PAST",
          message: "Campaign startAt cannot be in the past",
          requestId: request.id,
        },
      });
    }

    const advertiserAddress = parsed.data.advertiser.toLowerCase();
    const normalizedRequest = JSON.stringify({
      advertiserAddress,
      contentUrl: parsed.data.contentUrl,
      rewardAtomic: parsed.data.rewardPerCompletion,
      maxCompletions: parsed.data.maxCompletions,
      startAt: parsed.data.startAt.toISOString(),
      endAt: parsed.data.endAt.toISOString(),
      chainId: options.chainId,
    });
    const creationRequestHash = createHash("sha256")
      .update(normalizedRequest)
      .digest("hex");

    try {
      const result = await options.repository.createIdempotent({
        id: randomUUID(),
        chainId: options.chainId,
        advertiserAddress,
        creationIdempotencyKey: idempotencyKey,
        creationRequestHash,
        contentUrl: parsed.data.contentUrl,
        rewardAtomic: parsed.data.rewardPerCompletion,
        maxCompletions: parsed.data.maxCompletions,
        startAt: parsed.data.startAt,
        endAt: parsed.data.endAt,
        status: "draft",
        createdAt,
        updatedAt: createdAt,
      });

      return reply
        .status(result.created ? 201 : 200)
        .send(serializeCampaign(result.campaign));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return reply.status(409).send({
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message:
              "Idempotency-Key was already used with a different request",
            requestId: request.id,
          },
        });
      }

      throw error;
    }
  });

  app.get<{ Params: { id: string } }>(
    "/v1/campaigns/:id",
    async (request, reply) => {
      const campaign = await options.repository.getById(request.params.id);

      if (!campaign) {
        return reply.status(404).send({
          error: {
            code: "CAMPAIGN_NOT_FOUND",
            message: "Campaign was not found",
            requestId: request.id,
          },
        });
      }

      return reply.send(serializeCampaign(campaign));
    },
  );
}
