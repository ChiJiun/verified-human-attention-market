import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthRepository } from "./repository.js";
import { bearerToken, hashToken, type Authenticate } from "./siwe.js";

/**
 * Browser sessions travel in this cookie (#72). Scripts keep the bearer
 * header; API keys are header-only. The `__Host-` prefix makes the browser
 * refuse the cookie unless it is Secure, has Path=/ and carries no Domain.
 */
export const SESSION_COOKIE = "__Host-vham_session";

/** randomBytes(32) in base64url (siwe.ts) is exactly 43 characters. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_METHOD = /^(GET|HEAD|OPTIONS)$/;

export interface SessionCredential {
  source: "header" | "cookie";
  token: string;
}

/**
 * The session token a request carries. An Authorization header, valid or
 * not, is the whole answer: a malformed header never falls back to the
 * cookie. Without one, exactly one well-formed session cookie counts.
 */
export function sessionCredential(
  request: FastifyRequest,
): SessionCredential | null {
  if (request.headers.authorization !== undefined) {
    const token = bearerToken(request);
    return token ? { source: "header", token } : null;
  }

  const token = sessionCookieValue(request.headers.cookie);
  return token ? { source: "cookie", token } : null;
}

function sessionCookieValue(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const values = header.split(";").flatMap((pair) => {
    const separator = pair.indexOf("=");
    return separator !== -1 &&
      pair.slice(0, separator).trim() === SESSION_COOKIE
      ? [pair.slice(separator + 1).trim()]
      : [];
  });
  const [value] = values;

  return values.length === 1 &&
    value !== undefined &&
    SESSION_TOKEN.test(value) &&
    !value.startsWith("vhamk_")
    ? value
    : null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export const CLEARED_SESSION_COOKIE = sessionCookie("", 0);

/** Default authenticator: the request's credential → stored, unexpired session. */
export function sessionAuthenticator(
  repository: AuthRepository,
  now: () => Date,
): Authenticate {
  return async (request) => {
    const credential = sessionCredential(request);
    return credential
      ? repository.findSession(hashToken(credential.token), now())
      : null;
  };
}

/**
 * Whether a cookie-authenticated mutation must be refused. Fetch Metadata
 * decides whenever the browser sends it; otherwise only an Origin equal to
 * the configured web origin passes, and without one nothing does.
 */
export function crossSite(
  headers: FastifyRequest["headers"],
  webOrigin: string | null,
): boolean {
  const site = headers["sec-fetch-site"];

  if (site !== undefined) {
    return site !== "same-origin";
  }

  return webOrigin === null || headers.origin !== webOrigin;
}

export function csrfRejected(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(403).send({
    error: {
      code: "CSRF_REJECTED",
      message: "Cookie sessions only accept same-origin requests",
      requestId: request.id,
    },
  });
}

/**
 * WEB_ORIGIN as a browser serializes `Origin`, or null when the value is not
 * an http(s) origin whose host is the SIWE domain.
 */
export function webOriginFrom(
  value: string,
  siweDomain: string | null,
): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  return /^https?:$/.test(url.protocol) &&
    url.origin === value &&
    url.host === siweDomain
    ? url.origin
    : null;
}

/**
 * Cookie-authenticated requests get CSRF protection on every unsafe method
 * and are never cacheable. Header credentials are untouched.
 */
export function registerSessionCookieGuard(
  app: FastifyInstance,
  options: { webOrigin: string | null },
) {
  app.addHook("onRequest", async (request, reply) => {
    if (
      SAFE_METHOD.test(request.method) ||
      sessionCredential(request)?.source !== "cookie"
    ) {
      return;
    }

    if (crossSite(request.headers, options.webOrigin)) {
      return csrfRejected(request, reply);
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (
      sessionCredential(request)?.source === "cookie" &&
      !reply.hasHeader("cache-control")
    ) {
      reply.header("cache-control", "no-store");
    }

    return payload;
  });
}
