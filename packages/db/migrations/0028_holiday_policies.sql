CREATE TYPE "public"."round_schedule_source" AS ENUM('manual', 'holiday_sync');--> statement-breakpoint
CREATE TYPE "public"."holiday_category" AS ENUM('major', 'minor', 'modern', 'fast', 'shabbat');--> statement-breakpoint
CREATE TYPE "public"."holiday_policy_state" AS ENUM('normal', 'closed', 'special_hours');--> statement-breakpoint
CREATE TABLE "holiday_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holiday_key" varchar(80) NOT NULL,
	"hebrew_name" varchar(120) NOT NULL,
	"category" "holiday_category" NOT NULL,
	"yomtov" boolean DEFAULT false NOT NULL,
	"policy" "holiday_policy_state" DEFAULT 'normal' NOT NULL,
	"open_time" time,
	"close_time" time,
	"shabbat_close_offset_minutes" smallint,
	"confirmed_at" timestamp with time zone,
	"note" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holiday_policies_holiday_key_unique" UNIQUE("holiday_key")
);
--> statement-breakpoint
ALTER TABLE "round_schedule_rules" ADD COLUMN "open_from" time;--> statement-breakpoint
ALTER TABLE "round_schedule_rules" ADD COLUMN "open_until" time;--> statement-breakpoint
ALTER TABLE "round_schedule_rules" ADD COLUMN "source" "round_schedule_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "round_schedule_rules" ADD COLUMN "source_key" varchar(96);