import type { FastifyRequest } from "fastify";

/** Route ids (campaigns, submissions, eligibilities, reports, API clients). */
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A 20-byte EVM address in any letter case; compare it lowercased. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** 32 bytes as 0x-prefixed hex in any letter case: hashes, keys, ABI words. */
export const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;

/** The `Idempotency-Key` header when it is a 1–200 character string. */
export function readIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length >= 1 && key.length <= 200
    ? key
    : null;
}
