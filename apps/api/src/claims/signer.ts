import { randomBytes } from "node:crypto";

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CLAIM_TYPES = {
  ClaimAuthorization: [
    { name: "campaignId", type: "uint256" },
    { name: "claimant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const CLAIM_DOMAIN_NAME = "Verified Human Attention Market";
export const CLAIM_DOMAIN_VERSION = "1";
export const MAX_CLAIM_TTL_SECONDS = 900;

export interface ClaimPayload {
  campaignId: bigint;
  claimant: Address;
  amount: bigint;
  nonce: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
}

export interface SignedClaim {
  payload: ClaimPayload;
  signature: Hex;
  chainId: number;
  contractAddress: Address;
}

export interface ClaimSigner {
  readonly address: Address;
  sign(input: {
    campaignId: bigint;
    claimant: Address;
    amount: bigint;
    chainId: number;
    contractAddress: Address;
    issuedAt: bigint;
  }): Promise<SignedClaim>;
}

/** The private key stays in the server process and is never included in errors. */
export function createClaimSigner(privateKey: string): ClaimSigner {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("CLAIM_SIGNER_PRIVATE_KEY must be a 32-byte hex key");
  }

  const account = privateKeyToAccount(privateKey as Hex);

  return {
    address: account.address,
    async sign(input) {
      const payload: ClaimPayload = {
        campaignId: input.campaignId,
        claimant: input.claimant,
        amount: input.amount,
        nonce: `0x${randomBytes(32).toString("hex")}`,
        issuedAt: input.issuedAt,
        expiresAt: input.issuedAt + BigInt(MAX_CLAIM_TTL_SECONDS),
      };
      const signature = await account.signTypedData({
        domain: {
          name: CLAIM_DOMAIN_NAME,
          version: CLAIM_DOMAIN_VERSION,
          chainId: input.chainId,
          verifyingContract: input.contractAddress,
        },
        types: CLAIM_TYPES,
        primaryType: "ClaimAuthorization",
        message: payload,
      });

      return {
        payload,
        signature,
        chainId: input.chainId,
        contractAddress: input.contractAddress,
      };
    },
  };
}
