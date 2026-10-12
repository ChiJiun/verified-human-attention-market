import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { campaigns, missions } from "../db/schema.js";
import type { MissionRecord } from "../missions/types.js";
import {
  IdempotencyConflictError,
  uniqueViolationConstraint,
} from "../persistence/errors.js";
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

export type LinkConflictCode =
  /** This draft is already linked to a different on-chain campaign. */
  | "ALREADY_LINKED"
  /** That on-chain campaign is already linked to a different draft. */
  | "ONCHAIN_CAMPAIGN_ALREADY_LINKED";

export class CampaignLinkConflictError extends Error {
  constructor(readonly code: LinkConflictCode) {
    super(`Campaign link conflict: ${code}`);
    this.name = "CampaignLinkConflictError";
  }
}

export interface OnchainLink {
  onchainCampaignId: string;
  publishTxHash: string | null;
  status: CampaignStatus;
  updatedAt: Date;
}

export interface CampaignRepository {
  createIdempotent(
    input: CreateCampaignRecord,
  ): Promise<IdempotentCampaignResult>;
  getById(id: string): Promise<CampaignRecord | null>;
  /** Latest mission version for the campaign. */
  getMission(campaignId: string): Promise<MissionRecord | null>;
  /**
   * Links a draft to its canonical on-chain campaign. Idempotent for the
   * same on-chain id; throws CampaignLinkConflictError otherwise.
   */
  linkOnchain(id: string, link: OnchainLink): Promise<CampaignRecord>;
  updateStatus(
    id: string,
    status: CampaignStatus,
    updatedAt: Date,
  ): Promise<void>;
  listLinked(chainId: number): Promise<CampaignRecord[]>;
  findByOnchainId(
    chainId: number,
    onchainCampaignId: string,
  ): Promise<CampaignRecord | null>;
  listUnlinkedDrafts(
    chainId: number,
    advertiserAddress: string,
  ): Promise<CampaignRecord[]>;
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
    publishTxHash: row.publishTxHash,
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
          publishTxHash: null,
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

  async linkOnchain(id: string, link: OnchainLink): Promise<CampaignRecord> {
    let row: typeof campaigns.$inferSelect | undefined;

    try {
      [row] = await this.db
        .update(campaigns)
        .set({
          onchainCampaignId: link.onchainCampaignId,
          publishTxHash: link.publishTxHash,
          status: link.status,
          updatedAt: link.updatedAt,
        })
        .where(and(eq(campaigns.id, id), isNull(campaigns.onchainCampaignId)))
        .returning();
    } catch (error) {
      if (
        uniqueViolationConstraint(error) === "campaigns_chain_onchain_id_uq"
      ) {
        throw new CampaignLinkConflictError("ONCHAIN_CAMPAIGN_ALREADY_LINKED");
      }
      throw error;
    }

    if (row) {
      return mapCampaign(row);
    }

    const existing = await this.getById(id);

    if (!existing) {
      throw new Error("Campaign not found");
    }

    if (existing.onchainCampaignId !== link.onchainCampaignId) {
      throw new CampaignLinkConflictError("ALREADY_LINKED");
    }

    return existing;
  }

  async updateStatus(
    id: string,
    status: CampaignStatus,
    updatedAt: Date,
  ): Promise<void> {
    await this.db
      .update(campaigns)
      .set({ status, updatedAt })
      .where(eq(campaigns.id, id));
  }

  async listLinked(chainId: number): Promise<CampaignRecord[]> {
    const rows = await this.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.chainId, chainId),
          isNotNull(campaigns.onchainCampaignId),
        ),
      );

    return rows.map(mapCampaign);
  }

  async findByOnchainId(
    chainId: number,
    onchainCampaignId: string,
  ): Promise<CampaignRecord | null> {
    const [row] = await this.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.chainId, chainId),
          eq(campaigns.onchainCampaignId, onchainCampaignId),
        ),
      )
      .limit(1);

    return row ? mapCampaign(row) : null;
  }

  async listUnlinkedDrafts(
    chainId: number,
    advertiserAddress: string,
  ): Promise<CampaignRecord[]> {
    const rows = await this.db
      .select()
      .from(campaigns)
      .where(
        and(
          eq(campaigns.chainId, chainId),
          eq(campaigns.advertiserAddress, advertiserAddress.toLowerCase()),
          isNull(campaigns.onchainCampaignId),
        ),
      );

    return rows.map(mapCampaign);
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
      publishTxHash: null,
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

  async linkOnchain(id: string, link: OnchainLink): Promise<CampaignRecord> {
    const existing = this.records.get(id);

    if (!existing) {
      throw new Error("Campaign not found");
    }

    if (existing.onchainCampaignId !== null) {
      if (existing.onchainCampaignId !== link.onchainCampaignId) {
        throw new CampaignLinkConflictError("ALREADY_LINKED");
      }
      return existing;
    }

    for (const record of this.records.values()) {
      if (
        record.chainId === existing.chainId &&
        record.onchainCampaignId === link.onchainCampaignId
      ) {
        throw new CampaignLinkConflictError("ONCHAIN_CAMPAIGN_ALREADY_LINKED");
      }
    }

    const updated: CampaignRecord = {
      ...existing,
      onchainCampaignId: link.onchainCampaignId,
      publishTxHash: link.publishTxHash,
      status: link.status,
      updatedAt: link.updatedAt,
    };
    this.records.set(id, updated);

    return updated;
  }

  async updateStatus(
    id: string,
    status: CampaignStatus,
    updatedAt: Date,
  ): Promise<void> {
    const existing = this.records.get(id);

    if (existing) {
      this.records.set(id, { ...existing, status, updatedAt });
    }
  }

  async listLinked(chainId: number): Promise<CampaignRecord[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.chainId === chainId && record.onchainCampaignId !== null,
    );
  }

  async findByOnchainId(
    chainId: number,
    onchainCampaignId: string,
  ): Promise<CampaignRecord | null> {
    return (
      [...this.records.values()].find(
        (record) =>
          record.chainId === chainId &&
          record.onchainCampaignId === onchainCampaignId,
      ) ?? null
    );
  }

  async listUnlinkedDrafts(
    chainId: number,
    advertiserAddress: string,
  ): Promise<CampaignRecord[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.chainId === chainId &&
        record.advertiserAddress === advertiserAddress.toLowerCase() &&
        record.onchainCampaignId === null,
    );
  }

  async ping(): Promise<void> {}
}
