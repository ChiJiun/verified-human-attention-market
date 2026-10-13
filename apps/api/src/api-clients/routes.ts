import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { AuthSession } from "../auth/repository.js";
import { bearerToken, type Authenticate } from "../auth/siwe.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import {
  API_SCOPES,
  type ApiClientRecord,
  type ApiClientRepository,
  type ApiEnvironment,
  type ApiScope,
} from "./repository.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set when the request authenticated with an API key (#26). */
    apiClient?: ApiClientRecord | undefined;
  }
}

export interface RateLimitConfig {
  /** Per IP, all routes without an API key. */
  anonymousPerMinute: number;
  /** Per IP and route, for sign-in, eligibility and reports. */
  sensitivePerMinute: number;
  /** Default and maximum per API client. */
  defaultClientPerMinute: number;
  maxClientPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  anonymousPerMinute: 300,
  sensitivePerMinute: 30,
  defaultClientPerMinute: 600,
  maxClientPerMinute: 6_000,
};

export const MAX_ACTIVE_CLIENTS_PER_ADVERTISER = 10;

const API_KEY = /^vhamk_(test|live)_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Routes an API key may call, with the scope each needs. */
const SCOPED_ROUTES: Record<string, ApiScope> = {
  "POST /v1/campaigns": "campaigns:write",
  "POST /v1/campaigns/:id/publish": "campaigns:write",
  "POST /v1/campaigns/:id/onchain": "campaigns:write",
  "GET /v1/campaigns/:id/analytics": "analytics:read",
};

/** Never reachable with an API key: operators, key management, sessions. */
const KEY_FORBIDDEN_PREFIXES = ["/v1/admin", "/v1/api-clients", "/v1/auth"];

const SENSITIVE_ROUTES = new Set([
  "POST /v1/auth/nonce",
  "POST /v1/auth/verify",
  "POST /v1/campaigns/:id/eligibility/verify",
  "POST /v1/campaigns/:id/reports",
]);

const EXEMPT_PREFIXES = ["/health/", "/metrics"];

export const hashApiKey = (key: string) =>
  createHash("sha256").update(key).digest("hex");

export function apiClientSession(
  client: ApiClientRecord,
  chainId: number,
): AuthSession {
  return {
    sessionId: `api-client:${client.id}`,
    address: client.advertiserAddress,
    chainId,
    expiresAt: new Date("9999-12-31T23:59:59.000Z"),
  };
}

function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.status(status).send({
    error: { code, message, requestId: request.id },
  });
}

/**
 * Resolves API keys, enforces their route/scope boundaries, and applies rate
 * limits before any handler runs.
 */
export function registerApiClientGate(
  app: FastifyInstance,
  dependencies: {
    clients: ApiClientRepository;
    environment: ApiEnvironment;
    rateLimits: RateLimitConfig | null;
    /** Reverse proxies in front of the API that append x-forwarded-for. */
    trustProxyHops: number;
    metrics: MetricsRegistry;
    now: () => Date;
  },
) {
  const limiter = new FixedWindowRateLimiter();

  /**
   * Client address for per-IP limits. Each trusted proxy appends the address
   * it saw, so the client is the entry `trustProxyHops` from the end; entries
   * further left are caller-controlled and ignored.
   */
  function clientIp(request: FastifyRequest): string {
    const hops = dependencies.trustProxyHops;
    const header = request.headers["x-forwarded-for"];

    if (hops <= 0 || typeof header !== "string") {
      return request.ip;
    }

    const chain = header
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return chain[chain.length - hops] ?? request.ip;
  }
  const limited = dependencies.metrics.counter(
    "vham_rate_limited_total",
    "Requests rejected with 429 by bucket",
  );
  const clientRequests = dependencies.metrics.counter(
    "vham_api_client_requests_total",
    "Requests authenticated with an API key, by client id",
  );

  function enforce(
    request: FastifyRequest,
    reply: FastifyReply,
    bucket: string,
    key: string,
    limit: number,
  ): boolean {
    const decision = limiter.check(key, limit, dependencies.now());
    reply.header("ratelimit-limit", decision.limit);
    reply.header("ratelimit-remaining", decision.remaining);
    reply.header("ratelimit-reset", decision.resetSeconds);

    if (decision.allowed) {
      return true;
    }

    limited.inc({ bucket });
    reply.header("retry-after", decision.resetSeconds);
    void fail(
      request,
      reply,
      429,
      "RATE_LIMITED",
      `Too many requests; retry in ${decision.resetSeconds}s`,
    );
    return false;
  }

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";

    if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return;
    }

    const route = request.routeOptions.url;
    const key = `${request.method} ${route ?? "unmatched"}`;
    const token = bearerToken(request);
    const { rateLimits } = dependencies;

    if (token?.startsWith("vhamk_")) {
      const client = API_KEY.test(token)
        ? await dependencies.clients.findActiveByKeyHash(hashApiKey(token))
        : null;

      if (!client) {
        return fail(
          request,
          reply,
          401,
          "INVALID_API_KEY",
          "Unknown or revoked API key",
        );
      }

      if (client.environment !== dependencies.environment) {
        return fail(
          request,
          reply,
          401,
          "API_KEY_WRONG_ENVIRONMENT",
          `This is a ${client.environment} key; this API is ${dependencies.environment}`,
        );
      }

      if (
        route === undefined ||
        KEY_FORBIDDEN_PREFIXES.some((prefix) => route.startsWith(prefix))
      ) {
        return fail(
          request,
          reply,
          403,
          "API_KEY_NOT_ALLOWED",
          "API keys cannot call this endpoint",
        );
      }

      const scope = SCOPED_ROUTES[key];
      if (scope && !client.scopes.includes(scope)) {
        return fail(
          request,
          reply,
          403,
          "INSUFFICIENT_SCOPE",
          `This API key lacks the ${scope} scope`,
        );
      }

      request.apiClient = client;
      request.log = request.log.child({ apiClientId: client.id });
      clientRequests.inc({ client: client.id });

      if (
        rateLimits &&
        !enforce(
          request,
          reply,
          "client",
          `client:${client.id}`,
          client.rateLimitPerMinute,
        )
      ) {
        return reply;
      }

      return;
    }

    if (!rateLimits) {
      return;
    }

    if (
      !enforce(
        request,
        reply,
        "ip",
        `ip:${clientIp(request)}`,
        rateLimits.anonymousPerMinute,
      )
    ) {
      return reply;
    }

    if (
      SENSITIVE_ROUTES.has(key) &&
      !enforce(
        request,
        reply,
        "sensitive",
        `sensitive:${clientIp(request)}:${key}`,
        rateLimits.sensitivePerMinute,
      )
    ) {
      return reply;
    }
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z
    .array(z.enum(API_SCOPES))
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, "duplicate"),
  rateLimitPerMinute: z.number().int().positive().optional(),
});

const revokeSchema = z.object({ reason: z.string().trim().min(1).max(500) });

function serialize(client: ApiClientRecord) {
  return {
    id: client.id,
    name: client.name,
    keyPrefix: client.keyPrefix,
    scopes: client.scopes,
    environment: client.environment,
    rateLimitPerMinute: client.rateLimitPerMinute,
    createdAt: client.createdAt.toISOString(),
    revokedAt: client.revokedAt?.toISOString() ?? null,
  };
}

/** Key management: SIWE sessions only (API keys are blocked by the gate). */
export async function registerApiClientRoutes(
  app: FastifyInstance,
  dependencies: {
    clients: ApiClientRepository;
    authenticate: Authenticate;
    environment: ApiEnvironment;
    operators: readonly string[];
    rateLimits: RateLimitConfig;
    now: () => Date;
  },
) {
  const { clients } = dependencies;

  async function session(request: FastifyRequest, reply: FastifyReply) {
    const current = await dependencies.authenticate(request);
    if (!current) {
      await fail(request, reply, 401, "UNAUTHENTICATED", "Sign in first");
    }
    return current;
  }

  app.post("/v1/api-clients", async (request, reply) => {
    const owner = await session(request, reply);
    if (!owner) return reply;

    const parsed = createSchema.safeParse(request.body);
    const rateLimit =
      parsed.success && parsed.data.rateLimitPerMinute !== undefined
        ? parsed.data.rateLimitPerMinute
        : dependencies.rateLimits.defaultClientPerMinute;

    if (
      !parsed.success ||
      rateLimit > dependencies.rateLimits.maxClientPerMinute
    ) {
      return fail(
        request,
        reply,
        400,
        "INVALID_API_CLIENT",
        "Invalid API client",
      );
    }

    if (
      (await clients.countActiveByAdvertiser(owner.address)) >=
      MAX_ACTIVE_CLIENTS_PER_ADVERTISER
    ) {
      return fail(
        request,
        reply,
        409,
        "API_CLIENT_LIMIT_REACHED",
        `At most ${MAX_ACTIVE_CLIENTS_PER_ADVERTISER} active API clients`,
      );
    }

    const key = `vhamk_${dependencies.environment === "live" ? "live" : "test"}_${randomBytes(32).toString("base64url")}`;
    const client = await clients.create({
      id: randomUUID(),
      name: parsed.data.name,
      advertiserAddress: owner.address,
      keyPrefix: key.slice(0, 14),
      keyHash: hashApiKey(key),
      scopes: parsed.data.scopes,
      environment: dependencies.environment,
      rateLimitPerMinute: rateLimit,
      createdAt: dependencies.now(),
    });

    request.log.warn(
      {
        audit: "api_client_created",
        apiClientId: client.id,
        advertiser: owner.address,
      },
      "API client created",
    );

    // The key is returned exactly once.
    return reply.status(201).send({ ...serialize(client), key });
  });

  app.get("/v1/api-clients", async (request, reply) => {
    const owner = await session(request, reply);
    if (!owner) return reply;

    return {
      items: (await clients.listByAdvertiser(owner.address)).map(serialize),
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/api-clients/:id",
    async (request, reply) => {
      const owner = await session(request, reply);
      if (!owner) return reply;

      const client = UUID.test(request.params.id)
        ? await clients.getById(request.params.id)
        : null;

      if (!client || client.advertiserAddress !== owner.address) {
        return fail(request, reply, 404, "API_CLIENT_NOT_FOUND", "Not found");
      }

      await clients.revoke(
        client.id,
        `advertiser:${owner.address}`,
        "revoked by owner",
        dependencies.now(),
      );
      request.log.warn(
        {
          audit: "api_client_revoked",
          apiClientId: client.id,
          by: owner.address,
        },
        "API client revoked",
      );
      return reply.status(204).send();
    },
  );

  // Abuse path: operators can revoke any client (#26, #24 roles).
  app.post<{ Params: { id: string } }>(
    "/v1/admin/api-clients/:id/revoke",
    async (request, reply) => {
      const operator = await session(request, reply);
      if (!operator) return reply;

      if (!dependencies.operators.includes(operator.address)) {
        return fail(request, reply, 403, "NOT_OPERATOR", "Not an operator");
      }

      const parsed = revokeSchema.safeParse(request.body);
      if (!parsed.success || !UUID.test(request.params.id)) {
        return fail(
          request,
          reply,
          400,
          "INVALID_ACTION",
          "A reason is required",
        );
      }

      const client = await clients.revoke(
        request.params.id,
        `operator:${operator.address}`,
        parsed.data.reason,
        dependencies.now(),
      );

      if (!client) {
        return fail(request, reply, 404, "API_CLIENT_NOT_FOUND", "Not found");
      }

      request.log.warn(
        {
          audit: "api_client_revoked",
          apiClientId: client.id,
          by: operator.address,
        },
        "API client revoked by operator",
      );
      return serialize(client);
    },
  );
}
