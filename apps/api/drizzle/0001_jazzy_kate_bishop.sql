ALTER TABLE "campaigns" ADD COLUMN "creation_idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "creation_request_hash" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_advertiser_idempotency_uq" ON "campaigns" USING btree ("advertiser_address","creation_idempotency_key");