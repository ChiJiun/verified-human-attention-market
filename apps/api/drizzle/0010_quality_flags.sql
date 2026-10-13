ALTER TABLE "submissions" ADD COLUMN "quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;
