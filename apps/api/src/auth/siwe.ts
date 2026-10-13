import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { FastifyRequest } from "fastify";
import { verifyMessage, type Address, type Hex } from "viem";
import {
  generateSiweNonce,
  parseSiweMessage,
  validateSiweMessage,
} from "viem/siwe";

import type { AuthRepository, AuthSession } from "./repository.js";

/** Resolves the signed-in wallet for a request, or null. */
export type Authenticate = (
  request: FastifyRequest,
) => Promise<AuthSession | null>;

/**
 * Verifies an EIP-191 signature. The default handles EOAs offline; with an
 * RPC client, smart-contract wallets (ERC-1271 / ERC-6492) are supported.
 */
export type SignatureVerifier = (input: {
  address: Address;
  message: string;
  signature: Hex;
}) => Promise<boolean>;

export const verifyEoaSignature: SignatureVerifier = (input) =>
  verifyMessage(input);

export interface SiweConfig {
  /** RFC 3986 authority the web app is served from, e.g. app.example.com */
  domain: string;
  chainId: number;
  nonceTtlMs?: number;
  sessionTtlMs?: number;
  /** Tolerated client clock skew for `issuedAt`. */
  clockSkewMs?: number;
}

export interface SiweDependencies {
  repository: AuthRepository;
  /** null when SIWE_DOMAIN is not configured: sign-in fails closed. */
  config: SiweConfig | null;
  verifySignature: SignatureVerifier;
  now: () => Date;
}

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function issueNonce(dependencies: SiweDependencies) {
  const now = dependencies.now();
  const nonce = generateSiweNonce();
  const expiresAt = new Date(
    now.getTime() + (dependencies.config?.nonceTtlMs ?? 10 * 60_000),
  );

  await dependencies.repository.createNonce(nonce, now, expiresAt);

  return { nonce, expiresAt };
}

export type SignInFailure =
  | "AUTH_NOT_CONFIGURED"
  | "INVALID_MESSAGE"
  | "WRONG_DOMAIN"
  | "WRONG_CHAIN"
  | "MESSAGE_NOT_VALID_NOW"
  | "INVALID_SIGNATURE"
  | "NONCE_INVALID_OR_USED";

export type SignInOutcome =
  | { ok: true; token: string; session: AuthSession }
  | { ok: false; status: number; code: SignInFailure };

/**
 * EIP-4361 sign-in. The message must be bound to our domain and chain, be
 * valid now, carry a nonce we issued, and be signed by its address. The nonce
 * is consumed atomically so a captured message cannot be replayed.
 */
export async function signIn(
  dependencies: SiweDependencies,
  input: { message: string; signature: Hex },
): Promise<SignInOutcome> {
  const { config } = dependencies;

  if (!config) {
    return { ok: false, status: 503, code: "AUTH_NOT_CONFIGURED" };
  }

  const now = dependencies.now();
  let parsed: ReturnType<typeof parseSiweMessage>;

  try {
    parsed = parseSiweMessage(input.message);
  } catch {
    return { ok: false, status: 400, code: "INVALID_MESSAGE" };
  }

  if (
    !parsed.address ||
    !parsed.nonce ||
    !parsed.domain ||
    !parsed.uri ||
    parsed.version !== "1" ||
    !parsed.issuedAt ||
    parsed.chainId === undefined ||
    // viem parses unknown timestamps into Invalid Date; reject them.
    [parsed.issuedAt, parsed.expirationTime, parsed.notBefore].some(
      (date) => date !== undefined && Number.isNaN(date.getTime()),
    )
  ) {
    return { ok: false, status: 400, code: "INVALID_MESSAGE" };
  }

  if (parsed.domain !== config.domain) {
    return { ok: false, status: 401, code: "WRONG_DOMAIN" };
  }

  if (parsed.chainId !== config.chainId) {
    return { ok: false, status: 401, code: "WRONG_CHAIN" };
  }

  const skew = config.clockSkewMs ?? 60_000;
  if (
    parsed.issuedAt.getTime() > now.getTime() + skew ||
    !validateSiweMessage({ message: parsed, domain: config.domain, time: now })
  ) {
    return { ok: false, status: 401, code: "MESSAGE_NOT_VALID_NOW" };
  }

  let signatureValid = false;
  try {
    signatureValid = await dependencies.verifySignature({
      address: parsed.address,
      message: input.message,
      signature: input.signature,
    });
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return { ok: false, status: 401, code: "INVALID_SIGNATURE" };
  }

  if (!(await dependencies.repository.consumeNonce(parsed.nonce, now))) {
    return { ok: false, status: 401, code: "NONCE_INVALID_OR_USED" };
  }

  const token = randomBytes(32).toString("base64url");
  const sessionTtl = config.sessionTtlMs ?? 12 * 60 * 60_000;
  const expiry = new Date(now.getTime() + sessionTtl);
  const expiresAt =
    parsed.expirationTime && parsed.expirationTime < expiry
      ? parsed.expirationTime
      : expiry;
  const session: AuthSession = {
    sessionId: randomUUID(),
    address: parsed.address.toLowerCase(),
    chainId: parsed.chainId,
    expiresAt,
  };

  await dependencies.repository.createSession({
    ...session,
    tokenHash: hashToken(token),
    createdAt: now,
  });

  return { ok: true, token, session };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;

  if (typeof header !== "string") {
    return null;
  }

  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  return match ? match[1]! : null;
}

/** Default authenticator: bearer token → stored, unexpired session. */
export function sessionAuthenticator(
  repository: AuthRepository,
  now: () => Date,
): Authenticate {
  return async (request) => {
    const token = bearerToken(request);
    return token ? repository.findSession(hashToken(token), now()) : null;
  };
}
