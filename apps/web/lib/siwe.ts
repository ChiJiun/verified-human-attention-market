import type { Address, WalletClient } from "viem";
import { createSiweMessage } from "viem/siwe";

import { api } from "./api";
import { chainId } from "./config";

export interface Session {
  token: string;
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
    body: { message, signature },
  });

  return verified.data;
}
