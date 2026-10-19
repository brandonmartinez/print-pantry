CREATE TABLE "import_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"source_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"provider" text NOT NULL,
	"external_model_id" text,
	"external_profile_id" text,
	"title" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"project_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_requests_status_check" CHECK ("import_requests"."status" IN ('submitted', 'awaiting_files', 'declined', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "import_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"submission_key" uuid NOT NULL,
	"source_url" text NOT NULL,
	"title" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" bigint NOT NULL,
	"source_key" text NOT NULL,
	"source_url" text NOT NULL,
	"canonical_url" text NOT NULL,
	"provider" text NOT NULL,
	"external_model_id" text,
	"external_profile_id" text,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_events" ADD CONSTRAINT "import_events_request_id_import_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."import_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_events" ADD CONSTRAINT "import_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_requests" ADD CONSTRAINT "import_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_submissions" ADD CONSTRAINT "import_submissions_request_id_import_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."import_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_submissions" ADD CONSTRAINT "import_submissions_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_events_request_idx" ON "import_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_requests_active_source_idx" ON "import_requests" USING btree ("source_key") WHERE "import_requests"."status" IN ('submitted', 'awaiting_files');--> statement-breakpoint
CREATE INDEX "import_requests_created_idx" ON "import_requests" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_submissions_idempotency_idx" ON "import_submissions" USING btree ("requester_id","submission_key");--> statement-breakpoint
CREATE INDEX "import_submissions_request_idx" ON "import_submissions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_project_source_idx" ON "project_sources" USING btree ("project_id","source_key");--> statement-breakpoint
CREATE INDEX "project_sources_key_idx" ON "project_sources" USING btree ("source_key");