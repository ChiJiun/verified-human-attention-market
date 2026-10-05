import { PostgresCampaignRepository } from "./campaigns/repository.js";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const chainId = Number(process.env.EVM_CHAIN_ID ?? 84532);

if (!Number.isSafeInteger(chainId) || chainId <= 0) {
  throw new Error("EVM_CHAIN_ID must be a positive safe integer");
}

const database = createDatabase(databaseUrl);
const campaignRepository = new PostgresCampaignRepository(database.db);

const app = buildApp({
  campaignRepository,
  chainId,
  close: database.close,
});

const port = Number(process.env.API_PORT ?? 3001);

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
