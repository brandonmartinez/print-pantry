CREATE TABLE "app_metadata" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"value" varchar(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
