import { createServer } from "node:http";

import { PostgresCampaignRepository } from "./campaigns/repository.js";
import {
  loadChainConfig,
  parseConfirmations,
  RpcUnavailableError,
  verifyChainConnection,
} from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import {
  InconsistentChainReadError,
  ReorgBeyondConfirmationsError,
} from "./chain/indexer.js";
import {
  ChainHaltedError,
  recordHaltWithRetry,
  retryWithBackoff,
  runWorkerPass,
  sleepUntilAborted,
} from "./chain/worker-pass.js";
import { JsonRpcClient } from "./chain/rpc.js";
import { createDatabase } from "./db/client.js";
import { MetricsRegistry } from "./observability/metrics.js";
import { applyRetention } from "./privacy/retention.js";
import { PostgresClaimRepository } from "./claims/repository.js";
import { checkReconciliation } from "./reconciliation/check.js";

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

// SIGTERM also cuts every backoff sleep short, so the worker stops within
// an orchestrator's grace period (e.g. 30 s) after the current pass.
let stopping = false;
const stopped = new AbortController();
const stop = () => {
  stopping = true;
  stopped.abort();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const sleep = sleepUntilAborted(stopped.signal);

const log = (level: "info" | "warn" | "error", message: string, extra = {}) =>
  console.log(
    JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg: message,
      ...extra,
    }),
  );

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Same fail-fast checks as the API: chain, code, and an ADR-0011 contract.
// An unreachable or failing RPC is retried with backoff (up to 60 s apart)
// instead of crash-looping; a wrong chain, missing code or an old contract
// still stops the worker at once.
const verified = await retryWithBackoff(
  async () => {
    await verifyChainConnection(chainConfig);
    return true;
  },
  {
    retryable: (error) => error instanceof RpcUnavailableError,
    stopping: () => stopping,
    sleep,
    onFailure: (attempt, error, retryInMs) =>
      log("warn", "startup chain check failed; retrying", {
        attempt,
        error: errorMessage(error),
        retryInMs,
      }),
  },
);

if (verified === null) {
  process.exit(0);
}

const confirmations = parseConfirmations(process.env.INDEXER_CONFIRMATIONS);
const pollMs = Number(process.env.INDEXER_POLL_MS ?? 5_000);
const maxBlockRange = BigInt(process.env.INDEXER_MAX_BLOCK_RANGE ?? 2_000);

const database = createDatabase(databaseUrl);
const repository = new PostgresChainEventRepository(database.db);
const campaigns = new PostgresCampaignRepository(database.db);
const scope = {
  chainId: chainConfig.chainId,
  contractAddress: chainConfig.campaignManagerAddress,
};
const now = () => new Date();
const config = {
  chainId: chainConfig.chainId,
  contractAddress: chainConfig.campaignManagerAddress,
  deployBlock: chainConfig.deployBlock,
  confirmations,
  maxBlockRange,
};

// Prometheus metrics for the worker (#21). Optional: INDEXER_METRICS_PORT.
const metrics = new MetricsRegistry();
const gauges = {
  head: metrics.gauge("vham_indexer_head_block", "Chain head at the last pass"),
  confirmed: metrics.gauge(
    "vham_indexer_confirmed_block",
    "Latest confirmed block indexed",
  ),
  lag: metrics.gauge("vham_indexer_lag_blocks", "Head minus confirmed block"),
  lastSuccess: metrics.gauge(
    "vham_indexer_last_success_timestamp_seconds",
    "Unix time of the last successful pass",
  ),
  violations: metrics.gauge(
    "vham_reconciliation_accounting_violations",
    "Campaigns whose paid + refunded exceeds funded (must be 0)",
  ),
  ambiguous: metrics.gauge(
    "vham_reconciliation_ambiguous_campaigns",
    "On-chain campaigns that need manual linking",
  ),
  // Each such pass commits nothing past the failing range while the API
  // keeps accepting participation, so a run of them must be visible.
  inconsistentStreak: metrics.gauge(
    "vham_indexer_inconsistent_read_streak",
    "Consecutive passes that ended in an inconsistent chain read",
  ),
};
const passes = metrics.counter(
  "vham_indexer_passes_total",
  "Indexer passes by result",
);
// Every RPC request of the worker by method, failed passes included: what
// a pass costs, e.g. one eth_getBlockReceipts per block whose logsBloom may
// hold an event (#102).
const rpcRequests = metrics.counter(
  "vham_indexer_rpc_requests_total",
  "RPC requests made by the indexer worker, by method",
);
const rpc = new JsonRpcClient(chainConfig.rpcUrl, fetch, undefined, (method) =>
  rpcRequests.inc({ method }),
);
const metricsPort = process.env.INDEXER_METRICS_PORT
  ? Number(process.env.INDEXER_METRICS_PORT)
  : null;

if (
  metricsPort !== null &&
  (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65_535)
) {
  throw new Error("INDEXER_METRICS_PORT must be a TCP port");
}

const metricsServer =
  metricsPort === null
    ? null
    : createServer((request, response) => {
        if (request.url !== "/metrics") {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
          })
          .end(metrics.render());
      }).listen(metricsPort, "0.0.0.0");

// Retention (#22) piggybacks on the worker; 0 disables (then schedule
// `pnpm --filter @vham/api retention` instead).
const retentionIntervalMs = Number(
  process.env.RETENTION_INTERVAL_MS ?? 60 * 60_000,
);

if (!Number.isSafeInteger(retentionIntervalMs) || retentionIntervalMs < 0) {
  throw new Error("RETENTION_INTERVAL_MS must be a non-negative integer");
}

let lastRetentionAt = 0;

// Settlement reconciliation (#29): contract ↔ events ↔ authorizations.
const reconciliationIntervalMs = Number(
  process.env.RECONCILIATION_INTERVAL_MS ?? 10 * 60_000,
);

if (
  !Number.isSafeInteger(reconciliationIntervalMs) ||
  reconciliationIntervalMs < 0
) {
  throw new Error("RECONCILIATION_INTERVAL_MS must be a non-negative integer");
}

const claims = new PostgresClaimRepository(database.db);
const findingsGauge = metrics.gauge(
  "vham_reconciliation_findings",
  "Open reconciliation findings by kind (must be 0)",
);
const FINDING_KINDS = [
  "INDEX_MISMATCH",
  "ACCOUNTING_VIOLATION",
  "UNBACKED_PAYOUT",
  "CHAIN_READ_FAILED",
] as const;
let lastReconciliationAt = 0;

const RECOVERY_ACTION =
  "Run `pnpm --filter @vham/api reorg:recover:start` (dry run), then with `-- --apply`, then restart this worker (RUNBOOK: VhamReorgBeyondConfirmations).";

// A recorded deep reorg must be recovered first (ADR-0011). After
// `reorg:recover --apply` the worker rebuilds; the halt stays until verified.
const existingHalt = await repository.getHalt(scope);
if (existingHalt?.recoveryAppliedAt) {
  log("warn", "rebuilding the index after reorg recovery", {
    block: existingHalt.block.toString(),
    note: "Participation stays halted until the rebuilt index and every link verify.",
  });
} else if (existingHalt) {
  log("error", "indexer halted by a reorg beyond the confirmation depth", {
    block: existingHalt.block.toString(),
    since: existingHalt.at.toISOString(),
    action: RECOVERY_ACTION,
  });
  process.exit(1);
}

// One worker per deployment, never next to `reorg:recover --apply` (#77).
// Held until this process ends; a second worker waits for it. Needs a direct
// or session-mode database connection (RUNBOOK: Running the built API).
const lock = await retryWithBackoff(
  async () => {
    const held = await repository.lockDeployment(scope);
    if (!held) {
      throw new Error(
        "another indexer worker or `reorg:recover --apply` holds this deployment",
      );
    }
    return held;
  },
  {
    retryable: () => true,
    stopping: () => stopping,
    sleep,
    onFailure: (attempt, error, retryInMs) =>
      log("warn", "waiting for the deployment lock", {
        attempt,
        error: errorMessage(error),
        retryInMs,
      }),
  },
);

let backoffMs = pollMs;
let inconsistentStreak = 0;

while (!stopping) {
  // The lock lives only as long as its database session. If that session
  // ended (restart, failover, network, idle_session_timeout), the server
  // released it and `--apply` could run beside this worker: stop, so the
  // supervisor starts a worker that takes it again. The fencing keeps a
  // pass that was already running correct. A check that fails (database
  // unreachable) counts as lost.
  const lockCheck = lock
    ? await lock.isHeld().then(
        (held) => (held ? null : "not held"),
        (error: unknown) => errorMessage(error),
      )
    : null;
  if (lockCheck !== null) {
    passes.inc({ result: "lock_lost" });
    log("error", "deployment lock lost; stopping", {
      reason: lockCheck,
      action:
        "Restart the worker. If this repeats, check that DATABASE_URL is a direct or session-mode connection and idle_session_timeout.",
    });
    process.exitCode = 1;
    break;
  }

  try {
    const pass = await runWorkerPass({
      rpc,
      events: repository,
      campaigns,
      config,
      usdcAddress: chainConfig.usdcAddress,
      now,
    });
    const { index: result, autoLinked, statuses, recovery } = pass;
    gauges.head.set(Number(result.head));
    gauges.confirmed.set(Number(result.confirmedThrough));
    gauges.lag.set(Number(result.head - result.confirmedThrough));
    log("info", "indexer pass", {
      head: result.head.toString(),
      confirmedThrough: result.confirmedThrough.toString(),
      lagBlocks: (result.head - result.confirmedThrough).toString(),
      confirmedEvents: result.confirmedEvents,
      observedEvents: result.observedEvents,
      skippedLogs: result.skippedLogs,
      receiptQueries: result.receiptQueries,
    });

    if (autoLinked.linked.length > 0 || statuses.updated.length > 0) {
      log("info", "campaigns reconciled", {
        autoLinked: autoLinked.linked,
        statusChanges: statuses.updated,
      });
    }

    // ADR-0011: a link whose canonical creation names another draft was
    // left behind by a reorg deeper than its confirmation; it is released.
    if (autoLinked.relinked.length > 0 || statuses.orphanedLinks.length > 0) {
      log("warn", "orphaned on-chain links released or skipped", {
        releasedCampaignIds: autoLinked.relinked,
        orphanedCampaignIds: statuses.orphanedLinks,
      });
    }

    // ADR-0011: after `reorg:recover --apply` the halt is cleared only once
    // the rebuilt index has caught up and every link verifies.
    if (recovery?.cleared) {
      log("info", "reorg recovery verified; participation resumes");
    } else if (recovery) {
      log(
        "warn",
        "reorg recovery not verified yet; participation stays halted",
        {
          reason: recovery.reason,
        },
      );
    }

    if (autoLinked.ambiguous.length > 0) {
      log("warn", "ambiguous on-chain campaigns need manual linking", {
        onchainCampaignIds: autoLinked.ambiguous,
      });
    }

    gauges.violations.set(statuses.accountingViolations.length);
    gauges.ambiguous.set(autoLinked.ambiguous.length);
    gauges.lastSuccess.set(Math.floor(Date.now() / 1000));
    gauges.inconsistentStreak.set(0);
    inconsistentStreak = 0;
    passes.inc({ result: "success" });

    if (statuses.accountingViolations.length > 0) {
      log("error", "ACCOUNTING VIOLATION: paid + refunded exceeds funded", {
        campaignIds: statuses.accountingViolations,
      });
    }

    if (
      reconciliationIntervalMs > 0 &&
      Date.now() - lastReconciliationAt >= reconciliationIntervalMs
    ) {
      lastReconciliationAt = Date.now();
      const report = await checkReconciliation({
        campaigns,
        events: repository,
        claims,
        rpc,
        chain: scope,
      });
      for (const kind of FINDING_KINDS) {
        findingsGauge.set(
          report.findings.filter((finding) => finding.kind === kind).length,
          { kind },
        );
      }
      log(
        report.findings.length > 0 ? "error" : "info",
        report.findings.length > 0
          ? "RECONCILIATION MISMATCH"
          : "reconciliation clean",
        { ...report },
      );
    }

    if (
      retentionIntervalMs > 0 &&
      Date.now() - lastRetentionAt >= retentionIntervalMs
    ) {
      lastRetentionAt = Date.now();
      try {
        log("info", "retention applied", {
          ...(await applyRetention(database.db, new Date())),
        });
      } catch (error) {
        log("error", "retention failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    backoffMs = pollMs;
  } catch (error) {
    passes.inc({
      result:
        error instanceof ReorgBeyondConfirmationsError
          ? "reorg_beyond_confirmations"
          : error instanceof ChainHaltedError
            ? "halted"
            : error instanceof InconsistentChainReadError
              ? "inconsistent_read"
              : "failure",
    });

    if (error instanceof ChainHaltedError) {
      // A halt without recovery appeared after this worker started: a
      // `--apply` stopped after recording the halt again but before marking
      // it applied (while this worker waited for the lock), or the lock was
      // lost. The pass wrote nothing.
      log("error", "indexer halted by a reorg beyond the confirmation depth", {
        block: error.halt.block.toString(),
        since: error.halt.at.toISOString(),
        action: RECOVERY_ACTION,
      });
      break;
    }

    if (error instanceof ReorgBeyondConfirmationsError) {
      // Do not guess: settlement data may be wrong. Record the halt so the
      // API stops all participation and signing for this deployment, then
      // stop. Requires an operator (ADR-0011).
      // The halt must be persisted: retry until it is. If the worker is
      // stopped first, the next start detects the same reorg again.
      await recordHaltWithRetry(repository, scope, error.blockNumber, {
        now: () => new Date(),
        stopping: () => stopping,
        sleep,
        onFailure: (attempt, haltError) =>
          log(
            "error",
            "COULD NOT RECORD THE REORG HALT; retrying. The API is NOT paused until this succeeds",
            {
              attempt,
              error:
                haltError instanceof Error
                  ? haltError.message
                  : String(haltError),
            },
          ),
      });
      log("error", error.message, {
        block: error.blockNumber.toString(),
        action: `Participation is halted. ${RECOVERY_ACTION}`,
      });
      break;
    }

    // The RPC answered one range from different forks or nodes, left events
    // out (#102), or the chain moved while reading it. Nothing was written;
    // transient unless it keeps happening, which VhamIndexerInconsistentReads
    // reports.
    if (error instanceof InconsistentChainReadError) {
      inconsistentStreak += 1;
      gauges.inconsistentStreak.set(inconsistentStreak);
    }

    // IndexCursorMovedError lands here too: the index was reset under this
    // pass; nothing was written, and the next pass reads the halt again.
    log("warn", "indexer pass failed; retrying", {
      error: errorMessage(error),
      retryInMs: backoffMs,
      ...(error instanceof InconsistentChainReadError && {
        block: error.blockNumber.toString(),
        ...(error.reason && { reason: error.reason }),
        inconsistentStreak,
      }),
    });
    backoffMs = Math.min(backoffMs * 2, 60_000);
  }

  await sleep(backoffMs);
}

await lock?.release();
metricsServer?.close();
await database.close();
