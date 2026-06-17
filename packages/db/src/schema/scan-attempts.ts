import { pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Every scan attempt is logged, including failures, to detect attacks.
// We store a hash of the token, never the token itself, for privacy.
export const scanResultEnum = pgEnum('scan_result', [
  'success',
  'invalid_signature',
  'expired',
  'exhausted',
  'not_found',
  'inactive',
  'rate_limited',
]);

export const scanAttempts = pgTable('scan_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  qrTokenHash: varchar('qr_token_hash', { length: 64 }), // hash of the token, not the token
  result: scanResultEnum('result').notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  terminalId: varchar('terminal_id', { length: 64 }),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ScanAttempt = typeof scanAttempts.$inferSelect;
export type NewScanAttempt = typeof scanAttempts.$inferInsert;
