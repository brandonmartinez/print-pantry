CREATE TABLE "source_discovery_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"approved_candidate_ids" jsonb,
	"applied_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "source_discovery_previews" ADD CONSTRAINT "source_discovery_previews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_discovery_previews" ADD CONSTRAINT "source_discovery_previews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_discovery_previews" ADD CONSTRAINT "source_discovery_previews_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_discovery_project_idx" ON "source_discovery_previews" USING btree ("project_id");