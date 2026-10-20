const CONTRACT_STATUSES = [
  "draft",
  "active",
  "closed",
  "expired",
  "settled",
  "cancelled",
] as const;

export type ContractCampaignStatus = (typeof CONTRACT_STATUSES)[number];

export function parseContractCampaignStatus(
  index: number,
): ContractCampaignStatus {
  const status = CONTRACT_STATUSES[index];
  if (status === undefined) {
    throw new RangeError(`Unknown CampaignManager status index: ${index}.`);
  }
  return status;
}

export const CLOSE_MARGIN_SECONDS = 60n;

export interface SettlementReading {
  status: ContractCampaignStatus;
  endTime: bigint;
  closedAt: bigint;
  ttl: bigint;
  paused: boolean;
  now: bigint;
}

export type CloseAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: "not-active" | "ended" | "ending-soon" };

export type RefundAvailability =
  | { kind: "available" }
  | { kind: "waiting"; availableAt: bigint }
  | { kind: "unavailable"; reason: "not-active" | "settled" | "paused" };

export function refundAvailableAt(
  reading: Pick<SettlementReading, "endTime" | "closedAt" | "ttl">,
): bigint {
  const issuanceDeadline =
    reading.closedAt !== 0n ? reading.closedAt : reading.endTime;
  return issuanceDeadline + reading.ttl + 1n;
}

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
