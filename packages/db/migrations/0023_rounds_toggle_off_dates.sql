CREATE TABLE "round_off_dates" (
	"date" date PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "rounds_enabled" boolean DEFAULT true NOT NULL;