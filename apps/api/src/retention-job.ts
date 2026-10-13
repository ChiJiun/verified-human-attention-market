import { createDatabase } from "./db/client.js";
import { applyRetention, eraseWallet } from "./privacy/retention.js";

/**
 * Retention enforcement (#22). Idempotent; schedule it at least daily.
 *
 *   pnpm --filter @vham/api retention
 *   pnpm --filter @vham/api retention --erase-wallet 0xabc…
 *
 * Prints counts only, never identifiers.
 */

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const eraseIndex = process.argv.indexOf("--erase-wallet");
const wallet = eraseIndex === -1 ? null : process.argv[eraseIndex + 1];

if (eraseIndex !== -1 && !wallet) {
  throw new Error("--erase-wallet requires an address");
}

const database = createDatabase(databaseUrl);

try {
  const now = new Date();
  const result = wallet
    ? await eraseWallet(database.db, wallet, now)
    : await applyRetention(database.db, now);

  console.log(
    JSON.stringify({
      level: "info",
      time: now.toISOString(),
      msg: wallet ? "wallet erasure applied" : "retention applied",
      ...result,
    }),
  );
} finally {
  await database.close();
}
