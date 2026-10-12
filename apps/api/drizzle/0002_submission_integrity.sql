ALTER TABLE "eligibility" DROP CONSTRAINT "eligibility_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "request_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "eligibility" ADD CONSTRAINT "eligibility_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_chain_onchain_id_uq" ON "campaigns" USING btree ("chain_id","onchain_campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eligibility_campaign_claimant_uq" ON "eligibility" USING btree ("campaign_id","claimant_address");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_eligibility_accepted_uq" ON "submissions" USING btree ("eligibility_id") WHERE "submissions"."result" = 'accepted';--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_claim_nonce_uq" ON "submissions" USING btree ("claim_nonce");--> statement-breakpoint
ALTER TABLE "eligibility" ADD CONSTRAINT "eligibility_participant_key_format" CHECK ("eligibility"."participant_key" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "eligibility" ADD CONSTRAINT "eligibility_claimant_address_format" CHECK ("eligibility"."claimant_address" ~ '^0x[0-9a-f]{40}$');--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_result_check" CHECK (("submissions"."result" = 'accepted' AND "submissions"."rejection_code" IS NULL) OR ("submissions"."result" = 'rejected' AND "submissions"."rejection_code" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_claimant_address_format" CHECK ("submissions"."claimant_address" ~ '^0x[0-9a-f]{40}$');
