CREATE TABLE "staff_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"pin_hash" varchar(255) NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_pins_staff_id_unique" UNIQUE("staff_id")
);
--> statement-breakpoint
CREATE TABLE "email_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "punch_cards" ADD COLUMN "receipt_number" varchar(64);--> statement-breakpoint
ALTER TABLE "punch_cards" ADD COLUMN "sold_by" uuid;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "require_receipt_number_on_pos" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "require_seller_pin" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "pin_length" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "pin_memory_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "pin_max_failures" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "pin_lockout_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "pos_name_on_receipt_label" text DEFAULT 'רשמתי את שם הלקוח על הקבלה במעמד התשלום' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "pos_email_nudge_text" text DEFAULT 'האימייל לא חובה אך מומלץ — מאפשר ללקוח להיכנס לאזור האישי גם אם החליף מספר טלפון או אם ה-SMS לא יגיע.' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "email_otp_subject" text DEFAULT 'קוד הכניסה שלך לאזור האישי בממש' NOT NULL;--> statement-breakpoint
ALTER TABLE "card_settings" ADD COLUMN "email_otp_body_template" text DEFAULT 'שלום {{firstName}},

קוד הכניסה שלך הוא: {{code}}

הקוד תקף ל-10 דקות.
אם לא ביקשת קוד זה, אפשר להתעלם מההודעה.

צוות ממש' NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_pins" ADD CONSTRAINT "staff_pins_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_otps_email_created_at_idx" ON "email_otps" USING btree ("email","created_at");--> statement-breakpoint
ALTER TABLE "punch_cards" ADD CONSTRAINT "punch_cards_sold_by_staff_id_fk" FOREIGN KEY ("sold_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "punch_cards_sold_by_idx" ON "punch_cards" USING btree ("sold_by");--> statement-breakpoint
ALTER TABLE "punch_cards" ADD CONSTRAINT "punch_cards_receipt_number_unique" UNIQUE("receipt_number");