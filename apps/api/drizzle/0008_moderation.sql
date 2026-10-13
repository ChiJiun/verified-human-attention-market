CREATE TABLE "campaign_moderation" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaign_moderation_status_check" CHECK ("campaign_moderation"."status" IN ('pending_review', 'approved', 'rejected', 'taken_down'))
);
--> statement-breakpoint
CREATE TABLE "campaign_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "campaign_reports_reason_check" CHECK ("campaign_reports"."reason" IN ('phishing', 'malware', 'scam', 'misleading', 'offensive', 'broken_link', 'other')),
	CONSTRAINT "campaign_reports_status_check" CHECK ("campaign_reports"."status" IN ('open', 'dismissed', 'actioned')),
	CONSTRAINT "campaign_reports_details_length" CHECK ("campaign_reports"."details" IS NULL OR char_length("campaign_reports"."details") <= 500)
);
--> statement-breakpoint
CREATE TABLE "moderation_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"report_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "moderation_actions_action_check" CHECK ("moderation_actions"."action" IN ('approve', 'reject', 'take_down', 'reinstate', 'resolve_report')),
	CONSTRAINT "moderation_actions_reason_length" CHECK (char_length("moderation_actions"."reason") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "campaign_moderation" ADD CONSTRAINT "campaign_moderation_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_reports" ADD CONSTRAINT "campaign_reports_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_report_id_campaign_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."campaign_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_moderation_status_idx" ON "campaign_moderation" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaign_reports_status_idx" ON "campaign_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "campaign_reports_campaign_idx" ON "campaign_reports" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "moderation_actions_campaign_idx" ON "moderation_actions" USING btree ("campaign_id","created_at");--> statement-breakpoint
-- Custom: the operator audit trail is append-only (issue #24).
CREATE FUNCTION "moderation_actions_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'moderation_actions is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "moderation_actions_append_only" BEFORE UPDATE OR DELETE ON "moderation_actions" FOR EACH ROW EXECUTE FUNCTION "moderation_actions_reject_change"();--> statement-breakpoint
-- Custom: settlement facts of a submission cannot be rewritten or deleted
-- (issue #24). Claim fields (reissue) and claimant_address (retention, #22)
-- may still change.
CREATE FUNCTION "submissions_protect_settlement"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'submissions cannot be deleted';
	END IF;
	IF NEW.result IS DISTINCT FROM OLD.result
		OR NEW.rejection_code IS DISTINCT FROM OLD.rejection_code
		OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
		OR NEW.eligibility_id IS DISTINCT FROM OLD.eligibility_id
		OR NEW.mission_id IS DISTINCT FROM OLD.mission_id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'submission results are immutable';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "submissions_settlement_immutable" BEFORE UPDATE OR DELETE ON "submissions" FOR EACH ROW EXECUTE FUNCTION "submissions_protect_settlement"();
