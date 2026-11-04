import { isCurrentDeployment } from "@vham/shared/deployment";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { reconcileCampaignEvents } from "../chain/campaign-state.js";
import type { ChainEventRepository } from "../chain/events-repository.js";
import { RpcError } from "../chain/rpc.js";
import type { SubmissionRepository } from "../submissions/repository.js";
import {
  draftRefFor,
  linkCampaignByDraft,
  linkCampaignByTransaction,
  publishIntent,
  readCampaignIdByDraft,
  type OnchainDependencies,
} from "./onchain.js";
import { requireWallet } from "../auth/routes.js";
import type { Authenticate } from "../auth/siwe.js";
import { sendError } from "../errors/catalog.js";
import { BYTES32_HEX, UUID } from "../http/validation.js";
import type { CampaignRepository } from "./repository.js";

// txHash is optional: without it the draft is linked by its draft reference
// (ADR-0011), e.g. after a lost RPC response.
const linkBodySchema = z
  .object({
    txHash: z.string().regex(BYTES32_HEX).optional(),
  })
  .optional();

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
      return sendError(request, reply, 503, chainMissing);
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
        sendError(request, reply, status, body);

      const campaign = UUID.test(request.params.id)
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

      // Linking reads the indexed confirmed block, so a creation that is
      // mined but not final yet is invisible to it. The latest block already shows it:
      // a second tab or browser gets no intent for a send that could only
      // revert (DraftAlreadyCreated) and cost gas (#78).
      let created: string | null;
      try {
        created = await readCampaignIdByDraft(
          dependencies.chain.rpc,
          dependencies.chain.chain.contractAddress,
          campaign.advertiserAddress,
          draftRefFor(campaign.id),
        );
      } catch (caught) {
        if (!(caught instanceof RpcError)) throw caught;
        return error(503, {
          code: "RPC_UNAVAILABLE",
          message: "The chain could not be read; retry shortly",
        });
      }

      if (created !== null) {
        return error(409, {
          code: "DRAFT_ALREADY_CREATED",
          message:
            "This draft's campaign already exists on-chain; link it with POST /v1/campaigns/:id/onchain",
        });
      }

      return reply.send(publishIntent(campaign, dependencies.chain.chain));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/onchain",
    async (request, reply) => {
      const error = (status: number, body: { code: string; message: string }) =>
        sendError(request, reply, status, body);

      const owned = UUID.test(request.params.id)
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

      const onchain = {
        ...dependencies.chain,
        campaigns: dependencies.campaigns,
      };
      const txHash = parsed.data?.txHash;
      const outcome = txHash
        ? await linkCampaignByTransaction(onchain, {
            campaignId: request.params.id,
            txHash,
          })
        : await linkCampaignByDraft(onchain, { campaignId: request.params.id });

      if (!outcome.ok) {
        const pending =
          outcome.code === "TX_PENDING" ||
          outcome.code === "TX_UNCONFIRMED" ||
          outcome.code === "NOT_CREATED_YET" ||
          outcome.code === "RPC_UNAVAILABLE";
        if (pending) {
          return reply.status(outcome.status).send({
            // Not a failure: the transaction may still be mined.
            status: "reconciling",
            code: outcome.code,
            retryAfterSeconds: 10,
          });
        }
        return error(outcome.status, {
          code: outcome.code,
          message: "On-chain campaign could not be linked",
        });
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
      const campaign = UUID.test(request.params.id)
        ? await dependencies.campaigns.getById(request.params.id)
        : null;

      if (!campaign) {
        return sendError(request, reply, 404, notFound);
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

      // Events are read only from the deployment the campaign is linked to;
      // ids restart on every deployment (ADR-0011).
      if (
        dependencies.chain &&
        campaign.onchainCampaignId !== null &&
        isCurrentDeployment(
          {
            chainId: campaign.chainId,
            contractAddress: campaign.onchainContractAddress,
          },
          dependencies.chain.chain,
        )
      ) {
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
        chainId: campaign.chainId,
        onchainCampaignId: campaign.onchainCampaignId,
        onchainContractAddress: campaign.onchainContractAddress,
        status: campaign.status,
        rewardPerCompletion: campaign.rewardAtomic,
        maxCompletions: campaign.maxCompletions,
        startAt: campaign.startAt.toISOString(),
        endAt: campaign.endAt.toISOString(),
        // What the advertiser's wallet checks on-chain before funding.
        draftRef: draftRefFor(campaign.id),
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
