CREATE TABLE "site_ai_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"configuration" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_ai_settings_singleton_check" CHECK ("site_ai_settings"."id" = 'site')
);
