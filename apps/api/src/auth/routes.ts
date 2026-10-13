import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthSession } from "./repository.js";
import {
  bearerToken,
  hashToken,
  issueNonce,
  signIn,
  type Authenticate,
  type SiweDependencies,
} from "./siwe.js";

const verifySchema = z.object({
  message: z.string().min(1).max(4_000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: SiweDependencies & { authenticate: Authenticate },
) {
  app.post("/v1/auth/nonce", async (_request, reply) => {
    const { nonce, expiresAt } = await issueNonce(dependencies);
    return reply.send({ nonce, expiresAt: expiresAt.toISOString() });
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_SIGN_IN_REQUEST",
          message: "message and signature are required",
          requestId: request.id,
        },
      });
    }

    const outcome = await signIn(dependencies, {
      message: parsed.data.message,
      signature: parsed.data.signature as `0x${string}`,
    });

    if (!outcome.ok) {
      return reply.status(outcome.status).send({
        error: {
          code: outcome.code,
          message: "Sign-in failed",
          requestId: request.id,
        },
      });
    }

    return reply.send({
      token: outcome.token,
      tokenType: "Bearer",
      address: outcome.session.address,
      chainId: outcome.session.chainId,
      expiresAt: outcome.session.expiresAt.toISOString(),
    });
  });

  app.get("/v1/auth/session", async (request, reply) => {
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
    const token = bearerToken(request);

    if (token) {
      await dependencies.repository.revokeSession(
        hashToken(token),
        dependencies.now(),
      );
    }

    return reply.status(204).send();
  });
}

export function unauthorized(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(401).send({
    error: {
      code: "UNAUTHENTICATED",
      message: "Sign in with Ethereum is required",
      requestId: request.id,
    },
  });
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
    await reply.status(403).send({
      error: {
        code: "NOT_CAMPAIGN_ADVERTISER",
        message: "The signed-in wallet is not this campaign's advertiser",
        requestId: request.id,
      },
    });
    return null;
  }

  return session;
}
