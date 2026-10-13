import Fastify from "fastify";

import {
  InMemoryAuthRepository,
  type AuthRepository,
} from "./auth/repository.js";
import { registerAuthRoutes } from "./auth/routes.js";
import {
  sessionAuthenticator,
  verifyEoaSignature,
  type Authenticate,
  type SignatureVerifier,
  type SiweConfig,
} from "./auth/siwe.js";
import { registerClaimRoutes } from "./claims/routes.js";
import {
  InMemoryClaimRepository,
  type ClaimRepository,
} from "./claims/repository.js";
import type { ClaimSigner } from "./claims/signer.js";

import {
  InMemoryCampaignRepository,
  type CampaignRepository,
} from "./campaigns/repository.js";
import {
  registerOnchainRoutes,
  type OnchainRouteDependencies,
} from "./campaigns/onchain-routes.js";
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
  claimRepository?: ClaimRepository;
  authRepository?: AuthRepository;
  /** SIWE domain/chain; null or absent = sign-in disabled (fail closed). */
  siwe?: SiweConfig | null;
  verifySignature?: SignatureVerifier;
  /** Overrides session lookup (tests of non-auth features). */
  authenticate?: Authenticate;
  claimSigner?: ClaimSigner | null;
  worldIdVerifier?: WorldIdVerifier;
  /** On-chain integration (RPC, contract, indexed events); null = disabled. */
  chain?: OnchainRouteDependencies["chain"];
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
  const claimRepository =
    dependencies.claimRepository ??
    new InMemoryClaimRepository(
      (id) => submissionRepository.getById(id),
      (id) => campaignRepository.getById(id),
    );
  const worldIdVerifier =
    dependencies.worldIdVerifier ?? new UnconfiguredWorldIdVerifier();
  const now = dependencies.now ?? (() => new Date());
  const authRepository =
    dependencies.authRepository ?? new InMemoryAuthRepository();
  const authenticate =
    dependencies.authenticate ?? sessionAuthenticator(authRepository, now);
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
    await registerAuthRoutes(instance, {
      repository: authRepository,
      config: dependencies.siwe ?? null,
      verifySignature: dependencies.verifySignature ?? verifyEoaSignature,
      authenticate,
      now,
    });

    await registerCampaignRoutes(instance, {
      authenticate,
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

    await registerOnchainRoutes(instance, {
      authenticate,
      campaigns: campaignRepository,
      submissions: submissionRepository,
      chain: dependencies.chain ?? null,
    });

    await registerSubmissionRoutes(instance, {
      campaigns: campaignRepository,
      eligibility: eligibilityRepository,
      submissions: submissionRepository,
      now,
    });

    await registerClaimRoutes(instance, {
      campaigns: campaignRepository,
      eligibility: eligibilityRepository,
      submissions: submissionRepository,
      claims: claimRepository,
      signer: dependencies.claimSigner ?? null,
      chain: dependencies.chain
        ? {
            chainId: dependencies.chain.chain.chainId,
            contractAddress: dependencies.chain.chain
              .contractAddress as `0x${string}`,
            rpc: dependencies.chain.rpc,
          }
        : null,
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
