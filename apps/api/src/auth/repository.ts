import { and, eq, gt, isNull } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { authNonces, authSessions } from "../db/schema.js";

export interface AuthSession {
  sessionId: string;
  /** Lowercase EVM address proven by the SIWE signature. */
  address: string;
  chainId: number;
  expiresAt: Date;
}

export interface NewSession extends AuthSession {
  /** sha256 of the bearer token; the token itself is never stored. */
  tokenHash: string;
  createdAt: Date;
}

export interface AuthRepository {
  createNonce(nonce: string, createdAt: Date, expiresAt: Date): Promise<void>;
  /** Atomically marks an unexpired, unused nonce as used. */
  consumeNonce(nonce: string, now: Date): Promise<boolean>;
  createSession(session: NewSession): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<AuthSession | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly db: Database) {}

  async createNonce(
    nonce: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    await this.db.insert(authNonces).values({ nonce, createdAt, expiresAt });
  }

  async consumeNonce(nonce: string, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(authNonces)
      .set({ consumedAt: now })
      .where(
        and(
          eq(authNonces.nonce, nonce),
          isNull(authNonces.consumedAt),
          gt(authNonces.expiresAt, now),
        ),
      )
      .returning({ nonce: authNonces.nonce });

    return rows.length === 1;
  }

  async createSession(session: NewSession): Promise<void> {
    await this.db.insert(authSessions).values({
      id: session.sessionId,
      tokenHash: session.tokenHash,
      address: session.address,
      chainId: session.chainId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
    });
  }

  async findSession(tokenHash: string, now: Date): Promise<AuthSession | null> {
    const [row] = await this.db
      .select()
      .from(authSessions)
      .where(
        and(
          eq(authSessions.tokenHash, tokenHash),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .limit(1);

    return row
      ? {
          sessionId: row.id,
          address: row.address,
          chainId: row.chainId,
          expiresAt: row.expiresAt,
        }
      : null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(eq(authSessions.tokenHash, tokenHash));
  }
}

export class InMemoryAuthRepository implements AuthRepository {
  private readonly nonces = new Map<
    string,
    { expiresAt: Date; consumed: boolean }
  >();
  private readonly sessions = new Map<
    string,
    NewSession & { revoked: boolean }
  >();

  async createNonce(
    nonce: string,
    _createdAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    if (this.nonces.has(nonce)) {
      throw new Error("Duplicate nonce");
    }
    this.nonces.set(nonce, { expiresAt, consumed: false });
  }

  async consumeNonce(nonce: string, now: Date): Promise<boolean> {
    const record = this.nonces.get(nonce);

    if (!record || record.consumed || record.expiresAt <= now) {
      return false;
    }

    record.consumed = true;
    return true;
  }

  async createSession(session: NewSession): Promise<void> {
    this.sessions.set(session.tokenHash, { ...session, revoked: false });
  }

  async findSession(tokenHash: string, now: Date): Promise<AuthSession | null> {
    const session = this.sessions.get(tokenHash);

    if (!session || session.revoked || session.expiresAt <= now) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      address: session.address,
      chainId: session.chainId,
      expiresAt: session.expiresAt,
    };
  }

  async revokeSession(tokenHash: string): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session) {
      session.revoked = true;
    }
  }
}
