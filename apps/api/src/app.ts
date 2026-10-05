import Fastify from "fastify";

import {
  InMemoryCampaignRepository,
  type CampaignRepository,
} from "./campaigns/repository.js";
import { registerCampaignRoutes } from "./campaigns/routes.js";

export interface AppDependencies {
  campaignRepository?: CampaignRepository;
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
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
  });

  if (dependencies.close) {
    app.addHook("onClose", async () => {
      await dependencies.close?.();
    });
  }

  return app;
}
