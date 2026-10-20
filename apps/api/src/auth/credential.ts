import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthRepository } from "./repository.js";
import {
  bearerToken,
  hashToken,
  SESSION_TOKEN,
  type Authenticate,
} from "./siwe.js";

/**
 * The `__Host-` prefix makes the browser refuse the cookie unless it is
 * Secure, has Path=/ and carries no Domain.
 */
export const SESSION_COOKIE = "__Host-vham_session";

const SAFE_METHOD = /^(GET|HEAD|OPTIONS)$/;

export interface SessionCredential {
  source: "header" | "cookie";
  token: string;
}

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

function provenSameOrigin(
  headers: FastifyRequest["headers"],
  webOrigin: string | null,
): boolean {
  const site = headers["sec-fetch-site"];

  if (site !== undefined) {
    return site === "same-origin";
  }

  return webOrigin !== null && headers.origin === webOrigin;
}

function csrfRejected(request: FastifyRequest, reply: FastifyReply) {
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
    if (
      SAFE_METHOD.test(request.method) ||
      sessionCredential(request)?.source !== "cookie"
    ) {
      return;
    }

    if (!provenSameOrigin(request.headers, options.webOrigin)) {
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

export function refuseCrossSiteCookieSignIn(
  request: FastifyRequest,
  reply: FastifyReply,
  webOrigin: string | null,
): boolean {
  if (provenSameOrigin(request.headers, webOrigin)) {
    return false;
  }

  csrfRejected(request, reply);
  return true;
}
