import type { CampaignRepository } from "../campaigns/repository.js";
import { readOnchainCampaign } from "../campaigns/onchain.js";
import { reconcileCampaignEvents } from "../chain/campaign-state.js";
import type {
  ChainEventRepository,
  ChainScope,
} from "../chain/events-repository.js";
import type { ChainRpc } from "../chain/rpc.js";
import type { ClaimRepository } from "../claims/repository.js";

/**
 * Financial reconciliation (#29). Three independent views must agree:
 *
 * 1. the contract's own campaign struct, read at the indexer's confirmed
 *    block (so in-flight blocks cannot cause false alarms);
 * 2. the indexed confirmed events folded into campaign state;
 * 3. the API's issued claim authorizations.
 *
 * Any disagreement is a finding for an operator; nothing is auto-repaired.
 */

export type FindingKind =
  /** Indexed events disagree with the contract at the same block. */
  | "INDEX_MISMATCH"
  /** paid + refunded > funded in indexed events. */
  | "ACCOUNTING_VIOLATION"
  /** A payout whose (claimant, nonce) the API never authorized. */
  | "UNBACKED_PAYOUT"
  /** The contract could not be read at the confirmed block. */
  | "CHAIN_READ_FAILED";

export interface ReconciliationFinding {
  kind: FindingKind;
  campaignId: string;
  onchainCampaignId: string;
  detail: string;
}

export interface ReconciliationReport {
  confirmedBlock: string | null;
  campaignsChecked: number;
  findings: ReconciliationFinding[];
}

const hex = (value: string) => `0x${value.replace(/^0x/i, "")}`.toLowerCase();

export async function checkReconciliation(dependencies: {
  campaigns: Pick<CampaignRepository, "listLinked">;
  events: ChainEventRepository;
  claims: Pick<ClaimRepository, "listIssuedClaims">;
  rpc: Pick<ChainRpc, "call">;
  chain: ChainScope;
}): Promise<ReconciliationReport> {
  const cursor = await dependencies.events.getCursor(dependencies.chain);
  const findings: ReconciliationFinding[] = [];
  const linked = await dependencies.campaigns.listLinked(
    dependencies.chain.chainId,
  );

  if (!cursor) {
    return { confirmedBlock: null, campaignsChecked: 0, findings };
  }

  for (const campaign of linked) {
    const onchainCampaignId = campaign.onchainCampaignId!;
    const finding = (kind: FindingKind, detail: string) =>
      findings.push({
        kind,
        campaignId: campaign.id,
        onchainCampaignId,
        detail,
      });

    const events = await dependencies.events.listCampaignEvents(
      dependencies.chain,
      onchainCampaignId,
    );
    const { confirmed } = reconcileCampaignEvents(events);

    if (confirmed.accountingViolation) {
      finding(
        "ACCOUNTING_VIOLATION",
        `funded ${confirmed.funded}, paid ${confirmed.paidRewards}, refunded ${confirmed.refunded}`,
      );
    }

    // 1 ↔ 2: contract struct at the confirmed block vs indexed events.
    try {
      const onchain = await readOnchainCampaign(
        dependencies.rpc,
        dependencies.chain.contractAddress,
        onchainCampaignId,
        cursor.latestConfirmedBlock,
      );

      if (!onchain) {
        if (confirmed.status !== "not_found") {
          finding("INDEX_MISMATCH", "indexed campaign missing on-chain");
        }
      } else {
        const mismatches = [
          ["fundedBudget", onchain.fundedBudget, confirmed.funded],
          ["paidRewards", onchain.paidRewards, confirmed.paidRewards],
          [
            "paidCompletions",
            String(onchain.paidCompletions),
            String(confirmed.paidCompletions),
          ],
        ].filter(([, chain, indexed]) => chain !== indexed);

        for (const [field, chain, indexed] of mismatches) {
          finding(
            "INDEX_MISMATCH",
            `${field}: contract ${chain}, indexed ${indexed}`,
          );
        }
      }
    } catch {
      finding("CHAIN_READ_FAILED", "campaigns(id) at confirmed block failed");
    }

    // 2 ↔ 3: every confirmed payout must match an authorization we issued.
    const issued = new Set(
      (await dependencies.claims.listIssuedClaims(campaign.id)).map(
        (claim) => `${claim.claimant.toLowerCase()}:${hex(claim.nonce)}`,
      ),
    );

    for (const stored of events) {
      if (
        stored.status === "confirmed" &&
        stored.event.name === "RewardClaimed" &&
        !issued.has(
          `${stored.event.claimant.toLowerCase()}:${hex(stored.event.nonce)}`,
        )
      ) {
        finding(
          "UNBACKED_PAYOUT",
          `claim tx ${stored.txHash} by ${stored.event.claimant} has no matching authorization`,
        );
      }
    }
  }

  return {
    confirmedBlock: cursor.latestConfirmedBlock.toString(),
    campaignsChecked: linked.length,
    findings,
  };
}
