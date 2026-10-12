ALTER TABLE "campaigns" ADD COLUMN "publish_tx_hash" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_status_check" CHECK ("campaigns"."status" IN ('draft', 'pending_onchain', 'active', 'closed', 'expired', 'settled', 'cancelled'));
