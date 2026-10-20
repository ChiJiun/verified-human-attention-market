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

export type UnixSeconds = bigint;
export type Seconds = bigint;

export const CLOSE_INCLUSION_MARGIN_SECONDS: Seconds = 60n;

export interface SettlementReading {
  status: ContractCampaignStatus;
  endTime: UnixSeconds;
  closedAt: UnixSeconds;
  maxAuthorizationTtl: Seconds;
  paused: boolean;
  blockTimestamp: UnixSeconds;
}

export type CloseAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: "not-active" | "ended" | "ending-soon" };

export type RefundAvailability =
  | { kind: "available" }
  | { kind: "waiting"; availableAt: UnixSeconds }
  | { kind: "unavailable"; reason: "not-active" | "settled" | "paused" };

export function refundAvailableAt(
  reading: Pick<
    SettlementReading,
    "endTime" | "closedAt" | "maxAuthorizationTtl"
  >,
): UnixSeconds {
  const issuanceDeadline =
    reading.closedAt !== 0n ? reading.closedAt : reading.endTime;
  return issuanceDeadline + reading.maxAuthorizationTtl + 1n;
}

export function closeAvailability(
  reading: SettlementReading,
): CloseAvailability {
  if (reading.status !== "active") {
    return { kind: "unavailable", reason: "not-active" };
  }
  if (reading.blockTimestamp >= reading.endTime) {
    return { kind: "unavailable", reason: "ended" };
  }
  if (
    reading.blockTimestamp + CLOSE_INCLUSION_MARGIN_SECONDS >=
    reading.endTime
  ) {
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
  return reading.blockTimestamp >= availableAt
    ? { kind: "available" }
    : { kind: "waiting", availableAt };
}
