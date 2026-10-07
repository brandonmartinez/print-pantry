CREATE TABLE "asset_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"thumbnail_entry" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"project_relative_path" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"extension" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mtime_ms" bigint NOT NULL,
	"content_hash" text,
	"current_version_id" uuid,
	"missing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_relative_path_unique" UNIQUE("relative_path")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"relative_path" text NOT NULL,
	CONSTRAINT "categories_relative_path_unique" UNIQUE("relative_path")
);
--> statement-breakpoint
CREATE TABLE "project_boundary_overrides" (
	"relative_path" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid,
	"relative_path" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"designer" text,
	"source_url" text,
	"license" text,
	"notes" text,
	"preview_asset_id" uuid,
	"missing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_relative_path_unique" UNIQUE("relative_path")
);
--> statement-breakpoint
CREATE TABLE "scan_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"relative_path" text,
	"code" text NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"hashed_files" integer DEFAULT 0 NOT NULL,
	"errors_count" integer DEFAULT 0 NOT NULL,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "asset_versions" ADD CONSTRAINT "asset_versions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_current_version_id_asset_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_errors" ADD CONSTRAINT "scan_errors_run_id_scan_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scan_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_versions_asset_idx" ON "asset_versions" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "assets_project_idx" ON "assets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "assets_search_idx" ON "assets" USING gin (to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("project_relative_path", '')));--> statement-breakpoint
CREATE INDEX "categories_search_idx" ON "categories" USING gin (to_tsvector('simple', coalesce("name", '') || ' ' || coalesce("relative_path", '')));--> statement-breakpoint
CREATE INDEX "projects_category_idx" ON "projects" USING btree ("category_id");--> statement-breakpoint
CREATE FUNCTION print_pantry_tags_text(text[]) RETURNS text LANGUAGE sql IMMUTABLE STRICT
AS $$ SELECT array_to_string($1, ' ') $$;--> statement-breakpoint
CREATE INDEX "projects_search_idx" ON "projects" USING gin (to_tsvector('simple', coalesce("name", '') || ' ' ||
    coalesce("description", '') || ' ' || coalesce(print_pantry_tags_text("tags"), '') || ' ' ||
    coalesce("designer", '') || ' ' || coalesce("source_url", '') || ' ' ||
    coalesce("license", '') || ' ' || coalesce("notes", '')));--> statement-breakpoint
CREATE INDEX "scan_errors_run_idx" ON "scan_errors" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");