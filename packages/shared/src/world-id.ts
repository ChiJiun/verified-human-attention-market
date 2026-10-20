/**
 * The World ID signal that binds a proof to one claimant wallet (ADR-0007,
 * update 2026-10-21). The browser draws the salt, derives the signal and
 * hands IDKit the signal; the API gets the salt with the proof and derives
 * the same signal. Nothing returns a salt, so nobody can rebuild the
 * signal_hash of an on-chain claimant from public data.
 */
import {
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Hex,
} from "viem";
import { z } from "zod";

const DOMAIN = "vham:world-id-signal:v2";
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export type WorldIdSignalSalt = Hex & { readonly __brand: "WorldIdSignalSalt" };
export type WorldIdSignal = Hex & { readonly __brand: "WorldIdSignal" };

const bytes32Schema = <T extends Hex>(name: string) =>
  z.custom<T>(
    (value) => typeof value === "string" && BYTES32.test(value),
    `${name} must be 32 bytes as 0x hex`,
  );

export const worldIdSignalSaltSchema =
  bytes32Schema<WorldIdSignalSalt>("signalSalt");
export const worldIdSignalSchema = bytes32Schema<WorldIdSignal>("signal");

export function newWorldIdSignalSalt(): WorldIdSignalSalt {
  return bytesToHex(
    crypto.getRandomValues(new Uint8Array(32)),
  ) as WorldIdSignalSalt;
}

export function worldIdSignal(input: {
  campaignId: string;
  claimant: string;
  salt: WorldIdSignalSalt;
}): WorldIdSignal {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [
        DOMAIN,
        input.campaignId.toLowerCase(),
        getAddress(input.claimant),
        input.salt,
      ],
    ),
  ) as WorldIdSignal;
}
