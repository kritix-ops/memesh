CREATE TYPE "public"."round_schedule_outside" AS ENUM('free_play', 'closed');--> statement-breakpoint
CREATE TABLE "round_schedule_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date_from" date,
	"date_to" date,
	"weekday_mask" smallint,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outside" "round_schedule_outside" DEFAULT 'free_play' NOT NULL,
	"note" varchar(120),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
