import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for migrations");
}

const database = createDatabase(databaseUrl);
const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

try {
  await migrate(database.db, { migrationsFolder });
} finally {
  await database.close();
}
