import {
  autoLinkCreatedCampaigns,
  syncCampaignStatuses,
} from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type { ChainEventRepository, ChainScope } from "./events-repository.js";
import { indexOnce, type IndexerConfig } from "./indexer.js";
import { verifyRecovery } from "./reorg-recovery.js";
import type { ChainRpc } from "./rpc.js";

export interface WorkerPassDependencies {
  rpc: ChainRpc;
  events: ChainEventRepository;
  campaigns: CampaignRepository;
  config: IndexerConfig;
  usdcAddress: string;
  now: () => Date;
}

/**
 * One indexer worker pass: index confirmed events, link canonical
 * creations, sync statuses, and, after `reorg:recover --apply`, clear the
 * halt only once the rebuilt index has caught up and every link verifies
 * (ADR-0011). Throws ReorgBeyondConfirmationsError like indexOnce.
 */
export async function runWorkerPass(dependencies: WorkerPassDependencies) {
  const scope: ChainScope = {
    chainId: dependencies.config.chainId,
    contractAddress: dependencies.config.contractAddress.toLowerCase(),
  };
  const index = await indexOnce(
    dependencies.rpc,
    dependencies.events,
    dependencies.config,
  );
  const autoLinked = await autoLinkCreatedCampaigns({
    campaigns: dependencies.campaigns,
    events: dependencies.events,
    rpc: dependencies.rpc,
    chain: { ...scope, usdcAddress: dependencies.usdcAddress },
    now: dependencies.now,
  });
  const statuses = await syncCampaignStatuses({
    campaigns: dependencies.campaigns,
    events: dependencies.events,
    chain: scope,
    now: dependencies.now,
  });

  let recovery: { cleared: true } | { cleared: false; reason: string } | null =
    null;
  const halt = await dependencies.events.getHalt(scope);

  if (halt?.recoveryAppliedAt) {
    const verdict = await verifyRecovery(
      {
        campaigns: dependencies.campaigns,
        rpc: dependencies.rpc,
        chain: scope,
        confirmations: dependencies.config.confirmations,
      },
      index,
    );
    if (verdict.ok) {
      await dependencies.events.clearHalt(scope);
      recovery = { cleared: true };
    } else {
      recovery = { cleared: false, reason: verdict.reason };
    }
  }

  return { index, autoLinked, statuses, recovery };
}

/**
 * Persists the halt for a reorg beyond the confirmation depth, retrying
 * until it succeeds or the worker is stopping. If the worker stops first,
 * its next start detects the same reorg again (the cursor hash still
 * mismatches) and records it then.
 */
export async function recordHaltWithRetry(
  events: Pick<ChainEventRepository, "haltForReorg">,
  scope: ChainScope,
  block: bigint,
  options: {
    now: () => Date;
    stopping: () => boolean;
    onFailure: (attempt: number, error: unknown) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; !options.stopping(); attempt += 1) {
    try {
      await events.haltForReorg(scope, block, options.now());
      return true;
    } catch (error) {
      options.onFailure(attempt, error);
      await sleep(Math.min(1_000 * attempt, 10_000));
    }
  }

  return false;
}
