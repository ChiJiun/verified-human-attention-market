CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"normalized_answer" jsonb NOT NULL,
	"score" numeric(10, 4)
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chain_id" bigint NOT NULL,
	"onchain_campaign_id" numeric(78, 0),
	"advertiser_address" text NOT NULL,
	"content_url" text NOT NULL,
	"reward_atomic" numeric(78, 0) NOT NULL,
	"max_completions" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"chain_id" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_hash" text NOT NULL,
	"event_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"confirmation_status" text DEFAULT 'observed' NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eligibility" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"participant_key" text NOT NULL,
	"claimant_address" text NOT NULL,
	"provider" text DEFAULT 'world_id' NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_state" (
	"chain_id" bigint PRIMARY KEY NOT NULL,
	"latest_observed_block" bigint NOT NULL,
	"latest_confirmed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"eligibility_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"claimant_address" text NOT NULL,
	"result" text NOT NULL,
	"rejection_code" text,
	"claim_nonce" text,
	"claim_issued_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility" ADD CONSTRAINT "eligibility_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_eligibility_id_eligibility_id_fk" FOREIGN KEY ("eligibility_id") REFERENCES "public"."eligibility"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answers_submission_idx" ON "answers" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "campaigns_advertiser_idx" ON "campaigns" USING btree ("advertiser_address");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_identity_uq" ON "chain_events" USING btree ("chain_id","tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "chain_events_block_idx" ON "chain_events" USING btree ("chain_id","block_number");--> statement-breakpoint
CREATE UNIQUE INDEX "eligibility_campaign_participant_uq" ON "eligibility" USING btree ("campaign_id","participant_key");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_campaign_idempotency_uq" ON "submissions" USING btree ("campaign_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "submissions_campaign_idx" ON "submissions" USING btree ("campaign_id");