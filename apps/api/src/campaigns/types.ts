import type { MissionDefinition } from "../missions/types.js";

/**
 * draft            off-chain only
 * pending_onchain  linked to an on-chain campaign that is not funded yet
 * active/closed/settled/cancelled  mirror confirmed on-chain events (#16)
 * expired          time-derived; kept for API compatibility
 */
export type CampaignStatus =
  | "draft"
  | "pending_onchain"
  | "active"
  | "closed"
  | "expired"
  | "settled"
  | "cancelled";

/**
 * A campaign linked on a CampaignManager other than the configured one (for
 * example before a redeploy, ADR-0011) is retired here: its rewards can only
 * be signed for and paid on that old contract, so it must not accept new
 * World ID verifications or completions. `null` = no chain configured.
 */
export function isRetiredDeployment(
  campaign: Pick<
    CampaignRecord,
    "onchainCampaignId" | "onchainContractAddress"
  >,
  campaignManagerAddress: string | null,
): boolean {
  return (
    campaign.onchainCampaignId !== null &&
    campaign.onchainContractAddress !== campaignManagerAddress?.toLowerCase()
  );
}

export interface CampaignRecord {
  id: string;
  chainId: number;
  onchainCampaignId: string | null;
  /** Lowercase CampaignManager address of the on-chain id (ADR-0011). */
  onchainContractAddress: string | null;
  /** Transaction that created the on-chain campaign, once linked. */
  publishTxHash: string | null;
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
