import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { fail } from "../errors/catalog.js";

import {
  CLEARED_SESSION_COOKIE,
  csrfRejected,
  presentedCredentials,
  provenSameOrigin,
  sessionCookie,
} from "./credential.js";
import type { AuthSession } from "./repository.js";
import {
  hashToken,
  issueNonce,
  signIn,
  type Authenticate,
  type SiweDependencies,
} from "./siwe.js";

const verifySchema = z.object({
  message: z.string().min(1).max(4_000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  transport: z.enum(["bearer", "cookie"]).default("bearer"),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: SiweDependencies & {
    authenticate: Authenticate;
    webOrigin: string | null;
  },
) {
  async function revokeSessions(tokens: string[]) {
    const now = dependencies.now();
    await Promise.all(
      tokens.map((token) =>
        dependencies.repository.revokeSession(hashToken(token), now),
      ),
    );
  }

  app.post("/v1/auth/nonce", async (_request, reply) => {
    const { nonce, expiresAt } = await issueNonce(dependencies);
    return reply.send({ nonce, expiresAt: expiresAt.toISOString() });
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);

    if (!parsed.success) {
      return fail(
        request,
        reply,
        400,
        "INVALID_SIGN_IN_REQUEST",
        "message and signature are required",
      );
    }

    const { message, signature, transport } = parsed.data;

    if (
      transport === "cookie" &&
      !provenSameOrigin(request.headers, dependencies.webOrigin)
    ) {
      return csrfRejected(request, reply);
    }

    const outcome = await signIn(dependencies, {
      message,
      signature: signature as `0x${string}`,
    });

    if (!outcome.ok) {
      return fail(
        request,
        reply,
        outcome.status,
        outcome.code,
        "Sign-in failed",
      );
    }

    const { session } = outcome;
    const body = {
      address: session.address,
      chainId: session.chainId,
      expiresAt: session.expiresAt.toISOString(),
    };

    if (transport === "cookie") {
      await revokeSessions(presentedCredentials(request.headers).cookieTokens);
      const maxAge = Math.max(
        1,
        Math.ceil(
          (session.expiresAt.getTime() - dependencies.now().getTime()) / 1000,
        ),
      );
      return reply
        .header("set-cookie", sessionCookie(outcome.token, maxAge))
        .header("cache-control", "no-store")
        .send({ transport: "cookie", ...body });
    }

    return reply.send({ token: outcome.token, tokenType: "Bearer", ...body });
  });

  app.get("/v1/auth/session", async (request, reply) => {
    reply.header("cache-control", "no-store");

    if (presentedCredentials(request.headers).credential.kind === "none") {
      return reply.status(204).send();
    }

    const session = await dependencies.authenticate(request);

    if (!session) {
      return unauthorized(request, reply);
    }

    return reply.send({
      address: session.address,
      chainId: session.chainId,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const { credential, carriesSessionCookie, cookieTokens } =
      presentedCredentials(request.headers);
    const tokens =
      credential.kind === "session" && credential.source === "header"
        ? [credential.token, ...cookieTokens]
        : cookieTokens;
    await revokeSessions(tokens);

    if (carriesSessionCookie) {
      reply.header("set-cookie", CLEARED_SESSION_COOKIE);
    }

    return reply.status(204).send();
  });
}

function unauthorized(request: FastifyRequest, reply: FastifyReply) {
  const { credential } = presentedCredentials(request.headers);

  if (
    (credential.kind === "session" || credential.kind === "unreadable") &&
    credential.source === "cookie"
  ) {
    reply.header("set-cookie", CLEARED_SESSION_COOKIE);
  }

  return fail(
    request,
    reply,
    401,
    "UNAUTHENTICATED",
    "Sign in with Ethereum is required",
  );
}

/**
 * Advertiser-only guard: returns the session when the signed-in wallet is
 * `advertiserAddress`; otherwise sends 401/403 and returns null.
 */
export async function requireWallet(
  authenticate: Authenticate,
  request: FastifyRequest,
  reply: FastifyReply,
  advertiserAddress: string,
): Promise<AuthSession | null> {
  const session = await authenticate(request);

  if (!session) {
    await unauthorized(request, reply);
    return null;
  }

  if (session.address !== advertiserAddress.toLowerCase()) {
    await fail(
      request,
      reply,
      403,
      "NOT_CAMPAIGN_ADVERTISER",
      "The signed-in wallet is not this campaign's advertiser",
    );
    return null;
  }

  return session;
}
