import { createServer } from "node:http";

import { PostgresCampaignRepository } from "./campaigns/repository.js";
import {
  autoLinkCreatedCampaigns,
  syncCampaignStatuses,
} from "./campaigns/onchain.js";
import { loadChainConfig, verifyChainConnection } from "./chain/config.js";
import { PostgresChainEventRepository } from "./chain/events-repository.postgres.js";
import { indexOnce, ReorgBeyondConfirmationsError } from "./chain/indexer.js";
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

// Same fail-fast checks as the API: chain, code, and an ADR-0011 contract.
await verifyChainConnection(chainConfig);

const confirmations = Number(process.env.INDEXER_CONFIRMATIONS ?? 10);
const pollMs = Number(process.env.INDEXER_POLL_MS ?? 5_000);
const maxBlockRange = BigInt(process.env.INDEXER_MAX_BLOCK_RANGE ?? 2_000);

if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
  throw new Error("INDEXER_CONFIRMATIONS must be a positive integer");
}

const database = createDatabase(databaseUrl);
const repository = new PostgresChainEventRepository(database.db);
const rpc = new JsonRpcClient(chainConfig.rpcUrl);
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
};
const passes = metrics.counter(
  "vham_indexer_passes_total",
  "Indexer passes by result",
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
    });

    // Reconcile campaigns from confirmed events (issue #16).
    const autoLinked = await autoLinkCreatedCampaigns({
      campaigns,
      events: repository,
      rpc,
      chain: { ...scope, usdcAddress: chainConfig.usdcAddress },
      now,
    });
    const statuses = await syncCampaignStatuses({
      campaigns,
      events: repository,
      chain: scope,
      now,
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

    if (autoLinked.ambiguous.length > 0) {
      log("warn", "ambiguous on-chain campaigns need manual linking", {
        onchainCampaignIds: autoLinked.ambiguous,
      });
    }

    gauges.violations.set(statuses.accountingViolations.length);
    gauges.ambiguous.set(autoLinked.ambiguous.length);
    gauges.lastSuccess.set(Math.floor(Date.now() / 1000));
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
          : "failure",
    });

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

metricsServer?.close();
await database.close();
