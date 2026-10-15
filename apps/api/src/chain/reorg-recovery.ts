import { draftRefFor, readCampaignIdByDraft } from "../campaigns/onchain.js";
import type { CampaignRepository } from "../campaigns/repository.js";
import type { ChainEventRepository, ChainScope } from "./events-repository.js";
import type { ChainRpc } from "./rpc.js";

/**
 * Recovery after a reorg deeper than the confirmation depth (ADR-0011).
 *
 * The indexer worker halts instead of guessing, and the API stops all
 * participation and signing for the deployment. An operator then runs
 * `pnpm --filter @vham/api reorg:recover` (a dry run) and, after reviewing
 * the plan, `-- --apply`:
 *
 * 1. Every link of the deployment is checked against the contract's own
 *    record at the confirmed head: `campaignIdByDraft(advertiser, draftRef)`
 *    must still equal the linked id. Links whose creation disappeared, or
 *    whose id now belongs to another draft, are released (back to `draft`).
 * 2. The index for the deployment is dropped and rebuilt by the worker from
 *    the deploy block; auto-link and status sync then re-derive every link
 *    and status from canonical events. This also clears the halt.
 */

export interface ReorgRecoveryPlan {
  /** Block the canonical check was made at (head minus confirmations). */
  confirmedBlock: string;
  keep: { campaignId: string; onchainCampaignId: string }[];
  release: {
    campaignId: string;
    onchainCampaignId: string;
    /** This draft's id on the canonical chain, or null if none. */
    canonicalOnchainCampaignId: string | null;
  }[];
}

export interface ReorgRecoveryDependencies {
  campaigns: CampaignRepository;
  events: ChainEventRepository;
  rpc: ChainRpc;
  chain: ChainScope;
  confirmations: number;
}

export async function planReorgRecovery(
  dependencies: Omit<ReorgRecoveryDependencies, "events">,
): Promise<ReorgRecoveryPlan> {
  const head = await dependencies.rpc.blockNumber();
  const confirmedBlock = head - BigInt(dependencies.confirmations);
  const plan: ReorgRecoveryPlan = {
    confirmedBlock: (confirmedBlock < 0n ? 0n : confirmedBlock).toString(),
    keep: [],
    release: [],
  };

  for (const campaign of await dependencies.campaigns.listLinked(
    dependencies.chain.chainId,
    dependencies.chain.contractAddress,
  )) {
    const linkedId = campaign.onchainCampaignId!;
    const canonical =
      confirmedBlock < 0n
        ? null
        : await readCampaignIdByDraft(
            dependencies.rpc,
            dependencies.chain.contractAddress,
            campaign.advertiserAddress,
            draftRefFor(campaign.id),
            confirmedBlock,
          );

    if (canonical === linkedId) {
      plan.keep.push({ campaignId: campaign.id, onchainCampaignId: linkedId });
    } else {
      plan.release.push({
        campaignId: campaign.id,
        onchainCampaignId: linkedId,
        canonicalOnchainCampaignId: canonical,
      });
    }
  }

  return plan;
}

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

  // Rebuild from canonical events; also clears the halt.
  await dependencies.events.resetIndex(dependencies.chain);

  return { released };
}
