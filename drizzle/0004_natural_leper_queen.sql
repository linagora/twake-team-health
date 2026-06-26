ALTER TABLE "member_repo_month" ADD COLUMN "fetched_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_month" ADD COLUMN "fetched_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "review_repo_month" ADD COLUMN "fetched_at" timestamp with time zone DEFAULT now() NOT NULL;