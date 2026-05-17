CREATE SEQUENCE "public"."ticket_serial_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "wc_product_id" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "companion_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "redemptions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_companion_ticket_id_tickets_id_fk" FOREIGN KEY ("companion_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;