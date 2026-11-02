/**
 * Which CampaignManager deployment a campaign link belongs to (ADR-0011).
 *
 * On-chain campaign ids restart at 1 on every deployment, and the same
 * address can exist on several chains, so a link is only meaningful for the
 * exact (chainId, contractAddress) it was made on. The API uses this to
 * retire campaigns of other deployments; the web app uses it before funding.
 */

export interface Deployment {
  chainId: number;
  contractAddress: string;
}

/**
 * True only when the link was made on `current`: same chain and same
 * contract. An unlinked campaign (`contractAddress: null`) or a missing chain
 * configuration (`current: null`) is never "current".
 */
export function isCurrentDeployment(
  link: { chainId: number; contractAddress: string | null },
  current: Deployment | null,
): boolean {
  return (
    current !== null &&
    link.contractAddress !== null &&
    link.chainId === current.chainId &&
    link.contractAddress.toLowerCase() === current.contractAddress.toLowerCase()
  );
}

/**
 * What the advertiser's wallet reads on-chain right before it funds, closes or
 * refunds: the contract's `campaignIdByDraft(advertiser, draftRef)` and
 * `campaigns(id)`.
 */
export interface DraftCampaignReading {
  mappedCampaignId: bigint;
  onchain: {
    rewardPerCompletion: bigint;
    maxCompletions: number;
    startTime: bigint;
    endTime: bigint;
  };
}

/** The draft as the API describes it. */
export interface DraftCampaignExpectation {
  onchainCampaignId: string;
  rewardPerCompletion: string;
  maxCompletions: number;
  /** ISO timestamps. */
  startAt: string;
  endAt: string;
}

/**
 * True only if the on-chain id still belongs to this draft and carries its
 * parameters. After a deep reorg another draft of the same advertiser can
 * hold the same id with the same budget; funding, closing or refunding it
 * would act on the wrong campaign (ADR-0011).
 */
export function isDraftCampaign(
  reading: DraftCampaignReading,
  expected: DraftCampaignExpectation,
): boolean {
  const seconds = (iso: string) => BigInt(Math.floor(Date.parse(iso) / 1000));
  return (
    reading.mappedCampaignId !== 0n &&
    reading.mappedCampaignId === BigInt(expected.onchainCampaignId) &&
    reading.onchain.rewardPerCompletion ===
      BigInt(expected.rewardPerCompletion) &&
    reading.onchain.maxCompletions === expected.maxCompletions &&
    reading.onchain.startTime === seconds(expected.startAt) &&
    reading.onchain.endTime === seconds(expected.endAt)
  );
}
