import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthRepository } from "./repository.js";
import { hashToken, SESSION_TOKEN, type Authenticate } from "./siwe.js";

/**
 * The `__Host-` prefix makes the browser refuse the cookie unless it is
 * Secure, has Path=/ and carries no Domain.
 */
export const SESSION_COOKIE = "__Host-vham_session";

const SAFE_METHOD = /^(GET|HEAD|OPTIONS)$/;
/** Key management and operator routes: the web app has no UI for them. */
const HEADER_ONLY_ROUTE = /^\/v1\/(admin|api-clients)(\/|$)/;

/**
 * What authenticates a request. An Authorization header, when present, is
 * the only thing read; otherwise the session cookie. `token` is null when the
 * presented value is not a session token.
 */
export type Credential =
  | { kind: "none" }
  | { kind: "api-key"; key: string }
  | { kind: "session"; source: "header" | "cookie"; token: string | null };

export interface PresentedCredentials {
  credential: Credential;
  /** The request sent the session cookie name, whatever its values. */
  carriesSessionCookie: boolean;
  /** The values sent under the session cookie name that are session tokens. */
  cookieTokens: string[];
}

export function presentedCredentials(
  headers: FastifyRequest["headers"],
): PresentedCredentials {
  const sessionCookies = sessionCookieValues(headers.cookie);
  return {
    credential: credentialFrom(headers.authorization, sessionCookies),
    carriesSessionCookie: sessionCookies.length > 0,
    cookieTokens: sessionCookies.filter((value) => SESSION_TOKEN.test(value)),
  };
}

function credentialFrom(
  authorization: string | undefined,
  sessionCookies: string[],
): Credential {
  if (authorization !== undefined) {
    const value = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    return value?.startsWith("vhamk_")
      ? { kind: "api-key", key: value }
      : { kind: "session", source: "header", token: sessionToken(value) };
  }

  if (sessionCookies.length === 0) {
    return { kind: "none" };
  }

  return {
    kind: "session",
    source: "cookie",
    token: sessionCookies.length === 1 ? sessionToken(sessionCookies[0]) : null,
  };
}

function sessionToken(value: string | undefined): string | null {
  return value !== undefined && SESSION_TOKEN.test(value) ? value : null;
}

function sessionCookieValues(header: string | undefined): string[] {
  return (header ?? "").split(";").flatMap((pair) => {
    const separator = pair.indexOf("=");
    return separator !== -1 &&
      pair.slice(0, separator).trim() === SESSION_COOKIE
      ? [pair.slice(separator + 1).trim()]
      : [];
  });
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export const CLEARED_SESSION_COOKIE = sessionCookie("", 0);

export function sessionAuthenticator(
  repository: AuthRepository,
  now: () => Date,
): Authenticate {
  return async (request) => {
    const { credential } = presentedCredentials(request.headers);
    return credential.kind === "session" && credential.token !== null
      ? repository.findSession(hashToken(credential.token), now())
      : null;
  };
}

export function provenSameOrigin(
  headers: FastifyRequest["headers"],
  webOrigin: string | null,
): boolean {
  const site = headers["sec-fetch-site"];

  if (site !== undefined) {
    return site === "same-origin";
  }

  return webOrigin !== null && headers.origin === webOrigin;
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

export function registerSessionCookieGuard(
  app: FastifyInstance,
  options: { webOrigin: string | null },
) {
  app.addHook("onRequest", async (request, reply) => {
    const { credential, carriesSessionCookie } = presentedCredentials(
      request.headers,
    );

    if (
      !SAFE_METHOD.test(request.method) &&
      carriesSessionCookie &&
      !provenSameOrigin(request.headers, options.webOrigin)
    ) {
      return csrfRejected(request, reply);
    }

    if (
      credential.kind === "session" &&
      credential.source === "cookie" &&
      HEADER_ONLY_ROUTE.test(request.routeOptions.url ?? "")
    ) {
      return reply.status(403).send({
        error: {
          code: "COOKIE_SESSION_NOT_ALLOWED",
          message:
            "Browser sessions cannot call this endpoint; send an Authorization header",
          requestId: request.id,
        },
      });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (
      presentedCredentials(request.headers).carriesSessionCookie &&
      !reply.hasHeader("cache-control")
    ) {
      reply.header("cache-control", "no-store");
    }

    return payload;
  });
}
