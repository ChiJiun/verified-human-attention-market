import type { MissionDefinition } from "../missions/types.js";

export type CampaignStatus =
  "draft" | "active" | "closed" | "expired" | "settled";

export interface CampaignRecord {
  id: string;
  chainId: number;
  onchainCampaignId: string | null;
  advertiserAddress: string;
  creationIdempotencyKey: string;
  creationRequestHash: string;
  contentUrl: string;
  rewardAtomic: string;
  maxCompletions: number;
  startAt: Date;
  endAt: Date;
  status: CampaignStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewCampaignMission {
  id: string;
  definition: MissionDefinition;
  definitionHash: string;
}

export interface CreateCampaignRecord {
  id: string;
  chainId: number;
  advertiserAddress: string;
  creationIdempotencyKey: string;
  creationRequestHash: string;
  contentUrl: string;
  rewardAtomic: string;
  maxCompletions: number;
  startAt: Date;
  endAt: Date;
  status: "draft";
  createdAt: Date;
  updatedAt: Date;
  /** Version 1 of the campaign's mission, written atomically with it. */
  mission: NewCampaignMission;
}
