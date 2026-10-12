import Fastify from "fastify";

import {
  InMemoryCampaignRepository,
  type CampaignRepository,
} from "./campaigns/repository.js";
import { registerCampaignRoutes } from "./campaigns/routes.js";
import {
  InMemoryEligibilityRepository,
  type EligibilityRepository,
} from "./eligibility/repository.js";
import { registerEligibilityRoutes } from "./eligibility/routes.js";
import {
  InMemorySubmissionRepository,
  type SubmissionRepository,
} from "./submissions/repository.js";
import { registerSubmissionRoutes } from "./submissions/routes.js";
import {
  UnconfiguredWorldIdVerifier,
  type WorldIdVerifier,
} from "./identity/world-id.js";

export interface AppDependencies {
  campaignRepository?: CampaignRepository;
  eligibilityRepository?: EligibilityRepository;
  submissionRepository?: SubmissionRepository;
  worldIdVerifier?: WorldIdVerifier;
  /** HMAC secret for participant keys; eligibility fails closed without it. */
  participantKeySecret?: string | null;
  chainId?: number;
  close?: () => Promise<void>;
  now?: () => Date;
}

export function buildApp(dependencies: AppDependencies = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
  });

  const campaignRepository =
    dependencies.campaignRepository ?? new InMemoryCampaignRepository();
  const eligibilityRepository =
    dependencies.eligibilityRepository ?? new InMemoryEligibilityRepository();
  const submissionRepository =
    dependencies.submissionRepository ??
    new InMemorySubmissionRepository(eligibilityRepository);
  const worldIdVerifier =
    dependencies.worldIdVerifier ?? new UnconfiguredWorldIdVerifier();
  const now = dependencies.now ?? (() => new Date());
  const chainId = dependencies.chainId ?? 84532;

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await campaignRepository.ping();

      return {
        status: "ok",
        checks: {
          process: "ok",
          database: "ok",
        },
      };
    } catch {
      return reply.status(503).send({
        status: "error",
        checks: {
          process: "ok",
          database: "error",
        },
      });
    }
  });

  app.register(async (instance) => {
    await registerCampaignRoutes(instance, {
      repository: campaignRepository,
      chainId,
      now,
    });

    await registerEligibilityRoutes(instance, {
      campaigns: campaignRepository,
      eligibility: eligibilityRepository,
      worldId: worldIdVerifier,
      participantKeySecret: dependencies.participantKeySecret ?? null,
      now,
    });

    await registerSubmissionRoutes(instance, {
      campaigns: campaignRepository,
      eligibility: eligibilityRepository,
      submissions: submissionRepository,
      now,
    });
  });

  if (dependencies.close) {
    app.addHook("onClose", async () => {
      await dependencies.close?.();
    });
  }

  return app;
}
