import { describe, expect, it } from "vitest";

import { isCurrentDeployment, isDraftCampaign } from "../src/deployment.js";

const CURRENT = {
  chainId: 84532,
  contractAddress: "0xAbCdEf0000000000000000000000000000000001",
};

describe("isCurrentDeployment (ADR-0011)", () => {
  it("accepts a link on the same chain and contract, ignoring address case", () => {
    expect(
      isCurrentDeployment(
        {
          chainId: 84532,
          contractAddress: "0xabcdef0000000000000000000000000000000001",
        },
        CURRENT,
      ),
    ).toBe(true);
  });

  it("rejects the same address on another chain", () => {
    expect(
      isCurrentDeployment(
        { chainId: 31337, contractAddress: CURRENT.contractAddress },
        CURRENT,
      ),
    ).toBe(false);
  });

  it("rejects another contract on the same chain", () => {
    expect(
      isCurrentDeployment(
        {
          chainId: 84532,
          contractAddress: "0x12cc9447ceb3f8e75ddf4463a1a4d9feb42bdfec",
        },
        CURRENT,
      ),
    ).toBe(false);
  });

  it("rejects unlinked campaigns, pre-ADR-0011 links and a missing configuration", () => {
    expect(
      isCurrentDeployment({ chainId: 84532, contractAddress: null }, CURRENT),
    ).toBe(false);
    expect(
      isCurrentDeployment(
        { chainId: 84532, contractAddress: "pre-adr-0011" },
        CURRENT,
      ),
    ).toBe(false);
    expect(
      isCurrentDeployment(
        { chainId: 84532, contractAddress: CURRENT.contractAddress },
        null,
      ),
    ).toBe(false);
  });
});

describe("isDraftCampaign (ADR-0011)", () => {
  const expected = {
    onchainCampaignId: "1",
    rewardPerCompletion: "1000000",
    maxCompletions: 10,
    startAt: "2026-10-15T10:00:00.000Z",
    endAt: "2026-10-15T11:00:00.000Z",
  };
  const reading = {
    mappedCampaignId: 1n,
    onchain: {
      rewardPerCompletion: 1_000_000n,
      maxCompletions: 10,
      startTime: BigInt(Date.parse(expected.startAt) / 1000),
      endTime: BigInt(Date.parse(expected.endAt) / 1000),
    },
  };

  it("accepts the draft's own campaign", () => {
    expect(isDraftCampaign(reading, expected)).toBe(true);
  });

  it("rejects a reused id that now belongs to another draft with the same budget", () => {
    // After a deep reorg this draft maps to nothing (or another id) while
    // id 1, with identical economics, is another draft's campaign.
    expect(
      isDraftCampaign({ ...reading, mappedCampaignId: 0n }, expected),
    ).toBe(false);
    expect(
      isDraftCampaign({ ...reading, mappedCampaignId: 2n }, expected),
    ).toBe(false);
  });

  it("rejects changed parameters on the same id", () => {
    expect(
      isDraftCampaign(
        { ...reading, onchain: { ...reading.onchain, maxCompletions: 9 } },
        expected,
      ),
    ).toBe(false);
    expect(
      isDraftCampaign(
        { ...reading, onchain: { ...reading.onchain, endTime: 0n } },
        expected,
      ),
    ).toBe(false);
  });
});
