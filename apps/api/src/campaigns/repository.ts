import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { campaigns, missions } from "../db/schema.js";
import type { MissionRecord } from "../missions/types.js";
import { IdempotencyConflictError } from "../persistence/errors.js";
import type {
  CampaignRecord,
  CampaignStatus,
  CreateCampaignRecord,
} from "./types.js";

export interface IdempotentCampaignResult {
  campaign: CampaignRecord;
  created: boolean;
}

export { IdempotencyConflictError };

export interface CampaignRepository {
  createIdempotent(
    input: CreateCampaignRecord,
  ): Promise<IdempotentCampaignResult>;
  getById(id: string): Promise<CampaignRecord | null>;
  /** Latest mission version for the campaign. */
  getMission(campaignId: string): Promise<MissionRecord | null>;
  ping(): Promise<void>;
}

function toMissionRecord(
  campaignId: string,
  mission: CreateCampaignRecord["mission"],
  createdAt: Date,
): MissionRecord {
  return {
    ...mission.definition,
    id: mission.id,
    campaignId,
    version: 1,
    kind: "comprehension_check",
    definitionHash: mission.definitionHash,
    createdAt,
  };
}

function mapMission(row: typeof missions.$inferSelect): MissionRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    version: row.version,
    kind: "comprehension_check",
    contentUrl: row.contentUrl,
    questions: row.questions,
    answerKey: row.answerKey,
    passThreshold: row.passThreshold,
    definitionHash: row.definitionHash,
    createdAt: row.createdAt,
  };
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
    const { mission, ...campaignValues } = input;

    const inserted = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(campaigns)
        .values({
          ...campaignValues,
          onchainCampaignId: null,
        })
        .onConflictDoNothing({
          target: [
            campaigns.advertiserAddress,
            campaigns.creationIdempotencyKey,
          ],
        })
        .returning();

      if (!row) {
        return null;
      }

      const missionRecord = toMissionRecord(row.id, mission, row.createdAt);
      await tx.insert(missions).values({
        id: missionRecord.id,
        campaignId: missionRecord.campaignId,
        version: missionRecord.version,
        kind: missionRecord.kind,
        contentUrl: missionRecord.contentUrl,
        questions: missionRecord.questions,
        answerKey: missionRecord.answerKey,
        passThreshold: missionRecord.passThreshold,
        definitionHash: missionRecord.definitionHash,
        createdAt: missionRecord.createdAt,
      });

      return row;
    });

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

  async getMission(campaignId: string): Promise<MissionRecord | null> {
    const [row] = await this.db
      .select()
      .from(missions)
      .where(eq(missions.campaignId, campaignId))
      .orderBy(desc(missions.version))
      .limit(1);

    return row ? mapMission(row) : null;
  }

  async ping(): Promise<void> {
    await this.db.select({ id: campaigns.id }).from(campaigns).limit(1);
  }
}

export class InMemoryCampaignRepository implements CampaignRepository {
  private readonly records = new Map<string, CampaignRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly missionsByCampaign = new Map<string, MissionRecord>();

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

    const { mission, ...campaignValues } = input;
    const record: CampaignRecord = {
      ...campaignValues,
      onchainCampaignId: null,
    };

    this.records.set(record.id, record);
    this.missionsByCampaign.set(
      record.id,
      toMissionRecord(record.id, mission, record.createdAt),
    );
    this.idempotency.set(scopedKey, record.id);

    return {
      campaign: record,
      created: true,
    };
  }

  async getById(id: string): Promise<CampaignRecord | null> {
    return this.records.get(id) ?? null;
  }

  async getMission(campaignId: string): Promise<MissionRecord | null> {
    return this.missionsByCampaign.get(campaignId) ?? null;
  }

  async ping(): Promise<void> {}
}
