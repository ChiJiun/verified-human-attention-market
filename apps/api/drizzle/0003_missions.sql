CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"campaign_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text DEFAULT 'comprehension_check' NOT NULL,
	"content_url" text NOT NULL,
	"questions" jsonb NOT NULL,
	"answer_key" jsonb NOT NULL,
	"pass_threshold" integer NOT NULL,
	"definition_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "missions_version_positive" CHECK ("missions"."version" >= 1),
	CONSTRAINT "missions_pass_threshold_positive" CHECK ("missions"."pass_threshold" >= 1)
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "mission_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "missions_campaign_version_uq" ON "missions" USING btree ("campaign_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "missions_id_campaign_uq" ON "missions" USING btree ("id","campaign_id");--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_mission_campaign_fk" FOREIGN KEY ("mission_id","campaign_id") REFERENCES "public"."missions"("id","campaign_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Custom: mission definitions are immutable once written (issue #15).
-- A changed mission must be inserted as a new version.
CREATE FUNCTION "missions_reject_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'missions are immutable; insert a new version instead';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "missions_immutable" BEFORE UPDATE ON "missions" FOR EACH ROW EXECUTE FUNCTION "missions_reject_update"();
