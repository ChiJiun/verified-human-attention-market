import { randomBytes } from "node:crypto";

import {
  concat,
  hexToBytes,
  keccak256,
  numberToBytes,
  numberToHex,
  stringToBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * World ID RP request signatures for IDKit (#12, ADR-0007).
 *
 * Implements the published algorithm (checked 2026-10-13,
 * https://docs.world.org/world-id/idkit/signatures) with viem primitives —
 * Keccak-256 and EIP-191 secp256k1 signing, nothing hand-rolled — and is
 * pinned to the official test vectors in test/rp-signature.test.ts.
 *
 *   message = 0x01 ‖ nonce(32) ‖ created_at(u64 BE) ‖ expires_at(u64 BE)
 *             [‖ hash_to_field(action)(32)]
 *   sig     = EIP-191 personal_sign(message) as r ‖ s ‖ v (v = 27/28)
 */

export const RP_SIGNATURE_VERSION = 0x01;
export const DEFAULT_RP_SIGNATURE_TTL_SECONDS = 300;

/** keccak256(input) >> 8 as 32 big-endian bytes (first byte always 0x00). */
export function hashToField(input: Uint8Array): Hex {
  return numberToHex(BigInt(keccak256(input)) >> 8n, { size: 32 });
}

export function rpSignatureMessage(input: {
  nonce: Hex;
  createdAt: number;
  expiresAt: number;
  action?: string | undefined;
}): Uint8Array {
  return concat([
    new Uint8Array([RP_SIGNATURE_VERSION]),
    hexToBytes(input.nonce, { size: 32 }),
    numberToBytes(input.createdAt, { size: 8 }),
    numberToBytes(input.expiresAt, { size: 8 }),
    ...(input.action === undefined
      ? []
      : [hexToBytes(hashToField(stringToBytes(input.action)))]),
  ]);
}

export interface RpSignature {
  sig: Hex;
  nonce: Hex;
  createdAt: number;
  expiresAt: number;
}

export function createRpSigner(signingKeyHex: string) {
  const key = signingKeyHex.startsWith("0x")
    ? signingKeyHex
    : `0x${signingKeyHex}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("RP_SIGNING_KEY must be 32 bytes of hex");
  }

  const account = privateKeyToAccount(key as Hex);

  return {
    /** Public address of the RP key (registered in the Developer Portal). */
    address: account.address,
    async sign(input: {
      action?: string | undefined;
      now: Date;
      ttlSeconds?: number;
      /** 32 random bytes; injectable for test vectors. */
      random?: Uint8Array;
    }): Promise<RpSignature> {
      const nonce = hashToField(input.random ?? randomBytes(32));
      const createdAt = Math.floor(input.now.getTime() / 1000);
      const expiresAt =
        createdAt + (input.ttlSeconds ?? DEFAULT_RP_SIGNATURE_TTL_SECONDS);
      const sig = await account.signMessage({
        message: {
          raw: rpSignatureMessage({
            nonce,
            createdAt,
            expiresAt,
            action: input.action,
          }),
        },
      });

      return { sig, nonce, createdAt, expiresAt };
    },
  };
}

export type RpSigner = ReturnType<typeof createRpSigner>;
