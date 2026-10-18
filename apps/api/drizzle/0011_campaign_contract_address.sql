DROP INDEX "campaigns_chain_onchain_id_uq";--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "onchain_contract_address" text;--> statement-breakpoint
-- ADR-0011: rows linked before this migration cannot tell which deployment their
-- on-chain id belongs to. Mark them so they never match a configured contract
-- (no status sync, no claims, no analytics events) instead of guessing.
UPDATE "campaigns" SET "onchain_contract_address" = 'pre-adr-0011' WHERE "onchain_campaign_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_chain_contract_onchain_id_uq" ON "campaigns" USING btree ("chain_id","onchain_contract_address","onchain_campaign_id");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_onchain_link_check" CHECK (("campaigns"."onchain_campaign_id" IS NULL) = ("campaigns"."onchain_contract_address" IS NULL));