import {
  autoLinkCreatedCampaigns,
  syncCampaignStatuses,
} from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type {
  ChainEventRepository,
  ChainHalt,
  ChainScope,
  DeploymentLock,
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
 * A sleep that ends early once `signal` aborts, so SIGTERM stops the worker
 * within the orchestrator's grace period instead of after a 60 s backoff.
 */
export function sleepUntilAborted(signal: AbortSignal) {
  return (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    });
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

/** One error's own text: its message, or what else names it. */
function ownMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message) return error.message;
  // Node reports a connection refused on every address as an AggregateError
  // with an empty message.
  const inner =
    error instanceof AggregateError
      ? error.errors.map(ownMessage).join("; ")
      : "";
  const code = (error as { code?: unknown }).code;
  return inner || (typeof code === "string" ? code : error.name);
}

/**
 * An error's message followed by its causes, for the worker's logs. Drizzle
 * reports a failed query as `Failed query: <SQL>` and keeps the reason
 * (connection refused, wrong password, missing table) in `cause`, so the
 * message alone does not say why.
 */
export function errorMessage(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    parts.push(ownMessage(current));
    if (parts.length === 5 || !(current instanceof Error)) break;
    current = current.cause;
  }
  return parts.join("; cause: ");
}

/**
 * Reads the deployment's halt when the worker starts, retrying a database
 * failure with backoff like the deployment lock instead of exiting (which
 * would crash-loop under a supervisor). The halt, or null for none, comes
 * wrapped; null if the worker is stopping first.
 */
export async function readHaltWithRetry(
  events: Pick<ChainEventRepository, "getHalt">,
  scope: ChainScope,
  options: {
    stopping: () => boolean;
    onFailure: (attempt: number, error: unknown, retryInMs: number) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ halt: ChainHalt | null } | null> {
  return retryWithBackoff(async () => ({ halt: await events.getHalt(scope) }), {
    retryable: () => true,
    stopping: options.stopping,
    onFailure: options.onFailure,
    sleep: options.sleep,
  });
}

/** Another session holds the deployment lock (the worker waits for it). */
export const DEPLOYMENT_LOCK_HELD =
  "another indexer worker or `reorg:recover --apply` holds this deployment";

/**
 * Waits for the deployment lock (#77): one worker per deployment, never next
 * to `reorg:recover --apply`. Every failure is retried, a database error as
 * well as a lock that another session holds (DEPLOYMENT_LOCK_HELD). Once the
 * lock is held, `onLocked` starts the stall clock: a worker waiting for the
 * lock is not stalled, another one runs. A worker that is stopping gets no
 * `onLocked`: null if it stopped while waiting, or the lock, for it to
 * release, if the lock came just as it stopped.
 */
export async function takeDeploymentLock(
  events: Pick<ChainEventRepository, "lockDeployment">,
  scope: ChainScope,
  options: {
    stopping: () => boolean;
    onWaiting: (attempt: number, error: unknown, retryInMs: number) => void;
    onLocked: () => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DeploymentLock | null> {
  const lock = await retryWithBackoff(
    async () => {
      const held = await events.lockDeployment(scope);
      if (!held) throw new Error(DEPLOYMENT_LOCK_HELD);
      return held;
    },
    {
      retryable: () => true,
      stopping: options.stopping,
      onFailure: options.onWaiting,
      sleep: options.sleep,
    },
  );

  if (lock && !options.stopping()) options.onLocked();
  return lock;
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
