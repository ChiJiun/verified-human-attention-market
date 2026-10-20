const CONTRACT_STATUSES = [
  "draft",
  "active",
  "closed",
  "expired",
  "settled",
  "cancelled",
] as const;

type ContractCampaignStatus = (typeof CONTRACT_STATUSES)[number];

export type StoredCampaignStatus = Exclude<ContractCampaignStatus, "expired">;

export function parseStoredCampaignStatus(index: number): StoredCampaignStatus {
  const status = CONTRACT_STATUSES[index];
  if (status === undefined) {
    throw new RangeError(`Unknown CampaignManager status index: ${index}.`);
  }
  if (status === "expired") {
    throw new RangeError(
      `CampaignManager never stores status index ${index} (expired); statusOf derives it.`,
    );
  }
  return status;
}

export type UnixSeconds = bigint;
export type Seconds = bigint;

export const CLOSE_INCLUSION_MARGIN_SECONDS: Seconds = 60n;

export interface SettlementReading {
  storedStatus: StoredCampaignStatus;
  endTime: UnixSeconds;
  closedAt: UnixSeconds | null;
  maxAuthorizationTtl: Seconds;
  paused: boolean;
  blockTimestamp: UnixSeconds;
}

export function parseClosedAt(raw: bigint): UnixSeconds | null {
  return raw === 0n ? null : raw;
}

export type CloseAvailability =
  | { kind: "available" }
  | { kind: "unavailable"; reason: "not-active" | "ended" | "ending-soon" };

export type RefundAvailability =
  | { kind: "available" }
  | { kind: "waiting"; availableAt: UnixSeconds }
  | { kind: "unavailable"; reason: "not-active" | "settled" | "paused" };

function firstSecondAfter(time: UnixSeconds): UnixSeconds {
  return time + 1n;
}

export function refundAvailableAt(
  reading: Pick<
    SettlementReading,
    "endTime" | "closedAt" | "maxAuthorizationTtl"
  >,
): UnixSeconds {
  const issuanceDeadline = reading.closedAt ?? reading.endTime;
  return firstSecondAfter(issuanceDeadline + reading.maxAuthorizationTtl);
}

export function closeAvailability(
  reading: SettlementReading,
): CloseAvailability {
  if (reading.storedStatus !== "active") {
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
  if (reading.storedStatus === "settled") {
    return { kind: "unavailable", reason: "settled" };
  }
  if (reading.storedStatus !== "active" && reading.storedStatus !== "closed") {
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
