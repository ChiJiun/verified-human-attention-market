import {
  autoLinkCreatedCampaigns,
  syncCampaignStatuses,
} from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type {
  ChainEventRepository,
  ChainHalt,
  ChainScope,
} from "./events-repository.js";
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
 * The deployment is halted and `reorg:recover --apply` has not run (again):
 * the pass did nothing. The worker stops for the operator (ADR-0011).
 */
export class ChainHaltedError extends Error {
  constructor(readonly halt: ChainHalt) {
    super(
      `Deployment halted by a reorg beyond the confirmation depth at block ${halt.block}; recovery not applied`,
    );
    this.name = "ChainHaltedError";
  }
}

/**
 * One indexer worker pass: index confirmed events, link canonical
 * creations, sync statuses, and, after `reorg:recover --apply`, clear the
 * halt only once the rebuilt index has caught up and every link verifies
 * (ADR-0011). Throws ReorgBeyondConfirmationsError like indexOnce.
 *
 * The halt is read first and decides the whole pass (#77): without one the
 * pass never clears a halt that appears meanwhile, a halt without recovery
 * stops the pass before it writes (ChainHaltedError), and a rebuild clears
 * only the halt it started with, if that is still unchanged.
 */
export async function runWorkerPass(dependencies: WorkerPassDependencies) {
  const scope: ChainScope = {
    chainId: dependencies.config.chainId,
    contractAddress: dependencies.config.contractAddress.toLowerCase(),
  };
  const halt = await dependencies.events.getHalt(scope);

  if (halt && !halt.recoveryAppliedAt) {
    throw new ChainHaltedError(halt);
  }

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

  if (halt?.recoveryAppliedAt) {
    const verdict = await verifyRecovery(
      {
        campaigns: dependencies.campaigns,
        events: dependencies.events,
        rpc: dependencies.rpc,
        chain: scope,
        confirmations: dependencies.config.confirmations,
      },
      index,
    );
    if (!verdict.ok) {
      recovery = { cleared: false, reason: verdict.reason };
    } else if (
      await dependencies.events.clearHalt(scope, {
        recoveryAppliedAt: halt.recoveryAppliedAt,
        indexedThrough: verdict.indexedThrough,
      })
    ) {
      recovery = { cleared: true };
    } else {
      recovery = {
        cleared: false,
        reason:
          "recovery was applied again or the index was reset during the pass",
      };
    }
  }

  return { index, autoLinked, statuses, recovery };
}

/**
 * Runs `attempt` until it succeeds, waiting `delayMs(attempt)` between
 * tries (capped exponential by default) while `retryable(error)` holds;
 * any other error is thrown at once. Returns null if the worker is
 * stopping first.
 */
export async function retryWithBackoff<T>(
  attempt: () => Promise<T>,
  options: {
    retryable: (error: unknown) => boolean;
    stopping: () => boolean;
    onFailure: (attempt: number, error: unknown, retryInMs: number) => void;
    delayMs?: (attempt: number) => number;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  },
): Promise<T | null> {
  const delayMs =
    options.delayMs ??
    ((count: number) => Math.min(1_000 * 2 ** (count - 1), 60_000));
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let count = 1; !options.stopping(); count += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!options.retryable(error)) throw error;
      options.onFailure(count, error, delayMs(count));
      await sleep(delayMs(count));
    }
  }

  return null;
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
  const recorded = await retryWithBackoff(
    async () => {
      await events.haltForReorg(scope, block, options.now());
      return true;
    },
    {
      retryable: () => true,
      stopping: options.stopping,
      onFailure: (attempt, error) => options.onFailure(attempt, error),
      delayMs: (attempt) => Math.min(1_000 * attempt, 10_000),
      sleep: options.sleep,
    },
  );

  return recorded ?? false;
}
