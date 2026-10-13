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
const worldIdVerifier = worldIdRpId
  ? new HttpWorldIdVerifier({
      rpId: worldIdRpId,
      environment: worldIdEnvironment,
    })
  : new UnconfiguredWorldIdVerifier();

const database = createDatabase(databaseUrl);
const campaignRepository = new PostgresCampaignRepository(database.db);
const claimSigner = process.env.CLAIM_SIGNER_PRIVATE_KEY
  ? createClaimSigner(process.env.CLAIM_SIGNER_PRIVATE_KEY)
  : null;

const app = buildApp({
  campaignRepository,
  eligibilityRepository: new PostgresEligibilityRepository(database.db),
  submissionRepository: new PostgresSubmissionRepository(database.db),
  claimRepository: new PostgresClaimRepository(database.db),
  claimSigner,
  worldIdVerifier,
  participantKeySecret,
  chainId,
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

if (!worldIdRpId || !participantKeySecret) {
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
