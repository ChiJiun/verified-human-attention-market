ALTER TABLE "reconciliation_state" DROP CONSTRAINT "reconciliation_state_pkey";--> statement-breakpoint
ALTER TABLE "chain_events" ADD COLUMN "contract_address" text NOT NULL;--> statement-breakpoint
ALTER TABLE "chain_events" ADD COLUMN "onchain_campaign_id" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "reconciliation_state" ADD COLUMN "contract_address" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_state" ADD COLUMN "latest_confirmed_block_hash" text;--> statement-breakpoint
ALTER TABLE "reconciliation_state" ADD CONSTRAINT "reconciliation_state_chain_id_contract_address_pk" PRIMARY KEY("chain_id","contract_address");--> statement-breakpoint
CREATE INDEX "chain_events_campaign_idx" ON "chain_events" USING btree ("chain_id","contract_address","onchain_campaign_id");--> statement-breakpoint
ALTER TABLE "chain_events" ADD CONSTRAINT "chain_events_confirmation_status_check" CHECK ("chain_events"."confirmation_status" IN ('observed', 'confirmed', 'orphaned'));
