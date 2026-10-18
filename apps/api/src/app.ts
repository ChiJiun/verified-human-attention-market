import Fastify from "fastify";

import {
  InMemoryAuthRepository,
  type AuthRepository,
} from "./auth/repository.js";
import { registerAuthRoutes } from "./auth/routes.js";
import {
  InMemoryApiClientRepository,
  type ApiClientRepository,
} from "./api-clients/repository.js";
import {
  apiClientSession,
  DEFAULT_RATE_LIMITS,
  registerApiClientGate,
  registerApiClientRoutes,
  type RateLimitConfig,
} from "./api-clients/routes.js";
import { registerErrorModel } from "./errors/catalog.js";
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
import {
  registerEligibilityRoutes,
  type WorldIdRequestConfig,
} from "./eligibility/routes.js";
import {
  InMemorySubmissionRepository,
  type SubmissionRepository,
} from "./submissions/repository.js";
import { registerSubmissionRoutes } from "./submissions/routes.js";
import {
  InMemoryModerationRepository,
  type ModerationRepository,
} from "./moderation/repository.js";
import {
  moderationOnCreate,
  OPEN_MODERATION,
  registerModerationGate,
  registerModerationRoutes,
  type ModerationConfig,
} from "./moderation/routes.js";
import type { ContentUrlPolicy } from "./moderation/url-policy.js";
import {
  generateRequestId,
  LOGGER_REDACT_PATHS,
  registerInstrumentation,
} from "./observability/instrumentation.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { PayoutAnomalyDetector } from "./observability/payout-anomaly.js";
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
  /** Global 24 h claim-liability limit (atomic units); null = none (#23). */
  dailyPayoutLimitAtomic?: bigint | null;
  worldIdVerifier?: WorldIdVerifier;
  /** RP signing for IDKit requests (#12); null or absent = disabled. */
  worldIdRequest?: WorldIdRequestConfig | null;
  /** On-chain integration (RPC, contract, indexed events); null = disabled. */
  chain?: OnchainRouteDependencies["chain"];
  /** HMAC secret for participant keys; eligibility fails closed without it. */
  participantKeySecret?: string | null;
  chainId?: number;
  metrics?: MetricsRegistry;
  /** Bearer token for GET /metrics; null or absent = unauthenticated. */
  metricsToken?: string | null;
  payoutAnomalies?: PayoutAnomalyDetector;
  moderationRepository?: ModerationRepository;
  /** Defaults to open mode (tests); server.ts requires review off anvil. */
  moderation?: ModerationConfig;
  contentUrlPolicy?: ContentUrlPolicy;
  apiClientRepository?: ApiClientRepository;
  /** null or absent = no rate limiting (tests); server.ts enables it. */
  rateLimits?: RateLimitConfig | null;
  /** Trusted reverse-proxy hops (0 = none) for per-IP rate limits. */
  trustProxyHops?: number;
  close?: () => Promise<void>;
  now?: () => Date;
}

export function buildApp(dependencies: AppDependencies = {}) {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : { redact: { paths: LOGGER_REDACT_PATHS, censor: "[redacted]" } },
    genReqId: generateRequestId,
    requestIdLogLabel: "requestId",
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
  const chainId = dependencies.chainId ?? 84532;
  const sessions =
    dependencies.authenticate ?? sessionAuthenticator(authRepository, now);
  // API keys (#26) act as their advertiser; otherwise SIWE sessions.
  const authenticate: Authenticate = async (request) =>
    request.apiClient
      ? apiClientSession(request.apiClient, chainId)
      : sessions(request);
  const apiEnvironment: "sandbox" | "live" = [31337, 84532].includes(chainId)
    ? "sandbox"
    : "live";
  const apiClientRepository =
    dependencies.apiClientRepository ?? new InMemoryApiClientRepository();
  const chain = dependencies.chain ?? null;
  const metrics = dependencies.metrics ?? new MetricsRegistry();

  const indexerLag = metrics.gauge(
    "vham_indexer_lag_blocks",
    "Chain head minus the indexer's latest confirmed block",
  );
  const chainHead = metrics.gauge("vham_chain_head_block", "Latest RPC block");
  const rpcUp = metrics.gauge("vham_rpc_up", "1 when the chain RPC answers");

  /** Head and confirmed-cursor lag; throws when the RPC is unreachable. */
  async function chainStatus() {
    if (!chain) return null;

    let head: bigint;
    try {
      head = await chain.rpc.blockNumber();
    } catch (error) {
      rpcUp.set(0);
      throw error;
    }
    rpcUp.set(1);
    chainHead.set(Number(head));

    const cursor = await chain.events.getCursor({
      chainId: chain.chain.chainId,
      contractAddress: chain.chain.contractAddress,
    });
    const lag = cursor ? head - cursor.latestConfirmedBlock : null;
    if (lag !== null) indexerLag.set(Number(lag));
    return { head, lag };
  }

  registerErrorModel(app);
  registerApiClientGate(app, {
    clients: apiClientRepository,
    environment: apiEnvironment,
    rateLimits: dependencies.rateLimits ?? null,
    trustProxyHops: dependencies.trustProxyHops ?? 0,
    metrics,
    now,
  });

  registerInstrumentation(app, {
    metrics,
    payoutAnomalies:
      dependencies.payoutAnomalies ?? new PayoutAnomalyDetector(),
    metricsToken: dependencies.metricsToken ?? null,
    now,
    collect: async () => {
      await chainStatus();
    },
  });

  const moderationRepository =
    dependencies.moderationRepository ?? new InMemoryModerationRepository();
  const moderationConfig = dependencies.moderation ?? OPEN_MODERATION;

  registerModerationGate(app, {
    moderation: moderationRepository,
    campaigns: campaignRepository,
    config: moderationConfig,
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, string> = { process: "ok" };
    let indexerLagBlocks: string | null | undefined;

    try {
      await campaignRepository.ping();
      checks.database = "ok";
    } catch {
      checks.database = "error";
    }

    if (chain) {
      try {
        const status = await chainStatus();
        checks.chain = "ok";
        indexerLagBlocks = status?.lag?.toString() ?? null;
      } catch {
        checks.chain = "error";
      }
    }

    const healthy = Object.values(checks).every((value) => value === "ok");
    // Only check names and states: never URLs, hosts or error messages.
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "error",
      checks,
      ...(indexerLagBlocks === undefined ? {} : { indexerLagBlocks }),
    });
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
      contentUrlPolicy: dependencies.contentUrlPolicy,
      onCampaignCreated: moderationOnCreate({
        moderation: moderationRepository,
        config: moderationConfig,
        now,
      }),
    });

    await registerApiClientRoutes(instance, {
      clients: apiClientRepository,
      authenticate,
      environment: apiEnvironment,
      operators: moderationConfig.operators,
      rateLimits: dependencies.rateLimits ?? DEFAULT_RATE_LIMITS,
      now,
    });

    await registerModerationRoutes(instance, {
      moderation: moderationRepository,
      campaigns: campaignRepository,
      authenticate,
      config: moderationConfig,
      now,
    });

    await registerEligibilityRoutes(instance, {
      campaigns: campaignRepository,
      eligibility: eligibilityRepository,
      worldId: worldIdVerifier,
      participantKeySecret: dependencies.participantKeySecret ?? null,
      worldIdRequest: dependencies.worldIdRequest ?? null,
      now,
    });

    await registerOnchainRoutes(instance, {
      authenticate,
      campaigns: campaignRepository,
      submissions: submissionRepository,
      chain,
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
      dailyPayoutLimitAtomic: dependencies.dailyPayoutLimitAtomic ?? null,
      chain: dependencies.chain
        ? {
            chainId: dependencies.chain.chain.chainId,
            contractAddress: dependencies.chain.chain
              .contractAddress as `0x${string}`,
            rpc: dependencies.chain.rpc,
            events: dependencies.chain.events,
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
