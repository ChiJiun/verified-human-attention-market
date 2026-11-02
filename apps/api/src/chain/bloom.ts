import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";

/**
 * The Ethereum logs bloom of a block header (yellow paper, `M3:2048`),
 * evaluated locally (issue #102).
 *
 * Every log of a block adds its address and each of its topics to the
 * header's 2048-bit `logsBloom`: a value sets the three bits selected by the
 * low 11 bits of the first three big-endian byte pairs of its keccak256
 * hash, bit 0 being the last bit of the last byte. A value whose bits are
 * not all set is in no log of the block; a value whose bits are all set may
 * still be in none (a false positive), so a "maybe" must be confirmed by
 * reading the block's logs.
 */

const BLOOM_BYTES = 256;
const BLOOM_HEX = /^0x[0-9a-f]{512}$/;

/** [byte index, bit mask] of the three bits a value sets. */
type BloomBits = readonly (readonly [number, number])[];

function bloomBits(value: string): BloomBits {
  const hash = hexToBytes(keccak256(value as Hex));
  const bits: [number, number][] = [];

  for (let pair = 0; pair < 6; pair += 2) {
    const bit = ((hash[pair]! << 8) | hash[pair + 1]!) & 0x7ff;
    bits.push([BLOOM_BYTES - 1 - (bit >> 3), 1 << (bit & 7)]);
  }

  return bits;
}

const hasBits = (bloom: Uint8Array, bits: BloomBits) =>
  bits.every(([index, mask]) => (bloom[index]! & mask) !== 0);

/** The header's bloom as bytes, or null unless it is exactly 256 bytes. */
export function parseBloom(logsBloom: string): Uint8Array | null {
  const hex = logsBloom.toLowerCase();
  return BLOOM_HEX.test(hex) ? hexToBytes(hex as Hex) : null;
}

/** Whether `value` (a 20-byte address or a 32-byte topic) may be in it. */
export function bloomContains(bloom: Uint8Array, value: string): boolean {
  return hasBits(bloom, bloomBits(value));
}

/**
 * A precomputed test for "may hold a log of `address` whose first topic is
 * one of `topics`" (what `eth_getLogs({ address, topics: [topics] })`
 * selects): the address and at least one of the topics are in the bloom.
 */
export function bloomMatcher(
  address: string,
  topics: readonly string[],
): (bloom: Uint8Array) => boolean {
  const addressBits = bloomBits(address);
  const topicBits = topics.map(bloomBits);

  return (bloom) =>
    hasBits(bloom, addressBits) &&
    topicBits.some((bits) => hasBits(bloom, bits));
}

/** The bloom a block holding exactly `logs` has, as 0x hex. */
export function logsBloom(
  logs: readonly { address: string; topics: readonly string[] }[],
): string {
  const bloom = new Uint8Array(BLOOM_BYTES);

  for (const log of logs) {
    for (const value of [log.address, ...log.topics]) {
      for (const [index, mask] of bloomBits(value)) {
        bloom[index] = (bloom[index] ?? 0) | mask;
      }
    }
  }

  return bytesToHex(bloom);
}
