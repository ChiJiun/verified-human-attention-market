import { createHmac } from "node:crypto";

import { hexToBytes, type Hex } from "viem";

import { MIN_SECRET_LENGTH } from "../privacy/participant-key.js";
import { hashToField } from "./rp-signature.js";

const DOMAIN = "vham:world-id-signal:v1";

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
