import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Admin-edited overrides for the editable-content registry (Wave 2 plan
// 2026-07-13). One row per string Yanay actually changed — everything else
// falls back to the code-side default in @memesh/content. The first generic
// key-value table in the schema (the settings tables are typed singletons):
// appropriate here because the key space is open and owned by the code registry.
export const contentOverrides = pgTable('content_overrides', {
  /** A registry key (validated against @memesh/content on write). */
  key: text('key').primaryKey(),
  /** The override text. Non-empty — a blank edit deletes the row (reset). */
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Staff id of the last editor, for the audit trail. Null for older rows. */
  updatedBy: text('updated_by'),
});

export type ContentOverrideRow = typeof contentOverrides.$inferSelect;
export type NewContentOverride = typeof contentOverrides.$inferInsert;
