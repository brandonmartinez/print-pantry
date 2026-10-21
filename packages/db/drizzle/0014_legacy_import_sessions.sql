CREATE TABLE "legacy_import_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_by" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'selecting' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_import_state_check" CHECK ("legacy_import_sessions"."state" IN ('selecting','planned','organizing','organized','failed'))
);
--> statement-breakpoint
ALTER TABLE "legacy_import_sessions" ADD CONSTRAINT "legacy_import_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_import_updated_idx" ON "legacy_import_sessions" USING btree ("updated_at");