CREATE TABLE "api_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"advertiser_address" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"environment" text NOT NULL,
	"rate_limit_per_minute" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	CONSTRAINT "api_clients_environment_check" CHECK ("api_clients"."environment" IN ('sandbox', 'live')),
	CONSTRAINT "api_clients_advertiser_address_format" CHECK ("api_clients"."advertiser_address" ~ '^0x[0-9a-f]{40}$'),
	CONSTRAINT "api_clients_rate_limit_positive" CHECK ("api_clients"."rate_limit_per_minute" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_clients_key_hash_uq" ON "api_clients" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_clients_advertiser_idx" ON "api_clients" USING btree ("advertiser_address");
