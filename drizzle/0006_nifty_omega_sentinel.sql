ALTER TABLE "audit_log" ADD COLUMN "user_email" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "kind" text DEFAULT 'action' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "status" integer;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "suspicious" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_kind_idx" ON "audit_log" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "audit_suspicious_idx" ON "audit_log" USING btree ("suspicious");