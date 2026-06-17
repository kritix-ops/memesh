import { pgSequence } from 'drizzle-orm/pg-core';

// Monotonic counter embedded in the human-friendly punch-card serial
// M-YYYYMMDD-NNNN. The date in the serial is display only; uniqueness
// comes from this sequence.
export const punchCardSerialSeq = pgSequence('punch_card_serial_seq', {
  startWith: 1,
  increment: 1,
});

// Monotonic counter for the customer number L-NNNN.
export const customerNumberSeq = pgSequence('customer_number_seq', {
  startWith: 1,
  increment: 1,
});
