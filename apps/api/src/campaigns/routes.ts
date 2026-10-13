import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  IdempotencyConflictError,
  type CampaignRepository,
} from "./repository.js";
import {
  canonicalMission,
  hashMissionDefinition,
  toMissionDefinition,
} from "../missions/schemas.js";
import { toPublicMission } from "../missions/verifier.js";
import { requireWallet } from "../auth/routes.js";
import type { Authenticate } from "../auth/siwe.js";
import {
  checkContentUrl,
  type ContentUrlPolicy,
} from "../moderation/url-policy.js";
import { createCampaignSchema } from "./schemas.js";
import type { CampaignRecord } from "./types.js";

interface CampaignRoutesOptions {
  authenticate: Authenticate;
  repository: CampaignRepository;
  chainId: number;
  now?: () => Date;
  contentUrlPolicy?: ContentUrlPolicy;
  /** Runs after create and on idempotent replays (e.g. moderation state). */
  onCampaignCreated?: (campaign: CampaignRecord) => Promise<void>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const urlViolation = checkContentUrl(
      parsed.data.contentUrl,
      options.contentUrlPolicy,
    );

    if (urlViolation) {
      return reply.status(400).send({
        error: {
          code: "UNSAFE_CONTENT_URL",
          message: "contentUrl is not allowed",
          reason: urlViolation,
          requestId: request.id,
        },
      });
    }

    // Only the signed-in wallet may create campaigns as itself (#37).
    if (
      !(await requireWallet(
        options.authenticate,
        request,
        reply,
        parsed.data.advertiser,
      ))
    ) {
      return reply;
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
    const missionDefinition = toMissionDefinition(
      parsed.data.contentUrl,
      parsed.data.mission,
    );
    const normalizedRequest = JSON.stringify({
      advertiserAddress,
      contentUrl: parsed.data.contentUrl,
      rewardAtomic: parsed.data.rewardPerCompletion,
      maxCompletions: parsed.data.maxCompletions,
      startAt: parsed.data.startAt.toISOString(),
      endAt: parsed.data.endAt.toISOString(),
      chainId: options.chainId,
      mission: canonicalMission(missionDefinition),
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
        mission: {
          id: randomUUID(),
          definition: missionDefinition,
          definitionHash: hashMissionDefinition(missionDefinition),
        },
      });

      await options.onCampaignCreated?.(result.campaign);

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
      const campaign = UUID_PATTERN.test(request.params.id)
        ? await options.repository.getById(request.params.id)
        : null;

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

  app.get<{ Params: { id: string } }>(
    "/v1/campaigns/:id/mission",
    async (request, reply) => {
      const mission = UUID_PATTERN.test(request.params.id)
        ? await options.repository.getMission(request.params.id)
        : null;

      if (!mission) {
        return reply.status(404).send({
          error: {
            code: "MISSION_NOT_FOUND",
            message: "Mission was not found",
            requestId: request.id,
          },
        });
      }

      // Answer key and pass threshold stay server-side.
      return reply.send(toPublicMission(mission));
    },
  );
}
