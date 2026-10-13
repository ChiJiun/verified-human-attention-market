import { and, asc, eq, isNull } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { apiClients } from "../db/schema.js";

/** Scopes an API key can hold (#26). Admin and key management are never scopes. */
export const API_SCOPES = ["campaigns:write", "analytics:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export type ApiEnvironment = "sandbox" | "live";

export interface ApiClientRecord {
  id: string;
  name: string;
  advertiserAddress: string;
  keyPrefix: string;
  scopes: ApiScope[];
  environment: ApiEnvironment;
  rateLimitPerMinute: number;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

export interface NewApiClient extends Omit<
  ApiClientRecord,
  "revokedAt" | "revokedBy" | "revokedReason"
> {
  /** sha256 of the key; the key itself is never stored. */
  keyHash: string;
}

export interface ApiClientRepository {
  create(client: NewApiClient): Promise<ApiClientRecord>;
  /** Active (unrevoked) client for a key hash. */
  findActiveByKeyHash(keyHash: string): Promise<ApiClientRecord | null>;
  getById(id: string): Promise<ApiClientRecord | null>;
  listByAdvertiser(address: string): Promise<ApiClientRecord[]>;
  countActiveByAdvertiser(address: string): Promise<number>;
  /** Idempotent: revoking a revoked client keeps the first revocation. */
  revoke(
    id: string,
    by: string,
    reason: string,
    at: Date,
  ): Promise<ApiClientRecord | null>;
}

type Row = typeof apiClients.$inferSelect;

const toRecord = (row: Row): ApiClientRecord => ({
  id: row.id,
  name: row.name,
  advertiserAddress: row.advertiserAddress,
  keyPrefix: row.keyPrefix,
  scopes: row.scopes as ApiScope[],
  environment: row.environment as ApiEnvironment,
  rateLimitPerMinute: row.rateLimitPerMinute,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
  revokedBy: row.revokedBy,
  revokedReason: row.revokedReason,
});

export class InMemoryApiClientRepository implements ApiClientRepository {
  private readonly rows = new Map<
    string,
    NewApiClient & {
      revokedAt: Date | null;
      revokedBy: string | null;
      revokedReason: string | null;
    }
  >();

  async create(client: NewApiClient): Promise<ApiClientRecord> {
    const row = {
      ...client,
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    };
    this.rows.set(client.id, row);
    return this.strip(row);
  }

  async findActiveByKeyHash(keyHash: string): Promise<ApiClientRecord | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.keyHash === keyHash && !candidate.revokedAt,
    );
    return row ? this.strip(row) : null;
  }

  async getById(id: string): Promise<ApiClientRecord | null> {
    const row = this.rows.get(id);
    return row ? this.strip(row) : null;
  }

  async listByAdvertiser(address: string): Promise<ApiClientRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.advertiserAddress === address)
      .map((row) => this.strip(row));
  }

  async countActiveByAdvertiser(address: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.advertiserAddress === address && !row.revokedAt,
    ).length;
  }

  async revoke(
    id: string,
    by: string,
    reason: string,
    at: Date,
  ): Promise<ApiClientRecord | null> {
    const row = this.rows.get(id);
    if (!row) return null;
    if (!row.revokedAt) {
      row.revokedAt = at;
      row.revokedBy = by;
      row.revokedReason = reason;
    }
    return this.strip(row);
  }

  private strip(
    row: NewApiClient & {
      revokedAt: Date | null;
      revokedBy: string | null;
      revokedReason: string | null;
    },
  ): ApiClientRecord {
    const { keyHash: _keyHash, ...record } = row;
    void _keyHash;
    return { ...record, scopes: [...record.scopes] };
  }
}

export class PostgresApiClientRepository implements ApiClientRepository {
  constructor(private readonly db: Database) {}

  async create(client: NewApiClient): Promise<ApiClientRecord> {
    const [row] = await this.db.insert(apiClients).values(client).returning();
    return toRecord(row!);
  }

  async findActiveByKeyHash(keyHash: string): Promise<ApiClientRecord | null> {
    const [row] = await this.db
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.keyHash, keyHash), isNull(apiClients.revokedAt)))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async getById(id: string): Promise<ApiClientRecord | null> {
    const [row] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async listByAdvertiser(address: string): Promise<ApiClientRecord[]> {
    const rows = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.advertiserAddress, address))
      .orderBy(asc(apiClients.createdAt));
    return rows.map(toRecord);
  }

  async countActiveByAdvertiser(address: string): Promise<number> {
    const rows = await this.db
      .select({ id: apiClients.id })
      .from(apiClients)
      .where(
        and(
          eq(apiClients.advertiserAddress, address),
          isNull(apiClients.revokedAt),
        ),
      );
    return rows.length;
  }

  async revoke(
    id: string,
    by: string,
    reason: string,
    at: Date,
  ): Promise<ApiClientRecord | null> {
    await this.db
      .update(apiClients)
      .set({ revokedAt: at, revokedBy: by, revokedReason: reason })
      .where(and(eq(apiClients.id, id), isNull(apiClients.revokedAt)));
    return this.getById(id);
  }
}
