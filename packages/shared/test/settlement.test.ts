import { describe, expect, it } from "vitest";

import contractSource from "../../contracts/src/CampaignManager.sol?raw";
import {
  CLOSE_MARGIN_SECONDS,
  closeAvailability,
  parseContractCampaignStatus,
  refundAvailability,
  refundAvailableAt,
  type SettlementReading,
} from "../src/settlement.js";

// CampaignManager.MAX_AUTHORIZATION_TTL is 15 minutes.
const TTL = 900n;
const START = 1_800_000_000n;
const END = START + 3_600n;
const CLOSED_AT = START + 600n;

// The contract refunds when block.timestamp > deadline + TTL, where the
// deadline is the close time, or the end time for a campaign never closed.
const REFUND_AFTER_END = END + TTL + 1n;
const REFUND_AFTER_CLOSE = CLOSED_AT + TTL + 1n;

const reading = (
  overrides: Partial<SettlementReading> = {},
): SettlementReading => ({
  status: "active",
  endTime: END,
  closedAt: 0n,
  ttl: TTL,
  paused: false,
  now: START,
  ...overrides,
});

/** The members of `enum CampaignStatus` in the Solidity source, in order. */
function declaredStatuses(): string[] {
  const body = /enum\s+CampaignStatus\s*\{([^}]*)\}/.exec(contractSource)?.[1];
  if (body === undefined) {
    throw new Error("enum CampaignStatus not found in CampaignManager.sol");
  }
  return body
    .split(",")
    .map((member) => member.trim().toLowerCase())
    .filter((member) => member !== "");
}

describe("parseContractCampaignStatus", () => {
  it("names every index the way CampaignManager declares its statuses", () => {
    const declared = declaredStatuses();

    expect(
      declared.map((_, index) => parseContractCampaignStatus(index)),
    ).toEqual(declared);
    expect(() => parseContractCampaignStatus(declared.length)).toThrow(
      RangeError,
    );
  });

  it.each([-1, 1.5, Number.NaN, 255])("rejects index %s", (index) => {
    expect(() => parseContractCampaignStatus(index)).toThrow(RangeError);
  });
});

describe("refundAvailableAt", () => {
  it("is one second past endTime + ttl for a campaign never closed", () => {
    expect(refundAvailableAt(reading())).toBe(REFUND_AFTER_END);
  });

  it("counts from the close time once the campaign was closed", () => {
    expect(
      refundAvailableAt(reading({ status: "closed", closedAt: CLOSED_AT })),
    ).toBe(REFUND_AFTER_CLOSE);
  });
});

describe("refundAvailability", () => {
  it("waits until one second past endTime + ttl when the campaign was never closed", () => {
    expect(refundAvailability(reading({ now: REFUND_AFTER_END - 1n }))).toEqual(
      { kind: "waiting", availableAt: REFUND_AFTER_END },
    );
    expect(refundAvailability(reading({ now: REFUND_AFTER_END }))).toEqual({
      kind: "available",
    });
    expect(refundAvailability(reading({ now: REFUND_AFTER_END + 1n }))).toEqual(
      { kind: "available" },
    );
  });

  it("counts from the close time, which opens the refund before the end time would", () => {
    const closed = { status: "closed", closedAt: CLOSED_AT } as const;

    expect(REFUND_AFTER_CLOSE).toBeLessThan(REFUND_AFTER_END);
    expect(
      refundAvailability(reading({ ...closed, now: REFUND_AFTER_CLOSE - 1n })),
    ).toEqual({ kind: "waiting", availableAt: REFUND_AFTER_CLOSE });
    expect(
      refundAvailability(reading({ ...closed, now: REFUND_AFTER_CLOSE })),
    ).toEqual({ kind: "available" });
  });

  it("keeps waiting for the end while the campaign is still running", () => {
    expect(refundAvailability(reading({ now: START }))).toEqual({
      kind: "waiting",
      availableAt: REFUND_AFTER_END,
    });
  });

  it("is blocked while the contract is paused, whatever the time", () => {
    for (const now of [
      START,
      REFUND_AFTER_END - 1n,
      REFUND_AFTER_END,
      END * 2n,
    ]) {
      expect(refundAvailability(reading({ paused: true, now }))).toEqual({
        kind: "unavailable",
        reason: "paused",
      });
    }
  });

  it.each(["draft", "expired", "cancelled"] as const)(
    "is not offered for a %s campaign",
    (status) => {
      expect(
        refundAvailability(reading({ status, now: REFUND_AFTER_END })),
      ).toEqual({ kind: "unavailable", reason: "not-active" });
    },
  );

  it("is not offered again once settled, paused or not", () => {
    for (const paused of [false, true]) {
      expect(
        refundAvailability(
          reading({
            status: "settled",
            closedAt: CLOSED_AT,
            paused,
            now: REFUND_AFTER_END,
          }),
        ),
      ).toEqual({ kind: "unavailable", reason: "settled" });
    }
  });
});

describe("closeAvailability", () => {
  it("is offered while active and further from the end than the margin", () => {
    expect(closeAvailability(reading({ now: START }))).toEqual({
      kind: "available",
    });
    expect(
      closeAvailability(reading({ now: END - CLOSE_MARGIN_SECONDS - 1n })),
    ).toEqual({ kind: "available" });
  });

  it("is not offered inside the margin before the end", () => {
    for (const now of [END - CLOSE_MARGIN_SECONDS, END - 1n]) {
      expect(closeAvailability(reading({ now }))).toEqual({
        kind: "unavailable",
        reason: "ending-soon",
      });
    }
  });

  it("is not offered at or after the end", () => {
    for (const now of [END, END + 1n]) {
      expect(closeAvailability(reading({ now }))).toEqual({
        kind: "unavailable",
        reason: "ended",
      });
    }
  });

  it("still works while the contract is paused", () => {
    expect(closeAvailability(reading({ paused: true }))).toEqual({
      kind: "available",
    });
  });

  it.each(["draft", "closed", "expired", "settled", "cancelled"] as const)(
    "is not offered for a %s campaign",
    (status) => {
      expect(closeAvailability(reading({ status }))).toEqual({
        kind: "unavailable",
        reason: "not-active",
      });
    },
  );
});

describe("closing and refunding", () => {
  it("are never offered at the same time", () => {
    const legalStates: Partial<SettlementReading>[] = [
      { status: "active", closedAt: 0n },
      { status: "closed", closedAt: CLOSED_AT },
    ];
    const times = [
      START,
      CLOSED_AT,
      END - CLOSE_MARGIN_SECONDS - 1n,
      END - CLOSE_MARGIN_SECONDS,
      END,
      REFUND_AFTER_CLOSE,
      REFUND_AFTER_END - 1n,
      REFUND_AFTER_END,
    ];

    for (const state of legalStates) {
      for (const now of times) {
        for (const paused of [false, true]) {
          const current = reading({ ...state, now, paused });
          const both =
            closeAvailability(current).kind === "available" &&
            refundAvailability(current).kind === "available";

          expect(both).toBe(false);
        }
      }
    }
  });
});
