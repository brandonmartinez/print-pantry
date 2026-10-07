CREATE TABLE "print_request_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relative_path" text NOT NULL,
	"file_type" text NOT NULL,
	"extension" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "print_request_files_relative_path_check" CHECK ("print_request_files"."relative_path" !~ '^/')
);
--> statement-breakpoint
CREATE TABLE "print_request_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"from_position" integer,
	"to_position" integer,
	"note" varchar(2000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "print_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"requester_id" uuid NOT NULL,
	"status" text NOT NULL,
	"quantity" integer NOT NULL,
	"material" varchar(100),
	"color" varchar(100),
	"notes" varchar(2000),
	"queue_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "print_requests_quantity_check" CHECK ("print_requests"."quantity" BETWEEN 1 AND 100),
	CONSTRAINT "print_requests_queue_position_check" CHECK (("print_requests"."status" = 'queued' AND "print_requests"."queue_position" > 0) OR ("print_requests"."status" <> 'queued' AND "print_requests"."queue_position" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "request_queue_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"selected_next_id" uuid,
	CONSTRAINT "request_queue_state_singleton_check" CHECK ("request_queue_state"."id" = 1),
	CONSTRAINT "request_queue_state_revision_check" CHECK ("request_queue_state"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "print_request_files" ADD CONSTRAINT "print_request_files_request_id_print_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."print_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_request_files" ADD CONSTRAINT "print_request_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_request_files" ADD CONSTRAINT "print_request_files_version_id_asset_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_request_history" ADD CONSTRAINT "print_request_history_request_id_print_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."print_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_request_history" ADD CONSTRAINT "print_request_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_requests" ADD CONSTRAINT "print_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_queue_state" ADD CONSTRAINT "request_queue_state_selected_next_id_print_requests_id_fk" FOREIGN KEY ("selected_next_id") REFERENCES "public"."print_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_request_files_request_idx" ON "print_request_files" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "print_request_history_request_idx" ON "print_request_history" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "print_requests_requester_idx" ON "print_requests" USING btree ("requester_id","created_at");--> statement-breakpoint
CREATE INDEX "print_requests_queue_idx" ON "print_requests" USING btree ("status","queue_position");
--> statement-breakpoint
INSERT INTO "request_queue_state" ("id", "revision") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;