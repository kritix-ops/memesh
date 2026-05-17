import { pgSequence } from 'drizzle-orm/pg-core';

// Global monotonic counter for ticket serials. Embedded into the
// human-friendly M-YYYYMMDD-NNNN serial. The date in the serial is
// purely display; uniqueness comes from this sequence.
export const ticketSerialSeq = pgSequence('ticket_serial_seq', {
  startWith: 1,
  increment: 1,
});
