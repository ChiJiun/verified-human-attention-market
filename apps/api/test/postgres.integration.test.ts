import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  PostgresCampaignRepository,
} from "../src/campaigns/repository.js";
import { createDatabase } from "../src/db/client.js";
import {
  answers,
  campaigns,
  eligibility,
  missions,
  submissions,
} from "../src/db/schema.js";
import {
  hashMissionDefinition,
  toMissionDefinition,
} from "../src/missions/schemas.js";
import { PostgresEligibilityRepository } from "../src/eligibility/repository.js";
import { PostgresSubmissionRepository } from "../src/submissions/repository.js";
import { definePersistenceContract } from "./support/persistence-contract.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

function testMission(contentUrl = "https://example.com/postgres") {
  const definition = toMissionDefinition(contentUrl, {
    questions: [
      {
        id: "q1",
        prompt: "What is the product name?",
        choices: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
      },
    ],
    answerKey: { q1: "a" },
  });

  return {
    id: randomUUID(),
    definition,
    definitionHash: hashMissionDefinition(definition),
  };
}
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("PostgresCampaignRepository", () => {
  if (!databaseUrl) {
    return;
  }

  const database = createDatabase(databaseUrl);
  const repository = new PostgresCampaignRepository(database.db);

  // Financial rows reference campaigns with ON DELETE RESTRICT, so clean up
  // children first.
  async function truncateAll() {
    await database.db.delete(answers);
    await database.db.delete(submissions);
    await database.db.delete(eligibility);
    await database.db.delete(missions);
    await database.db.delete(campaigns);
  }

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });

    await truncateAll();
  });

  afterAll(async () => {
    await truncateAll();
    await database.close();
  });

  it("persists and reloads a campaign", async () => {
    const id = randomUUID();
    const createdAt = new Date("2026-10-05T10:00:00.000Z");

    const result = await repository.createIdempotent({
      id,
      chainId: 84532,
      advertiserAddress: "0x1234567890abcdef1234567890abcdef12345678",
      creationIdempotencyKey: "postgres-create-1",
      creationRequestHash: "hash-1",
      contentUrl: "https://example.com/postgres",
      rewardAtomic: "1000000",
      maxCompletions: 10,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      mission: testMission(),
    });

    expect(result.created).toBe(true);
    expect(result.campaign.id).toBe(id);
    expect(result.campaign.rewardAtomic).toBe("1000000");

    const loaded = await repository.getById(id);

    expect(loaded).toMatchObject({
      id,
      chainId: 84532,
      rewardAtomic: "1000000",
      maxCompletions: 10,
      status: "draft",
    });
  });

  it("preserves idempotency in PostgreSQL", async () => {
    const createdAt = new Date("2026-10-05T10:00:00.000Z");
    const baseInput = {
      id: randomUUID(),
      chainId: 84532,
      advertiserAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      creationIdempotencyKey: "postgres-idempotency",
      creationRequestHash: "same-request-hash",
      contentUrl: "https://example.com/idempotency",
      rewardAtomic: "1000000",
      maxCompletions: 10,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft" as const,
      createdAt,
      updatedAt: createdAt,
      mission: testMission(),
    };

    const first = await repository.createIdempotent(baseInput);
    const second = await repository.createIdempotent({
      ...baseInput,
      id: randomUUID(),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.campaign.id).toBe(first.campaign.id);

    await expect(
      repository.createIdempotent({
        ...baseInput,
        id: randomUUID(),
        creationRequestHash: "different-request-hash",
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("responds to the readiness ping after migration", async () => {
    await expect(repository.ping()).resolves.toBeUndefined();
  });

  it("refuses to delete a campaign that has eligibility records", async () => {
    const campaignId = await createCampaign();
    await new PostgresEligibilityRepository(database.db).recordIdempotent({
      id: randomUUID(),
      campaignId,
      participantKey: "f".repeat(64),
      claimantAddress: "0x" + "1".repeat(40),
      provider: "world_id",
      verifiedAt: new Date("2026-10-05T10:20:00.000Z"),
      expiresAt: new Date("2026-10-05T11:20:00.000Z"),
    });

    await expect(
      database.db.delete(campaigns).where(eq(campaigns.id, campaignId)),
    ).rejects.toThrow();
  });

  async function createCampaign(): Promise<string> {
    const id = randomUUID();
    const createdAt = new Date("2026-10-05T10:00:00.000Z");

    await repository.createIdempotent({
      id,
      chainId: 84532,
      advertiserAddress: "0x" + "2".repeat(40),
      creationIdempotencyKey: `contract-${id}`,
      creationRequestHash: `hash-${id}`,
      contentUrl: "https://example.com/contract",
      rewardAtomic: "1000000",
      maxCompletions: 10,
      startAt: new Date("2026-10-05T10:15:00.000Z"),
      endAt: new Date("2026-10-05T11:15:00.000Z"),
      status: "draft",
      createdAt,
      updatedAt: createdAt,
      mission: testMission(),
    });

    return id;
  }

  async function missionIdFor(campaignId: string): Promise<string> {
    const mission = await repository.getMission(campaignId);

    if (!mission) {
      throw new Error("Campaign has no mission");
    }

    return mission.id;
  }

  it("stores the mission atomically and keeps it immutable", async () => {
    const campaignId = await createCampaign();
    const mission = await repository.getMission(campaignId);

    expect(mission).toMatchObject({
      campaignId,
      version: 1,
      kind: "comprehension_check",
      answerKey: { q1: "a" },
      passThreshold: 1,
    });

    await expect(
      database.db
        .update(missions)
        .set({ answerKey: { q1: "b" } })
        .where(eq(missions.campaignId, campaignId)),
    ).rejects.toThrow();
  });

  describe("eligibility + submission persistence", () => {
    const eligibilityRepository = new PostgresEligibilityRepository(
      database.db,
    );

    definePersistenceContract(() => ({
      eligibility: eligibilityRepository,
      submissions: new PostgresSubmissionRepository(database.db),
      createCampaign,
      missionIdFor,
    }));
  });
});
