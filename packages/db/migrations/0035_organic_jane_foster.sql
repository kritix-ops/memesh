CREATE TYPE "public"."reminder_kind" AS ENUM('stay', 'previsit');--> statement-breakpoint
ALTER TABLE "round_reminder_log" DROP CONSTRAINT "round_reminder_once";--> statement-breakpoint
ALTER TABLE "round_reminder_log" ADD COLUMN "kind" "reminder_kind" DEFAULT 'stay' NOT NULL;--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "pre_visit_reminder_offsets" integer[] DEFAULT '{1440}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "booking_confirm_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "booking_confirm_sms" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "round_reminder_log" ADD CONSTRAINT "round_reminder_once" UNIQUE("round_instance_id","kind","offset_minutes");