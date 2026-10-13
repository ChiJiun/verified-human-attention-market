import { createPublicClient, http } from "viem";

import { PostgresAuthRepository } from "./auth/repository.js";
import { verifyEoaSignature } from "./auth/siwe.js";
import { PostgresCampaignRepository } from "./campaigns/repository.js";
import { PostgresClaimRepository } from "./claims/repository.js";
import { createClaimSigner } from "./claims/signer.js";
import { buildApp } from "./app.js";
import { loadChainConfig, verifyChainConnection } from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { createDatabase } from "./db/client.js";
import { PostgresEligibilityRepository } from "./eligibility/repository.js";
import { PostgresSubmissionRepository } from "./submissions/repository.js";
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

const database = createDatabase(databaseUrl);
const campaignRepository = new PostgresCampaignRepository(database.db);
const claimSigner = process.env.CLAIM_SIGNER_PRIVATE_KEY
  ? createClaimSigner(process.env.CLAIM_SIGNER_PRIVATE_KEY)
  : null;

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
  worldIdVerifier,
  participantKeySecret,
  chainId,
  metricsToken,
  chain: chainConfig
    ? {
        rpc: new JsonRpcClient(chainConfig.rpcUrl),
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
