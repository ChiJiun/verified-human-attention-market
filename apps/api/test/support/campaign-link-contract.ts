import { randomUUID } from "node:crypto";

import { getAddress } from "viem";
import { expect, it } from "vitest";

import type { CampaignRepository } from "../../src/campaigns/repository.js";
import {
  hashMissionDefinition,
  toMissionDefinition,
} from "../../src/missions/schemas.js";

const NOW = new Date("2026-10-05T10:00:00.000Z");

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

/**
 * On-chain link behaviour every CampaignRepository must satisfy (ADR-0011).
 * Registered once per implementation so the in-memory double cannot drift
 * from PostgreSQL semantics.
 */
export function defineCampaignLinkContract(
  repository: () => CampaignRepository,
) {
  it("stores and matches the contract address whatever its casing", async () => {
    const campaigns = repository();
    // A deployment of its own in the shared database: ids restart per contract.
    const lower = `0x${"ab".repeat(20)}`;
    const checksummed = getAddress(lower);
    expect(checksummed).not.toBe(lower);
    const link = {
      onchainCampaignId: "1",
      publishTxHash: null,
      status: "pending_onchain" as const,
      updatedAt: NOW,
    };
    const id = await createDraft(campaigns);

    const linked = await campaigns.linkOnchain(id, {
      ...link,
      contractAddress: checksummed,
    });
    expect(linked.onchainContractAddress).toBe(lower);
    expect((await campaigns.getById(id))?.onchainContractAddress).toBe(lower);

    // The same link in either casing is idempotent, not a conflict.
    expect(
      (await campaigns.linkOnchain(id, { ...link, contractAddress: lower })).id,
    ).toBe(id);
    expect((await campaigns.findByOnchainId(84532, checksummed, "1"))?.id).toBe(
      id,
    );
    expect(
      (await campaigns.listLinked(84532, checksummed)).map((c) => c.id),
    ).toContain(id);
    expect(
      await campaigns.unlinkOnchain(
        id,
        { onchainCampaignId: "1", contractAddress: checksummed },
        NOW,
      ),
    ).toBe(true);
    expect((await campaigns.getById(id))?.onchainCampaignId).toBeNull();
  });
}
