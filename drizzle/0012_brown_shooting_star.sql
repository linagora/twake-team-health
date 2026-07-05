CREATE TABLE "commit_fact" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"oid" text NOT NULL,
	"author_login" text,
	"author_email" text,
	"committed_date" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commit_fact_owner_repo_oid_pk" PRIMARY KEY("owner","repo","oid")
);
--> statement-breakpoint
CREATE TABLE "issue_fact" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_fact_owner_repo_number_pk" PRIMARY KEY("owner","repo","number")
);
--> statement-breakpoint
CREATE TABLE "pr_fact" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"author" text,
	"created_at" timestamp with time zone NOT NULL,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"reviews" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pr_fact_owner_repo_number_pk" PRIMARY KEY("owner","repo","number")
);
--> statement-breakpoint
CREATE TABLE "release_fact" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"tag" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "release_fact_owner_repo_tag_pk" PRIMARY KEY("owner","repo","tag")
);
--> statement-breakpoint
CREATE TABLE "repo_stock_day" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"day" text NOT NULL,
	"issues_open" integer NOT NULL,
	"bugs_open" integer NOT NULL,
	"prs_open" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_stock_day_owner_repo_day_pk" PRIMARY KEY("owner","repo","day")
);
--> statement-breakpoint
CREATE TABLE "repo_sync" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"backfilled_from" text NOT NULL,
	"activity_backfilled_from" text NOT NULL,
	"synced_through" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_sync_owner_repo_pk" PRIMARY KEY("owner","repo")
);
--> statement-breakpoint
CREATE TABLE "review_fact" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"id" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_author" text,
	"reviewer" text NOT NULL,
	"kind" text NOT NULL,
	"state" text,
	"ts" timestamp with time zone NOT NULL,
	CONSTRAINT "review_fact_owner_repo_id_pk" PRIMARY KEY("owner","repo","id")
);
--> statement-breakpoint
CREATE INDEX "commit_fact_at_idx" ON "commit_fact" USING btree ("owner","repo","committed_at");--> statement-breakpoint
CREATE INDEX "issue_fact_created_idx" ON "issue_fact" USING btree ("owner","repo","created_at");--> statement-breakpoint
CREATE INDEX "pr_fact_merged_idx" ON "pr_fact" USING btree ("owner","repo","merged_at");--> statement-breakpoint
CREATE INDEX "pr_fact_created_idx" ON "pr_fact" USING btree ("owner","repo","created_at");--> statement-breakpoint
CREATE INDEX "release_fact_at_idx" ON "release_fact" USING btree ("owner","repo","published_at");--> statement-breakpoint
CREATE INDEX "review_fact_ts_idx" ON "review_fact" USING btree ("owner","repo","ts");