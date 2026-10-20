import { baseSepolia, foundry } from "viem/chains";
import type { Chain } from "viem";

const SUPPORTED: Record<number, Chain> = {
  [baseSepolia.id]: baseSepolia,
  [foundry.id]: foundry,
};

/** Settlement chain the web app expects the wallet to be on. */
export const chainId = Number(
  process.env.NEXT_PUBLIC_CHAIN_ID ?? String(baseSepolia.id),
);

export const chain: Chain = SUPPORTED[chainId] ?? baseSepolia;

/** anvil: the only chain where the API may run its World ID stand-in. */
export const isLocalChain = chainId === foundry.id;

export const USDC_DECIMALS = 6;
