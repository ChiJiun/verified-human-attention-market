ALTER TABLE "reconciliation_state" ADD COLUMN "halted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reconciliation_state" ADD COLUMN "halted_block" bigint;