import { createHmac } from "node:crypto";

import { hexToBytes, type Hex } from "viem";

import { MIN_SECRET_LENGTH } from "../privacy/participant-key.js";
import { hashToField } from "./rp-signature.js";

/**
 * Wallet-bound World ID signal (#71, ADR-0007 update 2026-10-20).
 *
 * The signal binds a proof to the claimant wallet, so a proof produced for
 * wallet A is refused for wallet B. It is a keyed HMAC rather than the
 * address itself: World sees hashToField(signal) in every proof, and with
 * the plain address it could match that hash against the public on-chain
 * claimants and link nullifiers to wallets. The participant-key secret is
 * reused under its own domain tag; HMAC outputs on distinct messages reveal
 * nothing about each other.
 */

const DOMAIN = "vham:world-id-signal:v1";

/** 32-byte hex signal for one (campaign, wallet); address case is ignored. */
export function worldIdSignal(
  secret: string,
  campaignId: string,
  claimant: string,
): Hex {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `World ID signal secret must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  return `0x${createHmac("sha256", secret)
    .update(`${DOMAIN}\u0000${campaignId}\u0000${claimant.toLowerCase()}`)
    .digest("hex")}`;
}

/**
 * The `signal_hash` IDKit 4.4.0 puts in a result for this signal
 * (`hashSignal` in @worldcoin/idkit-core): a 0x hex signal is hashed as
 * bytes, not as text.
 */
export function signalHash(signal: Hex): Hex {
  return hashToField(hexToBytes(signal));
}
