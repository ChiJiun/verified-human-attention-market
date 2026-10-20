import type { Address, WalletClient } from "viem";
import { createSiweMessage } from "viem/siwe";

import { api, ApiError } from "./api";
import { chainId } from "./config";
import type { Wallet } from "./wallet";

export interface Session {
  address: string;
  expiresAt: string;
}

/**
 * EIP-4361 sign-in; the API verifies domain, chain, nonce and signature. The
 * result is the session the browser's cookie holds afterwards, not the
 * verify response, because a browser can refuse the cookie.
 */
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
  const verified = await api<{ transport?: unknown }>("/v1/auth/verify", {
    method: "POST",
    body: { message, signature, transport: "cookie" },
  });

  if (verified.data.transport !== "cookie") {
    throw new Error(
      "This API did not start a cookie session. Update the API and sign in again.",
    );
  }

  const session = await restoreSession();
  if (!session) {
    throw new Error(
      "This browser did not keep the session cookie. Open the site over https or on localhost, and allow cookies for it.",
    );
  }
  return session;
}

export async function restoreSession(): Promise<Session | null> {
  try {
    const { status, data } = await api<Session>("/v1/auth/session");
    return status === 204
      ? null
      : { address: data.address, expiresAt: data.expiresAt };
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
