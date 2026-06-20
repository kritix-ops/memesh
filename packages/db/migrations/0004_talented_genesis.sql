ALTER TABLE "punch_card_entries" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD COLUMN "refunded_by" uuid;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD COLUMN "refund_reason" text;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD CONSTRAINT "punch_card_entries_refunded_by_staff_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD CONSTRAINT "punch_card_entries_approved_by_staff_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;