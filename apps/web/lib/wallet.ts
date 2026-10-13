import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type EIP1193Provider,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";

import { chain } from "./config";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface Wallet {
  address: Address;
  chainId: number;
  walletClient: WalletClient;
  publicClient: PublicClient;
}

export function injectedProvider(): EIP1193Provider | null {
  return typeof window !== "undefined" && window.ethereum
    ? window.ethereum
    : null;
}

export async function connectWallet(): Promise<Wallet> {
  const provider = injectedProvider();

  if (!provider) {
    throw new Error("No browser wallet found. Install a wallet extension.");
  }

  const walletClient = createWalletClient({
    chain,
    transport: custom(provider),
  });
  const [address] = await walletClient.requestAddresses();

  if (!address) {
    throw new Error("The wallet did not return an account.");
  }

  return {
    address,
    chainId: await walletClient.getChainId(),
    walletClient,
    publicClient: createPublicClient({ chain, transport: custom(provider) }),
  };
}

export type TxOutcome =
  | { kind: "confirmed"; hash: Hash }
  | { kind: "reverted"; hash: Hash }
  /** No receipt yet: the transaction may still be mined. Never resend. */
  | { kind: "pending"; hash: Hash };

export async function waitForTx(
  publicClient: PublicClient,
  hash: Hash,
  timeoutMs = 120_000,
): Promise<TxOutcome> {
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: timeoutMs,
    });
    return {
      kind: receipt.status === "success" ? "confirmed" : "reverted",
      hash,
    };
  } catch {
    return { kind: "pending", hash };
  }
}
