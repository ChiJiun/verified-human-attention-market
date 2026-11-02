import { PostgresCampaignRepository } from "./campaigns/repository.js";
import {
  loadChainConfig,
  parseConfirmations,
  verifyChainConnection,
} from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import {
  applyReorgRecovery,
  planReorgRecovery,
} from "./chain/reorg-recovery.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { createDatabase } from "./db/client.js";

/**
 * Recovery after a reorg deeper than the confirmation depth (ADR-0011):
 *   pnpm --filter @vham/api reorg:recover            # dry run: print the plan
 *   pnpm --filter @vham/api reorg:recover -- --apply # release links, reset index
 * Stop the indexer worker first; restart it after --apply. The halt stays
 * until the worker has rebuilt the index and verified every link.
 */

const databaseUrl = process.env.DATABASE_URL;
const chainConfig = loadChainConfig(process.env);

if (!databaseUrl || !chainConfig) {
  throw new Error("DATABASE_URL and the full chain configuration are required");
}

await verifyChainConnection(chainConfig);

const apply = process.argv.includes("--apply");
const database = createDatabase(databaseUrl);

try {
  const chain = {
    chainId: chainConfig.chainId,
    contractAddress: chainConfig.campaignManagerAddress,
  };
  const dependencies = {
    campaigns: new PostgresCampaignRepository(database.db),
    events: new PostgresChainEventRepository(database.db),
    rpc: new JsonRpcClient(chainConfig.rpcUrl),
    chain,
    confirmations: parseConfirmations(process.env.INDEXER_CONFIRMATIONS),
  };
  const halt = await dependencies.events.getHalt(chain);
  const plan = await planReorgRecovery(dependencies);

  console.log(
    JSON.stringify(
      {
        halted: halt
          ? { block: halt.block.toString(), at: halt.at.toISOString() }
          : null,
        plan,
        mode: apply ? "apply" : "dry-run",
      },
      null,
      2,
    ),
  );

  if (apply) {
    // Recovering without a recorded halt (operator-initiated): record one so
    // the API refuses participation while the index is rebuilt.
    if (!halt) {
      await dependencies.events.haltForReorg(
        chain,
        BigInt(plan.confirmedBlock),
        new Date(),
      );
    }
    const result = await applyReorgRecovery(
      { ...dependencies, now: () => new Date() },
      plan,
    );
    console.log(
      JSON.stringify(
        {
          ...result,
          next: "Restart the indexer worker. It rebuilds the index from the deploy block and clears the halt only after every link verifies; participation stays halted until then.",
        },
        null,
        2,
      ),
    );
  }
} finally {
  await database.close();
}
