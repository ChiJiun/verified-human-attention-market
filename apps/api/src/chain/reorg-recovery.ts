import {
  draftRefFor,
  matchesDraft,
  readCampaignIdByDraft,
  readOnchainCampaign,
} from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import { indexMismatches } from "../reconciliation/check.js";
import { reconcileCampaignEvents } from "./campaign-state.js";
import type {
  ChainEventRepository,
  ChainHalt,
  ChainScope,
} from "./events-repository.js";
import type { ChainRpc } from "./rpc.js";

/**
 * Recovery after a reorg deeper than the confirmation depth (ADR-0011).
 *
 * 1. The indexer worker records a halt and stops; the API refuses all
 *    participation and signing for the deployment.
 * 2. `pnpm --filter @vham/api reorg:recover` prints a plan; `-- --apply`
 *    releases links that are no longer canonical, drops the index and marks
 *    the halt "recovery applied". The halt stays. `--apply` holds the
 *    deployment lock, so it refuses to run next to an indexer worker.
 * 3. The restarted worker rebuilds the index from the deploy block, links
 *    canonical creations and re-syncs statuses. Only when the stored index
 *    has caught up and {@link verifyRecovery} finds every link canonical and
 *    indexed like the contract does it clear the halt; until then the API
 *    keeps refusing participation.
 *
 * Should the lock be lost (its session dropped), the order still holds: a
 * worker pass acts only on the halt it read first, index writes name the
 * cursor they extend (a reset index refuses them), and the halt is cleared
 * only while its `recoveryAppliedAt` is the one the worker rebuilt for and
 * the cursor still reaches the block it verified (#77).
 */

export type ReleaseReason =
  /** The draft has no creation on the canonical chain any more. */
  | "creation_missing"
  /** The draft's canonical creation has another id. */
  | "id_changed"
  /** Same id, but reward, completions or window differ from the draft. */
  | "parameters_changed";

export interface ReorgRecoveryPlan {
  /** Block the canonical check was made at (head minus confirmations). */
  confirmedBlock: string;
  keep: { campaignId: string; onchainCampaignId: string }[];
  release: {
    campaignId: string;
    onchainCampaignId: string;
    /** This draft's id on the canonical chain, or null if none. */
    canonicalOnchainCampaignId: string | null;
    reason: ReleaseReason;
  }[];
}

export interface ReorgRecoveryDependencies {
  campaigns: CampaignRepository;
  events: ChainEventRepository;
  rpc: ChainRpc;
  chain: ChainScope;
  confirmations: number;
}

/**
 * Checks every link of the deployment against the contract at the confirmed
 * head: the draft's `campaignIdByDraft` must equal the linked id and the
 * on-chain creation parameters must equal the draft's.
 */
export async function planReorgRecovery(
  dependencies: Omit<ReorgRecoveryDependencies, "events">,
): Promise<ReorgRecoveryPlan> {
  const head = await dependencies.rpc.blockNumber();
  const confirmed = head - BigInt(dependencies.confirmations);
  const confirmedBlock = confirmed < 0n ? 0n : confirmed;
  const plan: ReorgRecoveryPlan = {
    confirmedBlock: confirmedBlock.toString(),
    keep: [],
    release: [],
  };

  for (const campaign of await dependencies.campaigns.listLinked(
    dependencies.chain.chainId,
    dependencies.chain.contractAddress,
  )) {
    const linkedId = campaign.onchainCampaignId!;
    const canonical = await readCampaignIdByDraft(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      campaign.advertiserAddress,
      draftRefFor(campaign.id),
      confirmedBlock,
    );

    let reason: ReleaseReason | null = null;

    if (canonical === null) {
      reason = "creation_missing";
    } else if (canonical !== linkedId) {
      reason = "id_changed";
    } else {
      const onchain = await readOnchainCampaign(
        dependencies.rpc,
        dependencies.chain.contractAddress,
        linkedId,
        confirmedBlock,
      );
      if (!onchain || !matchesDraft(campaign, onchain)) {
        reason = "parameters_changed";
      }
    }

    if (reason === null) {
      plan.keep.push({ campaignId: campaign.id, onchainCampaignId: linkedId });
    } else {
      plan.release.push({
        campaignId: campaign.id,
        onchainCampaignId: linkedId,
        canonicalOnchainCampaignId: canonical,
        reason,
      });
    }
  }

  return plan;
}

/**
 * Releases the plan's stale links, drops the index and marks the halt as
 * recovery-applied. The halt is NOT cleared here (see module comment).
 *
 * The halt is recorded again first (keeping its block and time, or at the
 * plan's block when the operator starts recovery without one): the API
 * refuses participation before any link is released, and a worker that
 * verified an earlier application can no longer clear it.
 */
export async function applyReorgRecovery(
  dependencies: ReorgRecoveryDependencies & { now: () => Date },
  plan: ReorgRecoveryPlan,
): Promise<{ released: string[] }> {
  const { events, chain } = dependencies;
  const existing = await events.getHalt(chain);
  const halt = {
    block: existing?.block ?? BigInt(plan.confirmedBlock),
    at: existing?.at ?? dependencies.now(),
  };
  await events.haltForReorg(chain, halt.block, halt.at);

  const released: string[] = [];

  for (const entry of plan.release) {
    if (
      await dependencies.campaigns.unlinkOnchain(
        entry.campaignId,
        {
          onchainCampaignId: entry.onchainCampaignId,
          contractAddress: dependencies.chain.contractAddress,
        },
        dependencies.now(),
      )
    ) {
      released.push(entry.campaignId);
    }
  }

  await events.resetIndex(chain);

  // Each application gets a later time than the one it replaces, so a
  // worker still holding the earlier one can never clear this halt.
  const previous = existing?.recoveryAppliedAt?.getTime() ?? -Infinity;
  const appliedAt = new Date(
    Math.max(dependencies.now().getTime(), previous + 1),
  );

  if (!(await events.markRecoveryApplied(chain, appliedAt))) {
    // Only a manual delete gets here. Fail closed: participation must stay
    // refused over the dropped index, and nothing may rebuild unattended.
    await events.haltForReorg(chain, halt.block, halt.at);
    throw new Error(
      "The halt was removed while recovery was applied; it is recorded again. Run `reorg:recover -- --apply` again.",
    );
  }

  return { released };
}

/**
 * Run by the worker after a rebuild pass. The halt may be cleared only when
 * the stored index (read again here: `--apply` may have reset it since the
 * pass indexed) has caught up to the pass's confirmed head, every link is
 * still canonical with the draft's parameters, and every link's indexed
 * state equals the contract's at the cursor's block. Each write extends the
 * cursor it read, so a caught-up cursor means a contiguous index from the
 * deploy block; the contract comparison checks that from the chain's side.
 */
export async function verifyRecovery(
  dependencies: ReorgRecoveryDependencies,
  index: { head: bigint },
): Promise<
  { ok: true; indexedThrough: bigint } | { ok: false; reason: string }
> {
  const cursor = await dependencies.events.getCursor(dependencies.chain);

  if (
    !cursor ||
    cursor.latestConfirmedBlock <
      index.head - BigInt(dependencies.confirmations)
  ) {
    return { ok: false, reason: "index still catching up" };
  }

  const plan = await planReorgRecovery(dependencies);

  if (plan.release.length > 0) {
    return {
      ok: false,
      reason: `links not canonical: ${plan.release
        .map((entry) => `${entry.campaignId} (${entry.reason})`)
        .join(", ")}`,
    };
  }

  const incomplete: string[] = [];

  for (const link of plan.keep) {
    const { confirmed } = reconcileCampaignEvents(
      await dependencies.events.listCampaignEvents(
        dependencies.chain,
        link.onchainCampaignId,
      ),
    );
    const onchain = await readOnchainCampaign(
      dependencies.rpc,
      dependencies.chain.contractAddress,
      link.onchainCampaignId,
      cursor.latestConfirmedBlock,
    );
    const mismatches = [
      ...(onchain && confirmed.status === "not_found"
        ? ["creation not indexed"]
        : []),
      ...indexMismatches(onchain, confirmed),
    ];

    if (mismatches.length > 0) {
      incomplete.push(`${link.campaignId} (${mismatches.join("; ")})`);
    }
  }

  return incomplete.length === 0
    ? { ok: true, indexedThrough: cursor.latestConfirmedBlock }
    : {
        ok: false,
        reason: `index disagrees with the contract: ${incomplete.join(", ")}`,
      };
}

export type ReorgRecoveryRun =
  | {
      mode: "dry-run";
      halted: ChainHalt | null;
      plan: ReorgRecoveryPlan;
      /** Another process holds the deployment: `--apply` would refuse. */
      deploymentLocked: boolean;
    }
  | {
      mode: "apply";
      halted: ChainHalt | null;
      plan: ReorgRecoveryPlan;
      released: string[];
    }
  | { mode: "refused"; reason: string };

/**
 * `reorg:recover`: prints the plan, or with `apply` plans and applies it
 * while holding the deployment lock. An indexer worker holds that lock for
 * its whole run, so `--apply` refuses while one may still be writing.
 */
export async function runReorgRecovery(
  dependencies: ReorgRecoveryDependencies & { now: () => Date },
  options: { apply: boolean },
): Promise<ReorgRecoveryRun> {
  const lock = await dependencies.events.lockDeployment(dependencies.chain);

  if (!options.apply) {
    await lock?.release();
    return {
      mode: "dry-run",
      halted: await dependencies.events.getHalt(dependencies.chain),
      plan: await planReorgRecovery(dependencies),
      deploymentLocked: lock === null,
    };
  }

  if (!lock) {
    return {
      mode: "refused",
      reason:
        "An indexer worker (or another `reorg:recover --apply`) holds this deployment. Stop the worker, and anything that restarts it, then run --apply again.",
    };
  }

  try {
    const halted = await dependencies.events.getHalt(dependencies.chain);
    const plan = await planReorgRecovery(dependencies);
    const { released } = await applyReorgRecovery(dependencies, plan);
    return { mode: "apply", halted, plan, released };
  } finally {
    await lock.release();
  }
}
