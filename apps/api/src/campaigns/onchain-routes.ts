import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { reconcileCampaignEvents } from "../chain/campaign-state.js";
import type { ChainEventRepository } from "../chain/events-repository.js";
import type { SubmissionRepository } from "../submissions/repository.js";
import {
  linkCampaignByTransaction,
  publishIntent,
  type OnchainDependencies,
} from "./onchain.js";
import { requireWallet } from "../auth/routes.js";
import type { Authenticate } from "../auth/siwe.js";
import type { CampaignRepository } from "./repository.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const linkBodySchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

export interface OnchainRouteDependencies {
  authenticate: Authenticate;
  campaigns: CampaignRepository;
  submissions: SubmissionRepository;
  /** null when on-chain integration is not configured. */
  chain:
    | (Omit<OnchainDependencies, "campaigns"> & {
        events: ChainEventRepository;
      })
    | null;
}

export async function registerOnchainRoutes(
  app: FastifyInstance,
  dependencies: OnchainRouteDependencies,
) {
  const notFound = {
    code: "CAMPAIGN_NOT_FOUND",
    message: "Campaign was not found",
  };
  const chainMissing = {
    code: "CHAIN_NOT_CONFIGURED",
    message: "On-chain integration is not configured",
  };

  // Public chain settings for wallets (contract addresses are public data).
  app.get("/v1/chain", async (request, reply) => {
    if (!dependencies.chain) {
      return reply
        .status(503)
        .send({ error: { ...chainMissing, requestId: request.id } });
    }

    return reply.send({
      chainId: dependencies.chain.chain.chainId,
      campaignManager: dependencies.chain.chain.contractAddress,
      usdc: dependencies.chain.chain.usdcAddress,
    });
  });

  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/publish",
    async (request, reply) => {
      const error = (status: number, body: { code: string; message: string }) =>
        reply
          .status(status)
          .send({ error: { ...body, requestId: request.id } });

      const campaign = UUID_PATTERN.test(request.params.id)
        ? await dependencies.campaigns.getById(request.params.id)
        : null;

      if (!campaign) return error(404, notFound);
      if (
        !(await requireWallet(
          dependencies.authenticate,
          request,
          reply,
          campaign.advertiserAddress,
        ))
      ) {
        return reply;
      }
      if (!dependencies.chain) return error(503, chainMissing);

      if (campaign.status !== "draft" || campaign.onchainCampaignId !== null) {
        return error(409, {
          code: "CAMPAIGN_ALREADY_PUBLISHED",
          message: "Campaign is already linked to an on-chain campaign",
        });
      }

      if (campaign.startAt <= dependencies.chain.now()) {
        return error(409, {
          code: "CAMPAIGN_START_PASSED",
          message: "The contract rejects campaigns whose start time has passed",
        });
      }

      return reply.send(publishIntent(campaign, dependencies.chain.chain));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/onchain",
    async (request, reply) => {
      const error = (status: number, body: { code: string; message: string }) =>
        reply
          .status(status)
          .send({ error: { ...body, requestId: request.id } });

      const owned = UUID_PATTERN.test(request.params.id)
        ? await dependencies.campaigns.getById(request.params.id)
        : null;
      if (!owned) return error(404, notFound);
      if (
        !(await requireWallet(
          dependencies.authenticate,
          request,
          reply,
          owned.advertiserAddress,
        ))
      ) {
        return reply;
      }
      if (!dependencies.chain) return error(503, chainMissing);

      const parsed = linkBodySchema.safeParse(request.body);

      if (!parsed.success) {
        return error(400, {
          code: "INVALID_TX_HASH",
          message: "txHash must be a 32-byte hex transaction hash",
        });
      }

      const outcome = await linkCampaignByTransaction(
        { ...dependencies.chain, campaigns: dependencies.campaigns },
        { campaignId: request.params.id, txHash: parsed.data.txHash },
      );

      if (!outcome.ok) {
        const pending =
          outcome.code === "TX_PENDING" || outcome.code === "RPC_UNAVAILABLE";
        return reply.status(outcome.status).send(
          pending
            ? {
                // Not a failure: the transaction may still be mined.
                status: "reconciling",
                code: outcome.code,
                retryAfterSeconds: 10,
              }
            : {
                error: {
                  code: outcome.code,
                  message: "On-chain campaign could not be linked",
                  requestId: request.id,
                },
              },
        );
      }

      return reply.send({
        id: outcome.campaign.id,
        onchainCampaignId: outcome.campaign.onchainCampaignId,
        publishTxHash: outcome.campaign.publishTxHash,
        status: outcome.campaign.status,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/campaigns/:id/analytics",
    async (request, reply) => {
      const campaign = UUID_PATTERN.test(request.params.id)
        ? await dependencies.campaigns.getById(request.params.id)
        : null;

      if (!campaign) {
        return reply
          .status(404)
          .send({ error: { ...notFound, requestId: request.id } });
      }

      if (
        !(await requireWallet(
          dependencies.authenticate,
          request,
          reply,
          campaign.advertiserAddress,
        ))
      ) {
        return reply;
      }

      const submissions = await dependencies.submissions.countByCampaign(
        campaign.id,
      );
      const quality = await dependencies.submissions.qualitySummary(
        campaign.id,
      );
      const budget = (
        BigInt(campaign.rewardAtomic) * BigInt(campaign.maxCompletions)
      ).toString();

      let settlement = null;

      if (dependencies.chain && campaign.onchainCampaignId !== null) {
        const events = await dependencies.chain.events.listCampaignEvents(
          dependencies.chain.chain,
          campaign.onchainCampaignId,
        );
        const reconciled = reconcileCampaignEvents(events);
        settlement = {
          // Only finalized events: this is the number to rely on.
          confirmed: reconciled.confirmed,
          // Includes not-yet-confirmed events, for progress display only.
          pending: reconciled.pending,
          hasUnconfirmedEvents: reconciled.hasUnconfirmedEvents,
        };
      }

      return reply.send({
        campaignId: campaign.id,
        onchainCampaignId: campaign.onchainCampaignId,
        status: campaign.status,
        rewardPerCompletion: campaign.rewardAtomic,
        maxCompletions: campaign.maxCompletions,
        plannedBudget: budget,
        submissions: {
          accepted: submissions.accepted,
          rejected: submissions.rejected,
          // Fraud-adjusted view (#25): raw accepted minus flagged accepted.
          flaggedAccepted: quality.flaggedAccepted,
          adjustedAccepted: submissions.accepted - quality.flaggedAccepted,
          flagReasons: quality.reasons,
        },
        settlement,
      });
    },
  );
}
