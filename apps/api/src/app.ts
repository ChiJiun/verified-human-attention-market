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
import {
  frameworkErrors,
  registerErrorHandlers,
  registerErrorModel,
} from "./errors/catalog.js";
import {
  registerSessionCookieGuard,
  sessionAuthenticator,
} from "./auth/credential.js";
import {
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
import { claimAuthorizationObserver } from "./observability/claim-authorizations.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { PayoutAnomalyDetector } from "./observability/payout-anomaly.js";
import type { WorldIdVerifier } from "./identity/world-id.js";
import {
  worldIdVerifierFor,
  type WorldIdConfig,
} from "./identity/world-id-config.js";
import { authorizeClaim, prepareClaim } from "./claims/service.js";

export interface AppDependencies {
  campaignRepository?: CampaignRepository;
  eligibilityRepository?: EligibilityRepository;
  submissionRepository?: SubmissionRepository;
  claimRepository?: ClaimRepository;
  authRepository?: AuthRepository;
  /** SIWE domain/chain; null or absent = sign-in disabled (fail closed). */
  siwe?: SiweConfig | null;
  /**
   * Origin a cookie-authenticated mutation may come from when the browser
   * sends no Fetch Metadata; null or absent = Fetch Metadata only.
   */
  webOrigin?: string | null;
  verifySignature?: SignatureVerifier;
  /** Overrides session lookup (tests of non-auth features). */
  authenticate?: Authenticate;
  claimSigner?: ClaimSigner | null;
  /** Global 24 h claim-liability limit (atomic units); null = none (#23). */
  dailyPayoutLimitAtomic?: bigint | null;
  worldId?: WorldIdConfig | null;
  worldIdVerifierOverride?: WorldIdVerifier;
  /** On-chain integration (RPC, contract, indexed events); null = disabled. */
  chain?: OnchainRouteDependencies["chain"];
  /** HMAC secret for participant keys; eligibility fails closed without it. */
  participantKeySecret?: string | null;
  chainId?: number;
  /**
   * This app's own registry: its chain and halt gauges keep their reads in
   * order only within one app, so buildApp refuses a registry that another
   * open app uses (it is free again once that app closes).
   */
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
  /** Receives the JSON log lines; turns logging on under NODE_ENV=test. */
  logStream?: { write(line: string): void };
}

/**
 * Orders reads that may overlap, such as a scrape's and a readiness check's:
 * each is numbered when it starts, and its result is published only if no
 * read that started later has been. So of the reads that have finished, the
 * last started is the one published, and an older read that finishes later
 * changes nothing.
 */
function orderedReads() {
  let started = 0;
  let published = 0;
  return {
    start: () => ++started,
    publish(read: number, set: () => void) {
      if (read < published) return;
      published = read;
      set();
    },
  };
}

/**
 * Registries that an open app uses. Each app orders its own reads
 * (orderedReads), and a registry returns the gauge it already holds by name,
 * so two apps on one registry would write the same gauges out of order.
 */
const registriesInUse = new WeakSet<MetricsRegistry>();

export function buildApp(dependencies: AppDependencies = {}) {
  // Same rule as INDEXER_CONFIRMATIONS: 0 would link unconfirmed creations.
  const confirmations = dependencies.chain?.confirmations;
  if (
    confirmations !== undefined &&
    (!Number.isSafeInteger(confirmations) || confirmations < 1)
  ) {
    throw new Error("chain.confirmations must be a positive integer");
  }

  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test" && !dependencies.logStream
        ? false
        : {
            redact: { paths: LOGGER_REDACT_PATHS, censor: "[redacted]" },
            ...(dependencies.logStream && {
              level: "info",
              stream: dependencies.logStream,
            }),
          },
    frameworkErrors,
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
  const now = dependencies.now ?? (() => new Date());
  const authRepository =
    dependencies.authRepository ?? new InMemoryAuthRepository();
  const chainId = dependencies.chainId ?? 84532;
  const worldIdConfig = dependencies.worldId ?? null;
  const worldIdVerifier =
    dependencies.worldIdVerifierOverride ??
    worldIdVerifierFor(worldIdConfig, chainId);
  const webOrigin = dependencies.webOrigin ?? null;
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
  if (registriesInUse.has(metrics)) {
    throw new Error(
      "metrics registry is used by another open app; give each app its own",
    );
  }
  registriesInUse.add(metrics);
  app.addHook("onClose", async () => {
    registriesInUse.delete(metrics);
  });

  const indexerLag = metrics.gauge(
    "vham_indexer_lag_blocks",
    "Chain head minus the indexer's latest confirmed block",
  );
  const chainHead = metrics.gauge("vham_chain_head_block", "Latest RPC block");
  const rpcUp = metrics.gauge("vham_rpc_up", "1 when the chain RPC answers");
  const haltedGauge = metrics.gauge(
    "vham_chain_halted",
    "1 while a reorg beyond the confirmation depth halts the deployment",
  );

  const chainReads = orderedReads();
  const haltReads = orderedReads();

  /**
   * Head and confirmed-cursor lag; throws when the RPC or the cursor cannot
   * be read. Scrapes and readiness checks both call it, at the same time too,
   * so the gauges change only once its reads are done, all in one step, and
   * only if no read that started later has changed them (orderedReads): a
   * scrape exports one whole read, the last started of those finished, never
   * the head of one and the lag of another.
   */
  async function chainStatus() {
    if (!chain) return null;
    const read = chainReads.start();

    let head: bigint;
    try {
      head = await chain.rpc.blockNumber();
    } catch (error) {
      publishChainRead(read, null, null);
      throw error;
    }

    let cursor: Awaited<ReturnType<typeof chain.events.getCursor>>;
    try {
      cursor = await chain.events.getCursor({
        chainId: chain.chain.chainId,
        contractAddress: chain.chain.contractAddress,
      });
    } catch (error) {
      publishChainRead(read, head, null);
      throw error;
    }
    // No cursor: the worker has committed nothing yet, or `reorg:recover
    // --apply` reset the index. Then no lag is exported, not the last one.
    const lag = cursor ? head - cursor.latestConfirmedBlock : null;
    publishChainRead(read, head, lag);
    return { head, lag };
  }

  /**
   * Sets the chain gauges from read number `read`, unless a read that
   * started later already has. A value that was not read is removed: without
   * the RPC or the cursor, the last head and lag no longer hold. `head` is
   * null when the RPC could not be read.
   */
  function publishChainRead(
    read: number,
    head: bigint | null,
    lag: bigint | null,
  ) {
    chainReads.publish(read, () => {
      rpcUp.set(head === null ? 0 : 1);
      if (head === null) chainHead.remove();
      else chainHead.set(Number(head));
      if (lag === null) indexerLag.remove();
      else indexerLag.set(Number(lag));
    });
  }

  /**
   * Whether a deep-reorg halt is recorded (ADR-0011). A gauge, so the alert
   * holds for as long as the halt does, whichever scrape sees it (#77).
   * Fails closed: a read that cannot read the halt sets the gauge to 1, never
   * a stale 0 or a missing series (RUNBOOK: VhamChainHalted), unless a read
   * that started later has already set it. Reads are ordered like
   * chainStatus()'s (orderedReads): a read that started later and has
   * finished, such as a readiness check's, replaces a failed read's 1, and
   * an older read that finishes later changes nothing.
   */
  async function haltStatus() {
    if (!chain) return null;
    const read = haltReads.start();

    try {
      const halt = await chain.events.getHalt({
        chainId: chain.chain.chainId,
        contractAddress: chain.chain.contractAddress,
      });
      haltReads.publish(read, () => haltedGauge.set(halt ? 1 : 0));
      return halt !== null;
    } catch (error) {
      haltReads.publish(read, () => haltedGauge.set(1));
      throw error;
    }
  }

  registerErrorHandlers(app);
  registerErrorModel(app);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  registerApiClientGate(app, {
    clients: apiClientRepository,
    environment: apiEnvironment,
    rateLimits: dependencies.rateLimits ?? null,
    trustProxyHops: dependencies.trustProxyHops ?? 0,
    metrics,
    now,
  });
  registerSessionCookieGuard(app, { webOrigin });

  const observeClaim = claimAuthorizationObserver({
    metrics,
    payoutAnomalies:
      dependencies.payoutAnomalies ?? new PayoutAnomalyDetector(),
    now,
    log: app.log,
  });

  registerInstrumentation(app, {
    metrics,
    metricsToken: dependencies.metricsToken ?? null,
    collect: async () => {
      // The halt is read even when the RPC is down.
      const results = await Promise.allSettled([chainStatus(), haltStatus()]);
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
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
    let halted: boolean | null = null;

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

      // The halt lives in the database. A halt does not fail readiness: the
      // instance still serves (sign-in, drafts, analytics, and a retryable
      // 503 CHAIN_HALTED to participants); it is alerted on (#77).
      try {
        halted = await haltStatus();
      } catch {
        checks.database = "error";
      }
    }

    const healthy = Object.values(checks).every((value) => value === "ok");
    // Only check names and states: never URLs, hosts or error messages.
    return reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "error",
      checks,
      ...(indexerLagBlocks === undefined ? {} : { indexerLagBlocks }),
      ...(halted === null ? {} : { chainHalted: halted }),
    });
  });

  app.register(async (instance) => {
    await registerAuthRoutes(instance, {
      repository: authRepository,
      config: dependencies.siwe ?? null,
      webOrigin,
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

    // Campaigns linked on another deployment are retired (ADR-0011).
    const deployment = dependencies.chain
      ? {
          chainId: dependencies.chain.chain.chainId,
          contractAddress: dependencies.chain.chain.contractAddress,
        }
      : null;

    // A reorg beyond the confirmation depth stops all participation and
    // signing for the deployment until recovery (ADR-0011).
    const chainHalted = async () =>
      dependencies.chain
        ? (await dependencies.chain.events.getHalt(
            dependencies.chain.chain,
          )) !== null
        : false;
    const claimDependencies = {
      campaigns: campaignRepository,
      eligibility: eligibilityRepository,
      submissions: submissionRepository,
      claims: claimRepository,
      signer: dependencies.claimSigner ?? null,
      dailyPayoutLimitAtomic: dependencies.dailyPayoutLimitAtomic ?? null,
      chainHalted,
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
      observe: observeClaim,
    };

    await registerEligibilityRoutes(instance, {
      campaigns: campaignRepository,
      deployment,
      chainHalted,
      eligibility: eligibilityRepository,
      worldId: worldIdVerifier,
      participantKeySecret: dependencies.participantKeySecret ?? null,
      worldIdConfig,
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
      deployment,
      chainHalted,
      eligibility: eligibilityRepository,
      submissions: submissionRepository,
      claims: claimRepository,
      now,
      prepareClaim: claimDependencies.chain
        ? (campaign, claimant) =>
            prepareClaim(claimDependencies, campaign, claimant)
        : null,
      observeClaim,
      issueAuthorization:
        claimDependencies.signer && claimDependencies.chain
          ? (input) => authorizeClaim(claimDependencies, input)
          : null,
    });

    await registerClaimRoutes(instance, claimDependencies);
  });

  if (dependencies.close) {
    app.addHook("onClose", async () => {
      await dependencies.close?.();
    });
  }

  return app;
}
