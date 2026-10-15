import {
  draftRefFor,
  matchesDraft,
  readCampaignIdByDraft,
  readOnchainCampaign,
} from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type { ChainEventRepository, ChainScope } from "./events-repository.js";
import type { ChainRpc } from "./rpc.js";

/**
 * Recovery after a reorg deeper than the confirmation depth (ADR-0011).
 *
 * 1. The indexer worker records a halt and stops; the API refuses all
 *    participation and signing for the deployment.
 * 2. `pnpm --filter @vham/api reorg:recover` prints a plan; `-- --apply`
 *    releases links that are no longer canonical, drops the index and marks
 *    the halt "recovery applied". The halt stays.
 * 3. The restarted worker rebuilds the index from the deploy block, links
 *    canonical creations and re-syncs statuses. Only when it has caught up
 *    and {@link verifyRecovery} finds every link canonical does it clear the
 *    halt; until then the API keeps refusing participation.
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
 */
export async function applyReorgRecovery(
  dependencies: ReorgRecoveryDependencies & { now: () => Date },
  plan: ReorgRecoveryPlan,
): Promise<{ released: string[] }> {
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

  await dependencies.events.resetIndex(dependencies.chain);
  await dependencies.events.markRecoveryApplied(
    dependencies.chain,
    dependencies.now(),
  );

  return { released };
}

/**
 * Run by the worker after a rebuild pass. The halt may be cleared only when
 * the index has caught up to the confirmed head and every link is still
 * canonical with the draft's parameters.
 */
export async function verifyRecovery(
  dependencies: Omit<ReorgRecoveryDependencies, "events">,
  index: { confirmedThrough: bigint; head: bigint },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (
    index.confirmedThrough <
    index.head - BigInt(dependencies.confirmations)
  ) {
    return { ok: false, reason: "index still catching up" };
  }

  const plan = await planReorgRecovery(dependencies);
  return plan.release.length === 0
    ? { ok: true }
    : {
        ok: false,
        reason: `links not canonical: ${plan.release
          .map((entry) => `${entry.campaignId} (${entry.reason})`)
          .join(", ")}`,
      };
}
