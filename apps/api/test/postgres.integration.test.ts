import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IdempotencyConflictError,
  PostgresCampaignRepository,
} from "../src/campaigns/repository.js";
import { createDatabase } from "../src/db/client.js";
import { campaigns } from "../src/db/schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("PostgresCampaignRepository", () => {
  if (!databaseUrl) {
    return;
  }

  const database = createDatabase(databaseUrl);
  const repository = new PostgresCampaignRepository(database.db);

  beforeAll(async () => {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });

    await database.db.delete(campaigns);
  });

  afterAll(async () => {
    await database.db.delete(campaigns);
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
});
