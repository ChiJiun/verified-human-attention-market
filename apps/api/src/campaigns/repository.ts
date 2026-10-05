import { and, eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { campaigns } from "../db/schema.js";
import type {
  CampaignRecord,
  CampaignStatus,
  CreateCampaignRecord,
} from "./types.js";

export interface IdempotentCampaignResult {
  campaign: CampaignRecord;
  created: boolean;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export interface CampaignRepository {
  createIdempotent(
    input: CreateCampaignRecord,
  ): Promise<IdempotentCampaignResult>;
  getById(id: string): Promise<CampaignRecord | null>;
  ping(): Promise<void>;
}

function mapCampaign(row: typeof campaigns.$inferSelect): CampaignRecord {
  return {
    id: row.id,
    chainId: row.chainId,
    onchainCampaignId: row.onchainCampaignId,
    advertiserAddress: row.advertiserAddress,
    creationIdempotencyKey: row.creationIdempotencyKey,
    creationRequestHash: row.creationRequestHash,
    contentUrl: row.contentUrl,
    rewardAtomic: row.rewardAtomic,
    maxCompletions: row.maxCompletions,
    startAt: row.startAt,
    endAt: row.endAt,
    status: row.status as CampaignStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresCampaignRepository implements CampaignRepository {
  constructor(private readonly db: Database) {}

  async createIdempotent(
    input: CreateCampaignRecord,
  ): Promise<IdempotentCampaignResult> {
    const [inserted] = await this.db
      .insert(campaigns)
      .values({
        ...input,
        onchainCampaignId: null,
      })
      .onConflictDoNothing({
        target: [campaigns.advertiserAddress, campaigns.creationIdempotencyKey],
      })
      .returning();

    if (inserted) {
      return {
        campaign: mapCampaign(inserted),
        created: true,
      };
    }

    const [existing] = await this.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.advertiserAddress, input.advertiserAddress),
          eq(campaigns.creationIdempotencyKey, input.creationIdempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new Error("Idempotent campaign insert could not be reconciled");
    }

    if (existing.creationRequestHash !== input.creationRequestHash) {
      throw new IdempotencyConflictError();
    }

    return {
      campaign: mapCampaign(existing),
      created: false,
    };
  }

  async getById(id: string): Promise<CampaignRecord | null> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, id))
      .limit(1);

    return row ? mapCampaign(row) : null;
  }

  async ping(): Promise<void> {
    await this.db.select({ id: campaigns.id }).from(campaigns).limit(1);
  }
}

export class InMemoryCampaignRepository implements CampaignRepository {
  private readonly records = new Map<string, CampaignRecord>();
  private readonly idempotency = new Map<string, string>();

  async createIdempotent(
    input: CreateCampaignRecord,
  ): Promise<IdempotentCampaignResult> {
    const scopedKey = `${input.advertiserAddress}:${input.creationIdempotencyKey}`;
    const existingId = this.idempotency.get(scopedKey);

    if (existingId) {
      const existing = this.records.get(existingId);

      if (!existing) {
        throw new Error("In-memory idempotency index is inconsistent");
      }

      if (existing.creationRequestHash !== input.creationRequestHash) {
        throw new IdempotencyConflictError();
      }

      return {
        campaign: existing,
        created: false,
      };
    }

    const record: CampaignRecord = {
      ...input,
      onchainCampaignId: null,
    };

    this.records.set(record.id, record);
    this.idempotency.set(scopedKey, record.id);

    return {
      campaign: record,
      created: true,
    };
  }

  async getById(id: string): Promise<CampaignRecord | null> {
    return this.records.get(id) ?? null;
  }

  async ping(): Promise<void> {}
}
