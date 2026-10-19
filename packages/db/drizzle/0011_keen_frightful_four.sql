CREATE TABLE "library_migration_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_id" uuid NOT NULL,
	"project_id" bigint NOT NULL,
	"legacy_root" text NOT NULL,
	"legacy_path" text NOT NULL,
	"managed_path" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"last_error" text,
	CONSTRAINT "library_migration_projects_status_check" CHECK ("library_migration_projects"."status" IN ('pending','copying','copied','activated','restored','canceled'))
);
--> statement-breakpoint
CREATE TABLE "library_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"legacy_root" text NOT NULL,
	"managed_root" text NOT NULL,
	"root_identities" jsonb NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_migrations_plan_id_unique" UNIQUE("plan_id"),
	CONSTRAINT "library_migrations_status_check" CHECK ("library_migrations"."status" IN ('active','completed','canceled'))
);
--> statement-breakpoint
ALTER TABLE "library_migration_projects" ADD CONSTRAINT "library_migration_projects_migration_id_library_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."library_migrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_migration_projects" ADD CONSTRAINT "library_migration_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_migrations" ADD CONSTRAINT "library_migrations_plan_id_library_reorganization_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."library_reorganization_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_migrations" ADD CONSTRAINT "library_migrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_migration_project_job_idx" ON "library_migration_projects" USING btree ("migration_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_migration_project_active_idx" ON "library_migration_projects" USING btree ("project_id") WHERE "library_migration_projects"."status" IN ('pending','copying','copied','activated');--> statement-breakpoint
CREATE INDEX "library_migration_legacy_idx" ON "library_migration_projects" USING btree ("legacy_root","status");