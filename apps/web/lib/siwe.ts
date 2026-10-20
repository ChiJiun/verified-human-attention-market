import type { Address, WalletClient } from "viem";
import { createSiweMessage } from "viem/siwe";

import { api, ApiError } from "./api";
import { chainId } from "./config";
import type { Wallet } from "./wallet";

export interface Session {
  address: string;
  expiresAt: string;
}

/** EIP-4361 sign-in; the API verifies domain, chain, nonce and signature. */
export async function signInWithEthereum(
  walletClient: WalletClient,
  address: Address,
): Promise<Session> {
  const { data } = await api<{ nonce: string }>("/v1/auth/nonce", {
    method: "POST",
  });
  const message = createSiweMessage({
    address,
    chainId,
    domain: window.location.host,
    uri: window.location.origin,
    version: "1",
    nonce: data.nonce,
    issuedAt: new Date(),
    statement: "Sign in to Verified Human Attention Market.",
  });
  const signature = await walletClient.signMessage({
    account: address,
    message,
  });
  const verified = await api<Session>("/v1/auth/verify", {
    method: "POST",
    body: { message, signature, transport: "cookie" },
  });

  return { address: verified.data.address, expiresAt: verified.data.expiresAt };
}

export async function restoreSession(): Promise<Session | null> {
  try {
    const { data } = await api<Session>("/v1/auth/session");
    return { address: data.address, expiresAt: data.expiresAt };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function signOut(): Promise<void> {
  await api("/v1/auth/logout", { method: "POST" });
}

export function sessionForWallet(
  session: Session | null,
  wallet: Pick<Wallet, "address"> | null,
): Session | null {
  return session !== null &&
    wallet !== null &&
    session.address === wallet.address.toLowerCase()
    ? session
    : null;
}
