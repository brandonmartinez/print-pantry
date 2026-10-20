CREATE TABLE "library_adoption_items" (
	"run_id" uuid NOT NULL,
	"project_id" bigint NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"plan_id" uuid,
	"migration_id" uuid,
	"fingerprint" text,
	"size_bytes" text NOT NULL,
	"file_count" integer NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed_action" text,
	"last_error" text,
	CONSTRAINT "library_adoption_item_status_check" CHECK ("library_adoption_items"."status" IN ('pending','ready','blocked','copying','copied','activated','failed','restored','canceled'))
);
--> statement-breakpoint
CREATE TABLE "library_adoption_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"state" text DEFAULT 'planning' NOT NULL,
	"resume_state" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"legacy_root" text NOT NULL,
	"managed_root" text NOT NULL,
	"root_identities" jsonb NOT NULL,
	"fingerprint" text DEFAULT '' NOT NULL,
	"available_bytes" text,
	"copy_approved_at" timestamp with time zone,
	"activation_approved_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_adoption_state_check" CHECK ("library_adoption_runs"."state" IN ('planning','review','copying','awaiting_activation','activating','restoring','canceling','paused','completed','partial','canceled','restored'))
);
--> statement-breakpoint
ALTER TABLE "library_adoption_items" ADD CONSTRAINT "library_adoption_items_run_id_library_adoption_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."library_adoption_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_adoption_items" ADD CONSTRAINT "library_adoption_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_adoption_items" ADD CONSTRAINT "library_adoption_items_plan_id_library_reorganization_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."library_reorganization_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_adoption_items" ADD CONSTRAINT "library_adoption_items_migration_id_library_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."library_migrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_adoption_runs" ADD CONSTRAINT "library_adoption_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_adoption_runs" ADD CONSTRAINT "library_adoption_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_adoption_item_idx" ON "library_adoption_items" USING btree ("run_id","project_id");--> statement-breakpoint
CREATE INDEX "library_adoption_work_idx" ON "library_adoption_items" USING btree ("run_id","status","project_id");--> statement-breakpoint
CREATE INDEX "library_adoption_updated_idx" ON "library_adoption_runs" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "library_adoption_active_roots_idx" ON "library_adoption_runs" USING btree ("legacy_root","managed_root") WHERE "library_adoption_runs"."state" NOT IN ('completed','partial','canceled','restored');