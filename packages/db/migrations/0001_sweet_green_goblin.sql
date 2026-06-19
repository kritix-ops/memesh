CREATE TABLE "card_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"price_shekels" integer DEFAULT 320 NOT NULL,
	"validity_days" integer DEFAULT 365 NOT NULL,
	"total_entries" integer DEFAULT 12 NOT NULL,
	"pitch_label" text DEFAULT 'משלמים על 10, מקבלים 12 · תקף לשנה' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_settings_singleton_unique" UNIQUE("singleton")
);
--> statement-breakpoint
ALTER TABLE "card_settings" ADD CONSTRAINT "card_settings_updated_by_staff_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "card_settings" ("singleton") VALUES (true) ON CONFLICT ("singleton") DO NOTHING;