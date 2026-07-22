CREATE TABLE "default_team_override" (
	"builtin_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"members" jsonb NOT NULL,
	"repos" jsonb NOT NULL,
	"tz" text,
	"last_edited_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
