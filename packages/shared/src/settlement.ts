/**
 * When the advertiser may close a campaign and refund its unused budget, as
 * CampaignManager enforces it. The advertiser page reads the contract's own
 * numbers and offers only what these functions allow. The contract stays the
 * authority and still rejects anything that slips through.
 */

/**
 * `CampaignManager.CampaignStatus` in declaration order. A test pins this
 * list to the Solidity source, so inserting a status there fails the tests.
 */
const CONTRACT_STATUSES = [
  "draft",
  "active",
  "closed",
  "expired",
  "settled",
  "cancelled",
] as const;

export type ContractCampaignStatus = (typeof CONTRACT_STATUSES)[number];

/** Parses the `status` index that `campaigns(id)` returns. */
export function parseContractCampaignStatus(
  index: number,
): ContractCampaignStatus {
  const status = CONTRACT_STATUSES[index];
  if (status === undefined) {
    throw new RangeError(`Unknown CampaignManager status index: ${index}.`);
  }
  return status;
}

/**
 * A close is mined some seconds after the page reads the chain, and the
 * contract rejects one mined at or after `endTime`. Inside this margin no
 * close is offered.
 */
export const CLOSE_MARGIN_SECONDS = 60n;

/** What the advertiser's wallet reads from CampaignManager. All times are seconds. */
export interface SettlementReading {
  /**
   * The stored status from `campaigns(id)`, which close and refund check. Not
   * `statusOf(id)`: that reports `expired` once an active campaign passes its
   * end time, yet such a campaign can still be refunded.
   */
  status: ContractCampaignStatus;
  endTime: bigint;
  /** 0n until the campaign is closed. */
  closedAt: bigint;
  /** `MAX_AUTHORIZATION_TTL`. */
  ttl: bigint;
  paused: boolean;
  /** Timestamp of the latest block. The contract judges by block time, never the local clock. */
  now: bigint;
}

export type CloseAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: "not-active" | "ended" | "ending-soon" };

export type RefundAvailability =
  | { kind: "available" }
  /** The authorizations issued before the deadline have not all expired yet. */
  | { kind: "waiting"; availableAt: bigint }
  | { kind: "unavailable"; reason: "not-active" | "settled" | "paused" };

/**
 * First block timestamp at which `refundUnusedBudget` succeeds. The deadline
 * is the close time, or the end time when the campaign was never closed; the
 * contract needs `block.timestamp > deadline + ttl`, hence the extra second.
 */
export function refundAvailableAt(
  reading: Pick<SettlementReading, "endTime" | "closedAt" | "ttl">,
): bigint {
  const issuanceDeadline =
    reading.closedAt !== 0n ? reading.closedAt : reading.endTime;
  return issuanceDeadline + reading.ttl + 1n;
}

/** `closeCampaign` works while the contract is paused. */
export function closeAvailability(
  reading: SettlementReading,
): CloseAvailability {
  if (reading.status !== "active") {
    return { kind: "unavailable", reason: "not-active" };
  }
  if (reading.now >= reading.endTime) {
    return { kind: "unavailable", reason: "ended" };
  }
  if (reading.now + CLOSE_MARGIN_SECONDS >= reading.endTime) {
    return { kind: "unavailable", reason: "ending-soon" };
  }
  return { kind: "available" };
}

/** `refundUnusedBudget` is blocked while the contract is paused. */
export function refundAvailability(
  reading: SettlementReading,
): RefundAvailability {
  if (reading.status === "settled") {
    return { kind: "unavailable", reason: "settled" };
  }
  if (reading.status !== "active" && reading.status !== "closed") {
    return { kind: "unavailable", reason: "not-active" };
  }
  if (reading.paused) {
    return { kind: "unavailable", reason: "paused" };
  }
  const availableAt = refundAvailableAt(reading);
  return reading.now >= availableAt
    ? { kind: "available" }
    : { kind: "waiting", availableAt };
}
