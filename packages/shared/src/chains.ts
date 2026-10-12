/**
 * Supported settlement chains for the POC (ADR-0001: single chain, Base).
 *
 * Addresses were checked against official sources on 2026-10-12:
 * - Base network parameters: https://docs.base.org/base-chain/quickstart/connecting-to-base
 * - Circle USDC addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
 *
 * Base mainnet (8453) is deliberately absent until the production-readiness
 * gate (#29) is passed.
 */
export interface SupportedChain {
  chainId: number;
  name: string;
  /** Official USDC address, or null when a mock token is deployed locally. */
  usdcAddress: `0x${string}` | null;
  explorerUrl: string | null;
}

export const SUPPORTED_CHAINS: Readonly<Record<number, SupportedChain>> = {
  84532: {
    chainId: 84532,
    name: "Base Sepolia",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerUrl: "https://sepolia.basescan.org",
  },
  31337: {
    chainId: 31337,
    name: "Local Anvil",
    usdcAddress: null,
    explorerUrl: null,
  },
};

export function getSupportedChain(chainId: number): SupportedChain | null {
  return SUPPORTED_CHAINS[chainId] ?? null;
}
