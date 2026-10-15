import { createPublicClient, http } from "viem";

import { PostgresApiClientRepository } from "./api-clients/repository.js";
import { DEFAULT_RATE_LIMITS } from "./api-clients/routes.js";
import { PostgresAuthRepository } from "./auth/repository.js";
import { verifyEoaSignature } from "./auth/siwe.js";
import { PostgresCampaignRepository } from "./campaigns/repository.js";
import { PostgresClaimRepository } from "./claims/repository.js";
import {
  createClaimSigner,
  createRemoteClaimSigner,
  type ClaimSigner,
} from "./claims/signer.js";
import { buildApp } from "./app.js";
import { DEFAULT_CONFIRMATIONS } from "./campaigns/onchain.js";
import { loadChainConfig, verifyChainConnection } from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { createDatabase } from "./db/client.js";
import { PostgresEligibilityRepository } from "./eligibility/repository.js";
import { PostgresModerationRepository } from "./moderation/repository.js";
import type { ModerationMode } from "./moderation/routes.js";
import { PostgresSubmissionRepository } from "./submissions/repository.js";
import { createRpSigner } from "./identity/rp-signature.js";
import {
  HttpWorldIdVerifier,
  LocalSimulatedWorldIdVerifier,
  UnconfiguredWorldIdVerifier,
  type WorldIdEnvironment,
} from "./identity/world-id.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// Fails fast on partial, wrong-chain or non-official-USDC configuration.
const chainConfig = loadChainConfig(process.env);

if (chainConfig) {
  await verifyChainConnection(chainConfig);
}

const chainId =
  chainConfig?.chainId ?? Number(process.env.EVM_CHAIN_ID ?? 84532);

if (!Number.isSafeInteger(chainId) || chainId <= 0) {
  throw new Error("EVM_CHAIN_ID must be a positive safe integer");
}

const participantKeySecret = process.env.PARTICIPANT_KEY_SECRET || null;

if (participantKeySecret !== null && participantKeySecret.length < 32) {
  throw new Error("PARTICIPANT_KEY_SECRET must be at least 32 characters");
}

const worldIdEnvironment = (process.env.WORLD_ID_ENVIRONMENT ??
  "production") as WorldIdEnvironment;

if (!["production", "staging"].includes(worldIdEnvironment)) {
  throw new Error("WORLD_ID_ENVIRONMENT must be production or staging");
}

const worldIdRpId = process.env.WORLD_ID_RP_ID;
const worldIdMode = process.env.WORLD_ID_MODE ?? "live";

if (!["live", "simulated"].includes(worldIdMode)) {
  throw new Error("WORLD_ID_MODE must be live or simulated");
}

// Simulation proves nothing: the constructor throws unless the chain is the
// local anvil chain, so the API cannot start this way anywhere with value.
const worldIdVerifier =
  worldIdMode === "simulated"
    ? new LocalSimulatedWorldIdVerifier(chainId)
    : worldIdRpId
      ? new HttpWorldIdVerifier({
          rpId: worldIdRpId,
          environment: worldIdEnvironment,
        })
      : new UnconfiguredWorldIdVerifier();

// Optional bearer token for GET /metrics (scraper credential, not a secret
// worth a key manager, but keep it out of logs and the repository).
const metricsToken = process.env.METRICS_TOKEN || null;

if (metricsToken !== null && metricsToken.length < 16) {
  throw new Error("METRICS_TOKEN must be at least 16 characters");
}

// Moderation (#24). "review" is mandatory anywhere but the local anvil chain.
const moderationMode = (process.env.MODERATION_MODE ??
  "review") as ModerationMode;

if (!["review", "open"].includes(moderationMode)) {
  throw new Error("MODERATION_MODE must be review or open");
}

if (moderationMode === "open" && chainId !== 31337) {
  throw new Error("MODERATION_MODE=open is only allowed on the local chain");
}

const addressList = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .map((value) => {
      if (!/^0x[0-9a-f]{40}$/.test(value)) {
        throw new Error(`${name} must be comma-separated 0x addresses`);
      }
      return value;
    });

const operators = addressList("OPERATOR_ADDRESSES");
const advertiserAllowlist = addressList("ADVERTISER_ALLOWLIST");
const allowedContentDomains = process.env.CONTENT_DOMAIN_ALLOWLIST
  ? process.env.CONTENT_DOMAIN_ALLOWLIST.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  : null;

// Rate limits (#26), per API instance. Env overrides; all must be positive.
const positiveInt = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};
const rateLimits = {
  anonymousPerMinute: positiveInt(
    "RATE_LIMIT_ANONYMOUS_PER_MINUTE",
    DEFAULT_RATE_LIMITS.anonymousPerMinute,
  ),
  sensitivePerMinute: positiveInt(
    "RATE_LIMIT_SENSITIVE_PER_MINUTE",
    DEFAULT_RATE_LIMITS.sensitivePerMinute,
  ),
  defaultClientPerMinute: positiveInt(
    "RATE_LIMIT_CLIENT_DEFAULT_PER_MINUTE",
    DEFAULT_RATE_LIMITS.defaultClientPerMinute,
  ),
  maxClientPerMinute: positiveInt(
    "RATE_LIMIT_CLIENT_MAX_PER_MINUTE",
    DEFAULT_RATE_LIMITS.maxClientPerMinute,
  ),
};
// Number of trusted reverse-proxy hops in front of the API (0 = none), so
// per-IP limits see the client address rather than the proxy's.
const trustProxy = Number(process.env.TRUST_PROXY_HOPS ?? 0);

if (!Number.isSafeInteger(trustProxy) || trustProxy < 0) {
  throw new Error("TRUST_PROXY_HOPS must be a non-negative integer");
}

// IDKit RP signing (#12). Needs both the RP id and the server-only key.
const rpSigningKey = process.env.RP_SIGNING_KEY || null;
const worldIdRequest =
  worldIdMode === "live" && worldIdRpId && rpSigningKey
    ? {
        signer: createRpSigner(rpSigningKey),
        rpId: worldIdRpId,
        appId: process.env.WORLD_ID_APP_ID || null,
        environment: worldIdEnvironment,
      }
    : null;

const database = createDatabase(databaseUrl);
const campaignRepository = new PostgresCampaignRepository(database.db);
// Claim signer custody (#23). Production keys live in a KMS/HSM behind a
// signing service (CLAIM_SIGNER_URL); a plaintext key in the environment is
// accepted only on the local chain and Base Sepolia.
const LOCAL_KEY_CHAINS = new Set([31337, 84532]);
let claimSigner: ClaimSigner | null = null;

if (process.env.CLAIM_SIGNER_URL) {
  const remote = createRemoteClaimSigner({
    url: process.env.CLAIM_SIGNER_URL,
    address: process.env.CLAIM_SIGNER_ADDRESS ?? "",
    authorization: process.env.CLAIM_SIGNER_AUTHORIZATION || null,
  });
  // Fail fast if the service is down or does not hold the configured key.
  await remote.checkAvailable();
  claimSigner = remote;
} else if (process.env.CLAIM_SIGNER_PRIVATE_KEY) {
  if (!LOCAL_KEY_CHAINS.has(chainId)) {
    throw new Error(
      "CLAIM_SIGNER_PRIVATE_KEY is only allowed on chains 31337 and 84532; use CLAIM_SIGNER_URL",
    );
  }
  claimSigner = createClaimSigner(process.env.CLAIM_SIGNER_PRIVATE_KEY);
}

// Global 24 h liability circuit breaker. Default: 100 test USDC.
const dailyPayoutLimit = process.env.DAILY_PAYOUT_LIMIT_ATOMIC ?? "100000000";

if (!/^[1-9][0-9]{0,30}$/.test(dailyPayoutLimit)) {
  throw new Error("DAILY_PAYOUT_LIMIT_ATOMIC must be a positive integer");
}

// Sign-In with Ethereum (#37). Without SIWE_DOMAIN, sign-in is disabled and
// every advertiser-only endpoint returns 401 (fail closed).
const siweDomain = process.env.SIWE_DOMAIN || null;
// With an RPC, smart-contract wallets (ERC-1271/6492) can sign in too.
const publicClient = chainConfig
  ? createPublicClient({ transport: http(chainConfig.rpcUrl) })
  : null;

const app = buildApp({
  authRepository: new PostgresAuthRepository(database.db),
  siwe: siweDomain ? { domain: siweDomain, chainId } : null,
  verifySignature: publicClient
    ? (input) => publicClient.verifyMessage(input)
    : verifyEoaSignature,
  campaignRepository,
  eligibilityRepository: new PostgresEligibilityRepository(database.db),
  submissionRepository: new PostgresSubmissionRepository(database.db),
  claimRepository: new PostgresClaimRepository(database.db),
  claimSigner,
  dailyPayoutLimitAtomic: BigInt(dailyPayoutLimit),
  worldIdVerifier,
  worldIdRequest,
  participantKeySecret,
  chainId,
  metricsToken,
  apiClientRepository: new PostgresApiClientRepository(database.db),
  rateLimits,
  trustProxyHops: trustProxy,
  moderationRepository: new PostgresModerationRepository(database.db),
  moderation: { mode: moderationMode, operators, advertiserAllowlist },
  contentUrlPolicy: { allowedDomains: allowedContentDomains },
  chain: chainConfig
    ? {
        rpc: new JsonRpcClient(chainConfig.rpcUrl),
        // Links wait for the same depth the indexer treats as final.
        confirmations: Number(
          process.env.INDEXER_CONFIRMATIONS ?? DEFAULT_CONFIRMATIONS,
        ),
        chain: {
          chainId: chainConfig.chainId,
          contractAddress: chainConfig.campaignManagerAddress,
          usdcAddress: chainConfig.usdcAddress,
        },
        events: new PostgresChainEventRepository(database.db),
        now: () => new Date(),
      }
    : null,
  close: database.close,
});

if (moderationMode === "review" && operators.length === 0) {
  app.log.warn(
    "No OPERATOR_ADDRESSES: only allowlisted advertisers' campaigns can go live",
  );
}

if (!metricsToken) {
  app.log.warn("GET /metrics is unauthenticated: set METRICS_TOKEN");
}

if (!siweDomain) {
  app.log.warn("SIWE sign-in is disabled: set SIWE_DOMAIN");
}

if (worldIdMode === "simulated") {
  app.log.warn("WORLD_ID_MODE=simulated: local anvil demo only");
} else if (!worldIdRpId || !participantKeySecret) {
  app.log.warn(
    "World ID eligibility is disabled: set WORLD_ID_RP_ID and PARTICIPANT_KEY_SECRET",
  );
}

const port = Number(process.env.API_PORT ?? 3001);

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
