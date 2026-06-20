CREATE TABLE "wc_product_card_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wc_sku" varchar(64) NOT NULL,
	"total_entries" integer NOT NULL,
	"validity_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wc_product_card_configs_wc_sku_unique" UNIQUE("wc_sku")
);
--> statement-breakpoint
CREATE TABLE "wc_processed_webhooks" (
	"delivery_id" varchar(128) PRIMARY KEY NOT NULL,
	"wc_order_id" varchar(64) NOT NULL,
	"topic" varchar(64) NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wc_webhook_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" varchar(128),
	"wc_order_id" varchar(64),
	"reason" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wc_webhook_failures" ADD CONSTRAINT "wc_webhook_failures_resolved_by_staff_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "punch_cards_wc_order_id_idx" ON "punch_cards" USING btree ("wc_order_id");