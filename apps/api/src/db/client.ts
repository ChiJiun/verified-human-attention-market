import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  drizzle,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    prepare: false,
  });
  const db = drizzle(client, { schema });

  return {
    client,
    db,
    close: async () => {
      await client.end();
    },
  };
}

export type Database = ReturnType<typeof createDatabase>["db"];

/**
 * The database or a transaction within it. Repositories built on an executor
 * run inside the caller's transaction, so two stores can be updated
 * atomically (e.g. an accepted completion and its claim authorization).
 */
export type DbExecutor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/** The caller's transaction; null for stores without transactions (memory). */
export type PersistenceScope = DbExecutor | null;
