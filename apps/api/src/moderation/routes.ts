import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthSession } from "../auth/repository.js";
import type { Authenticate } from "../auth/siwe.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type { CampaignRecord } from "../campaigns/types.js";
import {
  ModerationError,
  REPORT_REASONS,
  type ModerationRepository,
  type ModerationStatus,
} from "./repository.js";

/**
 * review  every campaign needs an operator approval (or an allowlisted
 *         advertiser) before the API serves it. Required outside anvil.
 * open    campaigns start approved (local demos/tests); take-downs still apply.
 */
export type ModerationMode = "review" | "open";

export interface ModerationConfig {
  mode: ModerationMode;
  /** Lowercase wallets allowed to use /v1/admin (SIWE sessions). */
  operators: readonly string[];
  /** Lowercase advertiser wallets whose campaigns start approved. */
  advertiserAllowlist: readonly string[];
}

export const OPEN_MODERATION: ModerationConfig = {
  mode: "open",
  operators: [],
  advertiserAllowlist: [],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Routes that serve a campaign to new participants or publish it. */
const GATED_ROUTES = new Set([
  "GET /v1/campaigns/:id/mission",
  "POST /v1/campaigns/:id/eligibility/verify",
  "POST /v1/campaigns/:id/submissions",
  "POST /v1/campaigns/:id/publish",
]);

interface ModerationDependencies {
  moderation: ModerationRepository;
  campaigns: CampaignRepository;
  authenticate: Authenticate;
  config: ModerationConfig;
  now: () => Date;
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.status(status).send({
    error: { code, message, requestId: request.id },
  });
}

/** Effective status: a campaign without a state row is unreviewed. */
function effectiveStatus(
  stored: ModerationStatus | undefined,
  mode: ModerationMode,
): ModerationStatus {
  return stored ?? (mode === "open" ? "approved" : "pending_review");
}

/** Called after campaign creation (also on idempotent replays). */
export function moderationOnCreate(dependencies: {
  moderation: ModerationRepository;
  config: ModerationConfig;
  now: () => Date;
}) {
  return async (campaign: CampaignRecord) => {
    const allowlisted = dependencies.config.advertiserAllowlist.includes(
      campaign.advertiserAddress,
    );

    if (dependencies.config.mode === "open") {
      await dependencies.moderation.initialize(
        campaign.id,
        "approved",
        "system",
        "open moderation mode",
        dependencies.now(),
      );
    } else if (allowlisted) {
      await dependencies.moderation.initialize(
        campaign.id,
        "approved",
        "system",
        "advertiser allowlist",
        dependencies.now(),
      );
    } else {
      await dependencies.moderation.initialize(
        campaign.id,
        "pending_review",
        "system",
        "awaiting review",
        dependencies.now(),
      );
    }
  };
}

/**
 * Blocks campaigns that are not approved from being served or published.
 * Registered on the root instance so it covers every gated route; claim
 * authorization is deliberately not gated (completed work stays payable).
 */
export function registerModerationGate(
  app: FastifyInstance,
  dependencies: Omit<ModerationDependencies, "authenticate" | "now">,
) {
  app.addHook("preHandler", async (request, reply) => {
    const key = `${request.method} ${request.routeOptions.url ?? ""}`;

    if (!GATED_ROUTES.has(key)) {
      return;
    }

    const campaignId = (request.params as { id?: string }).id ?? "";

    // Unknown campaigns fall through to the route's own 404.
    if (
      !UUID.test(campaignId) ||
      !(await dependencies.campaigns.getById(campaignId))
    ) {
      return;
    }

    const state = await dependencies.moderation.getState(campaignId);
    const status = effectiveStatus(state?.status, dependencies.config.mode);

    if (status === "approved") {
      return;
    }

    if (status === "taken_down") {
      return fail(
        request,
        reply,
        410,
        "CAMPAIGN_TAKEN_DOWN",
        "This campaign was removed after review",
      );
    }

    return fail(
      request,
      reply,
      403,
      "CAMPAIGN_NOT_APPROVED",
      status === "rejected"
        ? "This campaign was rejected in review"
        : "This campaign is awaiting review",
    );
  });
}

const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional(),
});

const actionSchema = z.object({
  action: z.enum(["approve", "reject", "take_down", "reinstate"]),
  reason: z.string().trim().min(1).max(500),
  reportId: z.string().regex(UUID).optional(),
});

const resolveSchema = z.object({
  resolution: z.enum(["dismissed", "actioned"]),
  reason: z.string().trim().min(1).max(500),
});

const statusQuery = z.object({
  status: z
    .enum(["pending_review", "approved", "rejected", "taken_down"])
    .default("pending_review"),
});

const reportQuery = z.object({
  status: z.enum(["open", "dismissed", "actioned"]).default("open"),
});

export async function registerModerationRoutes(
  app: FastifyInstance,
  dependencies: ModerationDependencies,
) {
  const { moderation, campaigns, config, now } = dependencies;

  async function requireOperator(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthSession | null> {
    const session = await dependencies.authenticate(request);

    if (!session) {
      await fail(request, reply, 401, "UNAUTHENTICATED", "Sign in first");
      return null;
    }

    if (!config.operators.includes(session.address)) {
      await fail(
        request,
        reply,
        403,
        "NOT_OPERATOR",
        "The signed-in wallet is not a moderation operator",
      );
      return null;
    }

    return session;
  }

  const actor = (session: AuthSession) => `operator:${session.address}`;

  function moderationFailure(
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
  ) {
    if (error instanceof ModerationError) {
      const status = error.code === "REPORT_NOT_FOUND" ? 404 : 409;
      return fail(request, reply, status, error.code, error.message);
    }

    throw error;
  }

  // Public: anyone who sees a campaign can report it. The reporter is not
  // identified or stored (privacy policy, #22).
  app.post<{ Params: { id: string } }>(
    "/v1/campaigns/:id/reports",
    async (request, reply) => {
      const parsed = reportSchema.safeParse(request.body);

      if (!parsed.success) {
        return fail(request, reply, 400, "INVALID_REPORT", "Invalid report");
      }

      if (
        !UUID.test(request.params.id) ||
        !(await campaigns.getById(request.params.id))
      ) {
        return fail(request, reply, 404, "CAMPAIGN_NOT_FOUND", "Not found");
      }

      const report = await moderation.createReport({
        campaignId: request.params.id,
        reason: parsed.data.reason,
        details: parsed.data.details || null,
        at: now(),
      });

      return reply
        .status(201)
        .send({ reportId: report.id, status: report.status });
    },
  );

  app.get("/v1/admin/moderation", async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;

    const query = statusQuery.safeParse(request.query);

    if (!query.success) {
      return fail(request, reply, 400, "INVALID_QUERY", "Invalid status");
    }

    const states = await moderation.listByStatus(query.data.status, 100);
    const items = await Promise.all(
      states.map(async (state) => {
        const campaign = await campaigns.getById(state.campaignId);
        return {
          campaignId: state.campaignId,
          status: state.status,
          updatedAt: state.updatedAt.toISOString(),
          advertiser: campaign?.advertiserAddress ?? null,
          contentUrl: campaign?.contentUrl ?? null,
          startAt: campaign?.startAt.toISOString() ?? null,
        };
      }),
    );

    return { items };
  });

  app.get<{ Params: { id: string } }>(
    "/v1/admin/campaigns/:id/moderation",
    async (request, reply) => {
      if (!(await requireOperator(request, reply))) return reply;

      const campaign = UUID.test(request.params.id)
        ? await campaigns.getById(request.params.id)
        : null;

      if (!campaign) {
        return fail(request, reply, 404, "CAMPAIGN_NOT_FOUND", "Not found");
      }

      const state = await moderation.getState(campaign.id);
      const [actions, reports] = await Promise.all([
        moderation.listActions(campaign.id),
        moderation.listReports({ campaignId: campaign.id }, 100),
      ]);

      return {
        campaignId: campaign.id,
        status: effectiveStatus(state?.status, config.mode),
        contentUrl: campaign.contentUrl,
        advertiser: campaign.advertiserAddress,
        actions: actions.map((action) => ({
          ...action,
          createdAt: action.createdAt.toISOString(),
        })),
        reports: reports.map((report) => ({
          ...report,
          createdAt: report.createdAt.toISOString(),
          resolvedAt: report.resolvedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/admin/campaigns/:id/moderation",
    async (request, reply) => {
      const session = await requireOperator(request, reply);
      if (!session) return reply;

      const parsed = actionSchema.safeParse(request.body);

      if (!parsed.success) {
        return fail(request, reply, 400, "INVALID_ACTION", "Invalid action");
      }

      const campaign = UUID.test(request.params.id)
        ? await campaigns.getById(request.params.id)
        : null;

      if (!campaign) {
        return fail(request, reply, 404, "CAMPAIGN_NOT_FOUND", "Not found");
      }

      try {
        const state = await moderation.applyAction({
          campaignId: campaign.id,
          action: parsed.data.action,
          actor: actor(session),
          reason: parsed.data.reason,
          reportId: parsed.data.reportId ?? null,
          at: now(),
        });

        request.log.warn(
          {
            audit: "moderation_action",
            campaignId: campaign.id,
            action: parsed.data.action,
            status: state.status,
            operator: session.address,
          },
          "Moderation action applied",
        );

        return {
          campaignId: campaign.id,
          status: state.status,
          updatedAt: state.updatedAt.toISOString(),
        };
      } catch (error) {
        return moderationFailure(request, reply, error);
      }
    },
  );

  app.get("/v1/admin/reports", async (request, reply) => {
    if (!(await requireOperator(request, reply))) return reply;

    const query = reportQuery.safeParse(request.query);

    if (!query.success) {
      return fail(request, reply, 400, "INVALID_QUERY", "Invalid status");
    }

    const reports = await moderation.listReports(
      { status: query.data.status },
      100,
    );

    return {
      items: reports.map((report) => ({
        ...report,
        createdAt: report.createdAt.toISOString(),
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post<{ Params: { reportId: string } }>(
    "/v1/admin/reports/:reportId/resolve",
    async (request, reply) => {
      const session = await requireOperator(request, reply);
      if (!session) return reply;

      const parsed = resolveSchema.safeParse(request.body);

      if (!parsed.success || !UUID.test(request.params.reportId)) {
        return fail(request, reply, 400, "INVALID_RESOLUTION", "Invalid");
      }

      try {
        const report = await moderation.resolveReport({
          reportId: request.params.reportId,
          resolution: parsed.data.resolution,
          actor: actor(session),
          reason: parsed.data.reason,
          at: now(),
        });

        return {
          reportId: report.id,
          status: report.status,
          resolvedAt: report.resolvedAt?.toISOString() ?? null,
        };
      } catch (error) {
        return moderationFailure(request, reply, error);
      }
    },
  );
}
