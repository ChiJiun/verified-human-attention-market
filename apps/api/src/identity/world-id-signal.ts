import type { WorldIdSignal } from "@vham/shared/world-id";
import { hexToBytes, type Hex } from "viem";

import { hashToField } from "./rp-signature.js";

/**
 * The `signal_hash` IDKit 4.4.0 puts in a result for this signal
 * (`hashSignal` in @worldcoin/idkit-core): a 0x hex signal is hashed as
 * bytes, not as text.
 */
export function signalHash(signal: WorldIdSignal): Hex {
  return hashToField(hexToBytes(signal));
}
