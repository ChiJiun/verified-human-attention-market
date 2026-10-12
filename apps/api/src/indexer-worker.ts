import { loadChainConfig } from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import { indexOnce, ReorgBeyondConfirmationsError } from "./chain/indexer.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { createDatabase } from "./db/client.js";

/**
 * Long-running chain indexer process (issue #17).
 * Usage: pnpm --filter @vham/api indexer
 */

const databaseUrl = process.env.DATABASE_URL;
const chainConfig = loadChainConfig(process.env);

if (!databaseUrl || !chainConfig) {
  throw new Error(
    "DATABASE_URL and the full chain configuration (EVM_RPC_URL, USDC_ADDRESS, CAMPAIGN_MANAGER_ADDRESS, CAMPAIGN_MANAGER_DEPLOY_BLOCK) are required",
  );
}

const confirmations = Number(process.env.INDEXER_CONFIRMATIONS ?? 10);
const pollMs = Number(process.env.INDEXER_POLL_MS ?? 5_000);
const maxBlockRange = BigInt(process.env.INDEXER_MAX_BLOCK_RANGE ?? 2_000);

if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
  throw new Error("INDEXER_CONFIRMATIONS must be a positive integer");
}

const database = createDatabase(databaseUrl);
const repository = new PostgresChainEventRepository(database.db);
const rpc = new JsonRpcClient(chainConfig.rpcUrl);
const config = {
  chainId: chainConfig.chainId,
  contractAddress: chainConfig.campaignManagerAddress,
  deployBlock: chainConfig.deployBlock,
  confirmations,
  maxBlockRange,
};

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const log = (level: "info" | "warn" | "error", message: string, extra = {}) =>
  console.log(
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg: message,
      ...extra,
    }),
  );

let backoffMs = pollMs;

while (!stopping) {
  try {
    const result = await indexOnce(rpc, repository, config);
    log("info", "indexer pass", {
      head: result.head.toString(),
      confirmedThrough: result.confirmedThrough.toString(),
      lagBlocks: (result.head - result.confirmedThrough).toString(),
      confirmedEvents: result.confirmedEvents,
      observedEvents: result.observedEvents,
      skippedLogs: result.skippedLogs,
    });
    backoffMs = pollMs;
  } catch (error) {
    if (error instanceof ReorgBeyondConfirmationsError) {
      // Do not guess: settlement data may be wrong. Requires an operator.
      log("error", error.message, { block: error.blockNumber.toString() });
      break;
    }

    log("warn", "indexer pass failed; retrying", {
      error: error instanceof Error ? error.message : String(error),
      retryInMs: backoffMs,
    });
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }

  await new Promise((resolve) => setTimeout(resolve, backoffMs));
}

await database.close();
