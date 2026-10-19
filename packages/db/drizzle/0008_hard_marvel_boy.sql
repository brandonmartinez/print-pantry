CREATE TABLE "import_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"original_path" text NOT NULL,
	"stored_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_intakes" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"plan" jsonb,
	"last_error" text,
	"reserved_project_id" bigint,
	"published_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stored_path" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_relative_path_unique";--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_relative_path_unique";--> statement-breakpoint
ALTER TABLE "import_requests" DROP CONSTRAINT "import_requests_status_check";--> statement-breakpoint
DROP INDEX "import_requests_active_source_idx";--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "storage_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "storage_kind" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_request_id_import_intakes_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."import_intakes"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_files" ADD CONSTRAINT "import_files_upload_id_import_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."import_uploads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_intakes" ADD CONSTRAINT "import_intakes_request_id_import_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."import_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_uploads" ADD CONSTRAINT "import_uploads_request_id_import_intakes_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."import_intakes"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_files_request_idx" ON "import_files" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "import_uploads_request_idx" ON "import_uploads" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_storage_path_idx" ON "assets" USING btree ("storage_kind","relative_path");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_storage_path_idx" ON "projects" USING btree ("storage_kind","relative_path");--> statement-breakpoint
CREATE UNIQUE INDEX "import_requests_active_source_idx" ON "import_requests" USING btree ("source_key") WHERE "import_requests"."status" IN ('submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending');--> statement-breakpoint
ALTER TABLE "import_requests" ADD CONSTRAINT "import_requests_status_check" CHECK ("import_requests"."status" IN ('submitted', 'awaiting_files', 'ready_for_review', 'publishing', 'catalog_pending', 'imported', 'declined', 'canceled'));