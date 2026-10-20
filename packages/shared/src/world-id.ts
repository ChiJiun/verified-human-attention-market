import {
  bytesToHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  type Hex,
} from "viem";

const DOMAIN = "vham:world-id-signal:v2";
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export type WorldIdSignalSalt = Hex & { readonly __brand: "WorldIdSignalSalt" };
export type WorldIdSignal = Hex & { readonly __brand: "WorldIdSignal" };

export function isWorldIdSignalSalt(
  value: unknown,
): value is WorldIdSignalSalt {
  return typeof value === "string" && BYTES32.test(value);
}

export function isWorldIdSignal(value: unknown): value is WorldIdSignal {
  return typeof value === "string" && BYTES32.test(value);
}

export function newWorldIdSignalSalt(): WorldIdSignalSalt {
  return bytesToHex(
    crypto.getRandomValues(new Uint8Array(32)),
  ) as WorldIdSignalSalt;
}

export interface WorldIdSignalInput {
  campaignId: string;
  claimant: string;
  salt: WorldIdSignalSalt;
}

export function worldIdSignal(input: WorldIdSignalInput): WorldIdSignal {
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
