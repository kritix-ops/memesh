CREATE TABLE "round_reminder_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"round_instance_id" uuid NOT NULL,
	"offset_minutes" smallint NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "round_reminder_once" UNIQUE("round_instance_id","offset_minutes")
);
--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "reminder_offsets" integer[] DEFAULT '{30,10}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "closing_time" time DEFAULT '19:00:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "round_settings" ADD COLUMN "skip_last_round_reminder" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "round_reminder_log" ADD CONSTRAINT "round_reminder_log_round_instance_id_round_instances_id_fk" FOREIGN KEY ("round_instance_id") REFERENCES "public"."round_instances"("id") ON DELETE no action ON UPDATE no action;