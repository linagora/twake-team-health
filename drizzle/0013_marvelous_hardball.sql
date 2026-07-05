ALTER TABLE "repo_sync" ADD COLUMN "review_backfilled_from" text;--> statement-breakpoint
ALTER TABLE "review_fact" ADD COLUMN "is_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_fact" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "review_fact" ADD COLUMN "comments_count" integer DEFAULT 0 NOT NULL;