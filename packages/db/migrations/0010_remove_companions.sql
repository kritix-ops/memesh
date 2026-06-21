ALTER TABLE "card_settings" DROP COLUMN "min_companions";--> statement-breakpoint
ALTER TABLE "card_settings" DROP COLUMN "max_companions";--> statement-breakpoint
ALTER TABLE "punch_card_entries" RENAME COLUMN "companion_count" TO "entries_consumed";
