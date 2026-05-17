CREATE TYPE "public"."user_role" AS ENUM('customer', 'cashier', 'instructor', 'manager', 'admin');--> statement-breakpoint
CREATE TYPE "public"."ticket_source" AS ENUM('online', 'pos', 'manual');--> statement-breakpoint
CREATE TYPE "public"."ticket_type" AS ENUM('baby_single', 'child_single', 'companion', 'punch_card');--> statement-breakpoint
CREATE TYPE "public"."redemption_method" AS ENUM('qr_scan', 'serial', 'phone_lookup', 'manual');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wp_user_id" integer,
	"first_name" varchar(80) NOT NULL,
	"last_name" varchar(80) NOT NULL,
	"email" varchar(255) NOT NULL,
	"phone" varchar(32),
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"children" jsonb,
	"children_consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"ticket_type" "ticket_type" NOT NULL,
	"qr_token" varchar(512) NOT NULL,
	"serial_number" varchar(32) NOT NULL,
	"total_entries" integer,
	"used_entries" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"wc_order_id" varchar(64),
	"source" "ticket_source" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_qr_token_unique" UNIQUE("qr_token"),
	CONSTRAINT "tickets_serial_number_unique" UNIQUE("serial_number")
);
--> statement-breakpoint
CREATE TABLE "redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"redeemed_by" uuid NOT NULL,
	"pos_terminal_id" varchar(64),
	"method" "redemption_method" NOT NULL,
	"companion_count" integer DEFAULT 1 NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_offline_sync" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;