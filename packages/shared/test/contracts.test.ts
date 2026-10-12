import { describe, expect, it } from "vitest";

import {
  campaignManagerAbi,
  getSupportedChain,
  SUPPORTED_CHAINS,
} from "../src/index.js";

describe("campaignManagerAbi", () => {
  it("exposes the settlement events the indexer depends on", () => {
    const events = campaignManagerAbi
      .filter((entry) => entry.type === "event")
      .map((entry) => entry.name);

    expect(events).toEqual(
      expect.arrayContaining([
        "CampaignCreated",
        "CampaignFunded",
        "RewardClaimed",
        "CampaignClosed",
        "CampaignRefunded",
        "CampaignCancelled",
        "SignerUpdated",
        "OwnershipTransferred",
        "PausedStateChanged",
      ]),
    );
  });

  it("matches the EIP-712 ClaimAuthorization field order", () => {
    const claim = campaignManagerAbi.find(
      (entry) => entry.type === "function" && entry.name === "claim",
    );
    const tuple = claim?.inputs[0];

    expect(
      tuple && "components" in tuple
        ? tuple.components.map((component) => component.name)
        : [],
    ).toEqual([
      "campaignId",
      "claimant",
      "amount",
      "nonce",
      "issuedAt",
      "expiresAt",
    ]);
  });
});

describe("supported chains", () => {
  it("pins the official Base Sepolia USDC address", () => {
    expect(getSupportedChain(84532)?.usdcAddress).toBe(
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    );
  });

  it("does not enable Base mainnet before the production gate", () => {
    expect(getSupportedChain(8453)).toBeNull();
    expect(Object.keys(SUPPORTED_CHAINS).sort()).toEqual(["31337", "84532"]);
  });
});
