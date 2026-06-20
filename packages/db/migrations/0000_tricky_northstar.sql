CREATE TYPE "public"."staff_role" AS ENUM('admin', 'manager', 'cashier');--> statement-breakpoint
CREATE TYPE "public"."customer_source" AS ENUM('referral', 'social', 'walk_by', 'website', 'other');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'frozen', 'vip');--> statement-breakpoint
CREATE TYPE "public"."preferred_channel" AS ENUM('sms', 'whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."punch_card_source" AS ENUM('pos', 'online', 'manual');--> statement-breakpoint
CREATE TYPE "public"."punch_method" AS ENUM('qr_scan', 'serial', 'phone', 'manual');--> statement-breakpoint
CREATE TYPE "public"."scan_result" AS ENUM('success', 'invalid_signature', 'expired', 'exhausted', 'not_found', 'inactive', 'rate_limited');--> statement-breakpoint
CREATE SEQUENCE "public"."customer_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE SEQUENCE "public"."punch_card_serial_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"first_name" varchar(80) NOT NULL,
	"last_name" varchar(80) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"email" varchar(255),
	"password_hash" varchar(255),
	"role" "staff_role" DEFAULT 'cashier' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_number" varchar(16) NOT NULL,
	"wp_user_id" integer,
	"first_name" varchar(80) NOT NULL,
	"last_name" varchar(80) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"email" varchar(255),
	"preferred_channel" "preferred_channel" DEFAULT 'sms' NOT NULL,
	"children" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"internal_notes" text,
	"source" "customer_source",
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"registered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_customer_number_unique" UNIQUE("customer_number"),
	CONSTRAINT "customers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "punch_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"wc_order_id" varchar(64),
	"serial_number" varchar(32) NOT NULL,
	"qr_token" varchar(512) NOT NULL,
	"key_id" varchar(32) NOT NULL,
	"total_entries" integer DEFAULT 12 NOT NULL,
	"used_entries" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"source" "punch_card_source" DEFAULT 'pos' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "punch_cards_serial_number_unique" UNIQUE("serial_number"),
	CONSTRAINT "punch_cards_qr_token_unique" UNIQUE("qr_token")
);
--> statement-breakpoint
CREATE TABLE "punch_card_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"punch_card_id" uuid NOT NULL,
	"punched_by" uuid,
	"method" "punch_method" NOT NULL,
	"companion_count" integer DEFAULT 1 NOT NULL,
	"idempotency_key" varchar(64),
	"notes" text,
	"punched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "punch_card_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "scan_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qr_token_hash" varchar(64),
	"result" "scan_result" NOT NULL,
	"ip_address" varchar(64),
	"terminal_id" varchar(64),
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" varchar(32) NOT NULL,
	"code_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid,
	"action" varchar(40) NOT NULL,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_registered_by_staff_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_cards" ADD CONSTRAINT "punch_cards_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_cards" ADD CONSTRAINT "punch_cards_cancelled_by_staff_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD CONSTRAINT "punch_card_entries_punch_card_id_punch_cards_id_fk" FOREIGN KEY ("punch_card_id") REFERENCES "public"."punch_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "punch_card_entries" ADD CONSTRAINT "punch_card_entries_punched_by_staff_id_fk" FOREIGN KEY ("punched_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_actions" ADD CONSTRAINT "staff_actions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;