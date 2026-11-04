import { getSupportedChain, SUPPORTED_CHAINS } from "@vham/shared/chains";
import { formatUnits, type Chain } from "viem";
import { baseSepolia, foundry } from "viem/chains";

/** viem's definition of each chain in @vham/shared's supported list. */
const VIEM_CHAINS: Readonly<Record<number, Chain>> = {
  [baseSepolia.id]: baseSepolia,
  [foundry.id]: foundry,
};

/**
 * The settlement chain NEXT_PUBLIC_CHAIN_ID names, Base Sepolia when it is
 * unset. Any other value that is not a chain in @vham/shared's supported list
 * throws, so the advertiser and mission pages fail to render (a 500 from
 * `next start`, which the CSP smoke checks) instead of pointing the wallet at
 * Base Sepolia while the network check and SIWE use the configured id. The
 * API's EVM_CHAIN_ID is checked against the same list at startup (#19).
 */
export function resolveChain(configured: string | undefined): Chain {
  const value = configured ?? String(baseSepolia.id);
  const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const supported = getSupportedChain(id);
  const resolved = supported ? VIEM_CHAINS[supported.chainId] : undefined;

  if (!resolved) {
    throw new Error(
      `NEXT_PUBLIC_CHAIN_ID must be one of ${Object.keys(SUPPORTED_CHAINS).join(", ")}, got "${value}"`,
    );
  }
  return resolved;
}

/** Settlement chain the web app expects the wallet to be on. */
export const chain: Chain = resolveChain(process.env.NEXT_PUBLIC_CHAIN_ID);

export const USDC_DECIMALS = 6;

/** An amount in USDC atomic units as the pages show it, e.g. "1.5 USDC". */
export function formatUsdc(atomic: string): string {
  return `${formatUnits(BigInt(atomic), USDC_DECIMALS)} USDC`;
}
