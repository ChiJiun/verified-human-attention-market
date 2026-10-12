import type { CampaignManagerEvent } from "./abi.js";
import type { StoredEvent } from "./events-repository.js";

export type OnchainCampaignStatus =
  | "not_found"
  | "created"
  | "active"
  | "closed"
  | "settled"
  | "cancelled";

export interface OnchainCampaignState {
  status: OnchainCampaignStatus;
  advertiser: string | null;
  /** USDC atomic units as decimal strings. */
  funded: string;
  paidRewards: string;
  refunded: string;
  remaining: string;
  paidCompletions: number;
  /** paid + refunded > funded: must never happen; raise an alert. */
  accountingViolation: boolean;
}

/**
 * Pure fold over canonical CampaignManager events (chain order). The chain is
 * authoritative for settlement (AGENTS.md §12); the database only caches.
 */
export function deriveCampaignState(
  events: CampaignManagerEvent[],
): OnchainCampaignState {
  let status: OnchainCampaignStatus = "not_found";
  let advertiser: string | null = null;
  let funded = 0n;
  let paid = 0n;
  let refunded = 0n;
  let paidCompletions = 0;

  for (const event of events) {
    switch (event.name) {
      case "CampaignCreated":
        status = "created";
        advertiser = event.advertiser;
        break;
      case "CampaignFunded":
        funded += BigInt(event.amount);
        status = "active";
        break;
      case "RewardClaimed":
        paid += BigInt(event.amount);
        paidCompletions += 1;
        break;
      case "CampaignClosed":
        status = "closed";
        break;
      case "CampaignRefunded":
        refunded += BigInt(event.amount);
        status = "settled";
        break;
      case "CampaignCancelled":
        status = "cancelled";
        break;
      default:
        break;
    }
  }

  const remaining = funded - paid - refunded;

  return {
    status,
    advertiser,
    funded: funded.toString(),
    paidRewards: paid.toString(),
    refunded: refunded.toString(),
    remaining: (remaining > 0n ? remaining : 0n).toString(),
    paidCompletions,
    accountingViolation: remaining < 0n,
  };
}

/**
 * Confirmed state counts only finalized events; pending state additionally
 * includes observed (not yet confirmed) events so the UI can show progress.
 */
export function reconcileCampaignEvents(events: StoredEvent[]): {
  confirmed: OnchainCampaignState;
  pending: OnchainCampaignState;
  hasUnconfirmedEvents: boolean;
} {
  const confirmed = events.filter((event) => event.status === "confirmed");
  const live = events.filter((event) => event.status !== "orphaned");

  return {
    confirmed: deriveCampaignState(confirmed.map((event) => event.event)),
    pending: deriveCampaignState(live.map((event) => event.event)),
    hasUnconfirmedEvents: live.length > confirmed.length,
  };
}
