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
