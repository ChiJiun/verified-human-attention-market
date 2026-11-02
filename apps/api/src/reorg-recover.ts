import { PostgresCampaignRepository } from "./campaigns/repository.js";
import {
  loadChainConfig,
  parseConfirmations,
  verifyChainConnection,
} from "./chain/config.js";
import type { ChainHalt } from "./chain/events-repository.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import { runReorgRecovery } from "./chain/reorg-recovery.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { createDatabase } from "./db/client.js";

/**
 * Recovery after a reorg deeper than the confirmation depth (ADR-0011):
 *   pnpm --filter @vham/api reorg:recover:start            # dry run: print the plan
 *   pnpm --filter @vham/api reorg:recover:start -- --apply # release links, reset index
 * (`reorg:recover` runs the same from source with tsx, a dev dependency.)
 * Stop the indexer worker first: --apply refuses while a worker holds the
 * deployment. Restart the worker after --apply; the halt stays until it has
 * rebuilt the index and verified every link.
 */

const databaseUrl = process.env.DATABASE_URL;
const chainConfig = loadChainConfig(process.env);

if (!databaseUrl || !chainConfig) {
  throw new Error("DATABASE_URL and the full chain configuration are required");
}

await verifyChainConnection(chainConfig);

const apply = process.argv.includes("--apply");
const database = createDatabase(databaseUrl);

const haltJson = (halt: ChainHalt | null) =>
  halt
    ? {
        block: halt.block.toString(),
        at: halt.at.toISOString(),
        recoveryAppliedAt: halt.recoveryAppliedAt?.toISOString() ?? null,
      }
    : null;

try {
  const run = await runReorgRecovery(
    {
      campaigns: new PostgresCampaignRepository(database.db),
      events: new PostgresChainEventRepository(database.db),
      rpc: new JsonRpcClient(chainConfig.rpcUrl),
      chain: {
        chainId: chainConfig.chainId,
        contractAddress: chainConfig.campaignManagerAddress,
      },
      confirmations: parseConfirmations(process.env.INDEXER_CONFIRMATIONS),
      now: () => new Date(),
    },
    { apply },
  );

  switch (run.mode) {
    case "refused":
      console.error(JSON.stringify({ mode: "refused", reason: run.reason }));
      process.exitCode = 1;
      break;
    case "dry-run":
      console.log(
        JSON.stringify(
          {
            mode: run.mode,
            halted: haltJson(run.halted),
            plan: run.plan,
            ...(run.deploymentLocked && {
              warning:
                "An indexer worker (or another --apply) holds this deployment; --apply would refuse until it stops.",
            }),
          },
          null,
          2,
        ),
      );
      break;
    case "apply":
      console.log(
        JSON.stringify(
          {
            mode: run.mode,
            halted: haltJson(run.halted),
            plan: run.plan,
            released: run.released,
            next: "Restart the indexer worker. It rebuilds the index from the deploy block and clears the halt only after the index has caught up and every link verifies; participation stays halted until then.",
          },
          null,
          2,
        ),
      );
      break;
  }
} finally {
  await database.close();
}
