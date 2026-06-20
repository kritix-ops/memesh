ALTER TABLE "card_settings" ADD COLUMN "min_companions" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "max_companions" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "same_day_lockout_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "grace_period_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "allow_cancel_after_first_punch" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "min_cancel_reason_length" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "refund_policy_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "cancel_role" varchar(16) DEFAULT 'manager' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "sms_on_purchase" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "sms_low_entries_threshold" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "sms_quiet_start_minutes" integer DEFAULT 1260 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "sms_quiet_end_minutes" integer DEFAULT 540 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "expiry_badge_threshold_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "require_email_on_new_customer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "require_child_on_new_customer" boolean DEFAULT false NOT NULL;