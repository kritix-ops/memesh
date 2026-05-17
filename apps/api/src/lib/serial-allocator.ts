import { db } from '@memesh/db';
import { generateSerial } from '@memesh/qr-engine';
import { sql } from 'drizzle-orm';

export const allocateSerial = async (date: Date = new Date()): Promise<string> => {
  const result = await db.execute<{ nextval: string }>(
    sql`SELECT nextval('ticket_serial_seq') AS nextval`,
  );
  const rows = (result as unknown as { rows?: Array<{ nextval: string }> }).rows ?? (result as unknown as Array<{ nextval: string }>);
  const seqRow = rows[0];
  if (!seqRow) throw new Error('[serial-allocator] sequence returned no row');
  const sequence = Number(seqRow.nextval);
  if (!Number.isFinite(sequence)) {
    throw new Error(`[serial-allocator] unexpected sequence value: ${seqRow.nextval}`);
  }
  return generateSerial({ date, sequence });
};
