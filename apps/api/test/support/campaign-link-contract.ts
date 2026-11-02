import { randomBytes, randomUUID } from "node:crypto";

import { getAddress } from "viem";
import { expect, it } from "vitest";

import type { CampaignRepository } from "../../src/campaigns/repository.js";
import {
  hashMissionDefinition,
  toMissionDefinition,
} from "../../src/missions/schemas.js";

const NOW = new Date("2026-10-05T10:00:00.000Z");

/** Links are unique per chain, contract and on-chain id; ids restart at 1. */
function freshContract(): { stored: string; checksummed: string } {
  const stored = `0x${randomBytes(20).toString("hex")}`;
  const checksummed = getAddress(stored);
  return checksummed === stored ? freshContract() : { stored, checksummed };
}

async function createDraft(campaigns: CampaignRepository): Promise<string> {
  const id = randomUUID();
  const definition = toMissionDefinition("https://example.com/link", {
    questions: [
      {
        id: "q1",
        prompt: "Pick a",
        choices: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      },
    ],
    answerKey: { q1: "a" },
  });

  await campaigns.createIdempotent({
    id,
    chainId: 84532,
    advertiserAddress: `0x${"2".repeat(40)}`,
    creationIdempotencyKey: `link-${id}`,
    creationRequestHash: `hash-${id}`,
    contentUrl: "https://example.com/link",
    rewardAtomic: "1000000",
    maxCompletions: 10,
    startAt: new Date("2026-10-05T10:15:00.000Z"),
    endAt: new Date("2026-10-05T11:15:00.000Z"),
    status: "draft",
    createdAt: NOW,
    updatedAt: NOW,
    mission: {
      id: randomUUID(),
      definition,
      definitionHash: hashMissionDefinition(definition),
    },
  });

  return id;
}

export function defineCampaignLinkContract(
  repository: () => CampaignRepository,
) {
  it("stores and matches the contract address whatever its casing", async () => {
    const campaigns = repository();
    const contract = freshContract();
    const link = {
      onchainCampaignId: "1",
      publishTxHash: null,
      status: "pending_onchain" as const,
      updatedAt: NOW,
    };
    const id = await createDraft(campaigns);

    const linked = await campaigns.linkOnchain(id, {
      ...link,
      contractAddress: contract.checksummed,
    });
    expect(linked.onchainContractAddress).toBe(contract.stored);
    expect((await campaigns.getById(id))?.onchainContractAddress).toBe(
      contract.stored,
    );

    expect(
      (
        await campaigns.linkOnchain(id, {
          ...link,
          contractAddress: contract.stored,
        })
      ).id,
    ).toBe(id);
    expect(
      (await campaigns.findByOnchainId(84532, contract.checksummed, "1"))?.id,
    ).toBe(id);
    expect(
      (await campaigns.listLinked(84532, contract.checksummed)).map(
        (c) => c.id,
      ),
    ).toEqual([id]);
    expect(
      await campaigns.unlinkOnchain(
        id,
        { onchainCampaignId: "1", contractAddress: contract.checksummed },
        NOW,
      ),
    ).toBe(true);
    expect((await campaigns.getById(id))?.onchainCampaignId).toBeNull();
  });
}
