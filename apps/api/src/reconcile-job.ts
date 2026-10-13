import { PostgresCampaignRepository } from "./campaigns/repository.js";
import { loadChainConfig } from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { PostgresClaimRepository } from "./claims/repository.js";
import { createDatabase } from "./db/client.js";
import { checkReconciliation } from "./reconciliation/check.js";

/**
 * One-shot settlement reconciliation (#29):
 *   pnpm --filter @vham/api reconcile
 * Exits 1 when any finding exists, so it can gate a deploy or a cron alert.
 */

const databaseUrl = process.env.DATABASE_URL;
const chainConfig = loadChainConfig(process.env);

if (!databaseUrl || !chainConfig) {
  throw new Error("DATABASE_URL and the full chain configuration are required");
}

const database = createDatabase(databaseUrl);

try {
  const report = await checkReconciliation({
    campaigns: new PostgresCampaignRepository(database.db),
    events: new PostgresChainEventRepository(database.db),
    claims: new PostgresClaimRepository(database.db),
    rpc: new JsonRpcClient(chainConfig.rpcUrl),
    chain: {
      chainId: chainConfig.chainId,
      contractAddress: chainConfig.campaignManagerAddress,
    },
  });

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.findings.length > 0 ? 1 : 0;
} finally {
  await database.close();
}
