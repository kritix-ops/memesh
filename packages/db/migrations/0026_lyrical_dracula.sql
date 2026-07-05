CREATE SEQUENCE "public"."booking_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "booking_number" varchar(20);--> statement-breakpoint
UPDATE "bookings" SET "booking_number" = 'R-' || to_char("created_at", 'YYYYMMDD') || '-' || lpad(nextval('booking_number_seq')::text, 4, '0') WHERE "booking_number" IS NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booking_number_unique" UNIQUE("booking_number");