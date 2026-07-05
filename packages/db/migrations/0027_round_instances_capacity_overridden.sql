ALTER TABLE "round_instances" ADD COLUMN "capacity_overridden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "round_instances" ri
SET "capacity_overridden" = true
FROM "rounds" r
WHERE r."id" = ri."round_id" AND ri."capacity" <> r."default_capacity";
