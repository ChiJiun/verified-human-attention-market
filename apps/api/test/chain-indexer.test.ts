import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  decodeCampaignManagerLog,
  EVENT_TOPICS,
  FUNCTION_SELECTORS,
} from "../src/chain/abi.js";
import { deriveCampaignState } from "../src/chain/campaign-state.js";
import { InMemoryChainEventRepository } from "../src/chain/events-repository.js";
import { addressWord, logs, word } from "./support/fake-chain.js";
import { defineIndexerContract } from "./support/indexer-contract.js";

describe("CampaignManager ABI constants", () => {
  const solidity = readFileSync(
    new URL(
      "../../../packages/contracts/test/EventTopics.t.sol",
      import.meta.url,
    ),
    "utf8",
  );

  it("match the topics pinned by the Foundry test", () => {
    for (const [name, topic] of Object.entries(EVENT_TOPICS)) {
      const constant = name.replace(/(?<!^)([A-Z])/g, "_$1").toUpperCase();
      expect(solidity).toContain(
        `bytes32 private constant ${constant} = ${topic};`,
      );
      expect(solidity).toContain(
        `CampaignManager.${name}.selector == ${constant}`,
      );
    }
  });

  it("match the selectors pinned by the Foundry test", () => {
    for (const [name, selector] of Object.entries(FUNCTION_SELECTORS)) {
      expect(solidity).toMatch(
        new RegExp(
          `(CampaignManager|manager)\\.${name}\\.selector == bytes4\\(${selector}\\)`,
        ),
      );
    }
  });
});

describe("decodeCampaignManagerLog", () => {
  const advertiser = "0x" + "ab".repeat(20);

  it("decodes every settlement event", () => {
    expect(decodeCampaignManagerLog(logs.created(7, advertiser))).toEqual({
      name: "CampaignCreated",
      campaignId: "7",
      advertiser,
    });
    expect(
      decodeCampaignManagerLog(logs.claimed(7, advertiser, 5n, 9)),
    ).toEqual({
      name: "RewardClaimed",
      campaignId: "7",
      claimant: advertiser,
      amount: "5",
      nonce: word(9),
    });
    expect(decodeCampaignManagerLog(logs.refunded(7, 3n))).toEqual({
      name: "CampaignRefunded",
      campaignId: "7",
      amount: "3",
    });
  });

  it.each([
    ["unknown topic", { topics: [word(1)], data: "0x" }],
    [
      "missing indexed topic",
      { topics: [EVENT_TOPICS.CampaignCreated, word(1)], data: "0x" },
    ],
    [
      "extra data word",
      { ...logs.funded(1, 1n), data: word(1) + word(2).slice(2) },
    ],
    ["truncated data", { ...logs.funded(1, 1n), data: "0x1234" }],
    [
      "dirty address padding",
      {
        topics: [
          EVENT_TOPICS.CampaignCreated,
          word(1),
          `0x${"f".repeat(24)}${"a".repeat(40)}`,
        ],
        data: "0x",
      },
    ],
    [
      "non-boolean pause flag",
      { topics: [EVENT_TOPICS.PausedStateChanged], data: word(2) },
    ],
  ])("rejects %s", (_label, log) => {
    expect(decodeCampaignManagerLog(log)).toBeNull();
  });

  it("decodes pause and signer events", () => {
    expect(
      decodeCampaignManagerLog({
        topics: [EVENT_TOPICS.PausedStateChanged],
        data: word(1),
      }),
    ).toEqual({ name: "PausedStateChanged", paused: true });
    expect(
      decodeCampaignManagerLog({
        topics: [
          EVENT_TOPICS.SignerUpdated,
          addressWord(advertiser),
          addressWord("0x" + "1".repeat(40)),
        ],
        data: "0x",
      }),
    ).toEqual({
      name: "SignerUpdated",
      previousSigner: advertiser,
      newSigner: "0x" + "1".repeat(40),
    });
  });
});

describe("deriveCampaignState", () => {
  it("flags accounting violations instead of hiding them", () => {
    const state = deriveCampaignState([
      {
        name: "CampaignCreated",
        campaignId: "1",
        advertiser: "0x" + "a".repeat(40),
      },
      { name: "CampaignFunded", campaignId: "1", amount: "1" },
      {
        name: "RewardClaimed",
        campaignId: "1",
        claimant: "0x" + "b".repeat(40),
        amount: "2",
        nonce: word(1),
      },
    ]);

    expect(state.accountingViolation).toBe(true);
    expect(state.remaining).toBe("0");
  });

  it("reports not_found without events", () => {
    expect(deriveCampaignState([]).status).toBe("not_found");
  });
});

describe("indexer (in-memory repository)", () => {
  defineIndexerContract({
    repository: () => new InMemoryChainEventRepository(),
  });
});
