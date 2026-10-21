import type { WorldIdSignal } from "@vham/shared/world-id";
import { hexToBytes, type Hex } from "viem";
import { z } from "zod";

import { hashToField } from "./rp-signature.js";

/**
 * World ID backend verification (ADR-0007).
 *
 * Verified against the official docs on 2026-10-12:
 * https://docs.world.org/world-id/idkit/integrate and
 * https://docs.world.org/world-id/reference/api
 *
 * - The IDKit result is forwarded unchanged to
 *   POST {base}/api/v4/verify/{rp_id}.
 * - Nullifiers are scoped per app + action. Using one action per campaign
 *   gives exactly the campaign-scoped duplicate-human policy we need, without
 *   any cross-campaign identifier.
 *
 * Raw proofs are never logged or persisted by this module.
 */

export type WorldIdEnvironment = "production" | "staging";

export type WorldIdFailureCode =
  | "WORLD_ID_NOT_CONFIGURED"
  | "INVALID_PROOF_PAYLOAD"
  | "ACTION_MISMATCH"
  | "ENVIRONMENT_MISMATCH"
  | "SIGNAL_MISMATCH"
  | "VERIFICATION_FAILED"
  | "PROVIDER_UNAVAILABLE";

export type WorldIdResult =
  | { ok: true; /** Decimal string. Never persisted raw. */ nullifier: string }
  | { ok: false; code: WorldIdFailureCode };

export interface WorldIdVerifier {
  verify(request: {
    action: string;
    signal: WorldIdSignal;
    idkitResponse: unknown;
  }): Promise<WorldIdResult>;
}

/** One World ID action per campaign → campaign-scoped nullifiers. */
export function campaignAction(campaignId: string): string {
  return `vham-campaign-${campaignId}`;
}

/**
 * The `signal_hash` IDKit 4.4.0 puts in a result for this signal
 * (`hashSignal` in @worldcoin/idkit-core): a 0x hex signal is hashed as
 * bytes, not as text.
 */
export function signalHash(signal: WorldIdSignal): Hex {
  return hashToField(hexToBytes(signal));
}

const responseItemV4Schema = z.looseObject({
  identifier: z.string(),
  issuer_schema_id: z.number().int(),
  nullifier: z.string().min(1),
  expires_at_min: z.number().int(),
  proof: z.array(z.string()).length(5),
  signal_hash: z.string().optional(),
});

const idkitResponseSchema = z.looseObject({
  protocol_version: z.literal("4.0"),
  action: z.string().min(1),
  environment: z.string().optional(),
  responses: z.array(responseItemV4Schema).min(1).max(10),
});

const verifyResponseSchema = z.looseObject({
  success: z.boolean(),
  environment: z.string().optional(),
  nullifier: z.string().optional(),
  results: z
    .array(
      z.looseObject({
        success: z.boolean().optional(),
        nullifier: z.string().optional(),
      }),
    )
    .optional(),
});

export function normalizeFieldElement(value: string): string | null {
  const trimmed = value.trim();

  if (!/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(trimmed)) {
    return null;
  }

  return BigInt(trimmed).toString(10);
}

export interface HttpWorldIdVerifierOptions {
  rpId: string;
  environment: WorldIdEnvironment;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpWorldIdVerifier implements WorldIdVerifier {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpWorldIdVerifierOptions) {
    if (!/^(rp|app)_[A-Za-z0-9_-]+$/.test(options.rpId)) {
      throw new Error("World ID rp_id/app_id has an unexpected format");
    }

    this.baseUrl = (options.baseUrl ?? "https://developer.world.org").replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async verify(request: {
    action: string;
    signal: WorldIdSignal;
    idkitResponse: unknown;
  }): Promise<WorldIdResult> {
    const parsed = idkitResponseSchema.safeParse(request.idkitResponse);

    if (!parsed.success) {
      return { ok: false, code: "INVALID_PROOF_PAYLOAD" };
    }

    if (parsed.data.action !== request.action) {
      return { ok: false, code: "ACTION_MISMATCH" };
    }

    if (
      (parsed.data.environment ?? "production") !== this.options.environment
    ) {
      return { ok: false, code: "ENVIRONMENT_MISMATCH" };
    }

    const expectedSignalHash = normalizeFieldElement(
      signalHash(request.signal),
    );

    if (
      !parsed.data.responses.every(
        (response) =>
          response.signal_hash !== undefined &&
          normalizeFieldElement(response.signal_hash) === expectedSignalHash,
      )
    ) {
      return { ok: false, code: "SIGNAL_MISMATCH" };
    }

    const submittedNullifiers = new Set(
      parsed.data.responses
        .map((response) => normalizeFieldElement(response.nullifier))
        .filter((value): value is string => value !== null),
    );

    let response: Response;

    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/v4/verify/${encodeURIComponent(this.options.rpId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Forwarded unchanged, as required by the World ID docs.
          body: JSON.stringify(request.idkitResponse),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    if (response.status === 400) {
      return { ok: false, code: "VERIFICATION_FAILED" };
    }

    if (!response.ok) {
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    let body: z.infer<typeof verifyResponseSchema>;

    try {
      const result = verifyResponseSchema.safeParse(await response.json());

      if (!result.success) {
        return { ok: false, code: "PROVIDER_UNAVAILABLE" };
      }

      body = result.data;
    } catch {
      return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    }

    if (body.success !== true) {
      return { ok: false, code: "VERIFICATION_FAILED" };
    }

    if (
      body.environment !== undefined &&
      body.environment !== this.options.environment
    ) {
      return { ok: false, code: "ENVIRONMENT_MISMATCH" };
    }

    const candidates = [
      ...(body.results ?? [])
        .filter((result) => result.success !== false)
        .map((result) => result.nullifier),
      body.nullifier,
    ];

    for (const candidate of candidates) {
      const normalized =
        candidate === undefined ? null : normalizeFieldElement(candidate);

      // Only accept a nullifier the user actually submitted and World verified.
      if (normalized !== null && submittedNullifiers.has(normalized)) {
        return { ok: true, nullifier: normalized };
      }
    }

    return { ok: false, code: "VERIFICATION_FAILED" };
  }
}

/** Used when World ID is not configured: eligibility is always refused. */
export class UnconfiguredWorldIdVerifier implements WorldIdVerifier {
  async verify(): Promise<WorldIdResult> {
    return { ok: false, code: "WORLD_ID_NOT_CONFIGURED" };
  }
}

/** Local anvil chain id: the only chain where simulation is allowed. */
export const LOCAL_DEV_CHAIN_ID = 31337;

/**
 * Local-development stand-in for World ID. It proves nothing about a human,
 * so its constructor refuses every chain but the local anvil chain.
 */
export class LocalSimulatedWorldIdVerifier implements WorldIdVerifier {
  constructor(chainId: number) {
    if (chainId !== LOCAL_DEV_CHAIN_ID) {
      throw new Error(
        `Simulated World ID is only allowed on the local chain ${LOCAL_DEV_CHAIN_ID}`,
      );
    }
  }

  async verify(request: {
    action: string;
    signal: WorldIdSignal;
    idkitResponse: unknown;
  }): Promise<WorldIdResult> {
    const proof = z
      .object({
        action: z.string(),
        simulatedHuman: z.string().min(1).max(100),
        signal: z.string().optional(),
      })
      .safeParse(request.idkitResponse);

    if (!proof.success) {
      return { ok: false, code: "INVALID_PROOF_PAYLOAD" };
    }

    if (proof.data.action !== request.action) {
      return { ok: false, code: "ACTION_MISMATCH" };
    }

    if (proof.data.signal?.toLowerCase() !== request.signal) {
      return { ok: false, code: "SIGNAL_MISMATCH" };
    }

    return {
      ok: true,
      nullifier: BigInt(
        `0x${Buffer.from(proof.data.simulatedHuman).toString("hex")}`,
      ).toString(10),
    };
  }
}
