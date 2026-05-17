const MIN_SEQUENCE = 1;
const MAX_SEQUENCE = 99_999;

export interface SerialInput {
  date: Date;
  sequence: number;
}

export interface ParsedSerial {
  date: Date;
  sequence: number;
}

const SERIAL_PATTERN = /^M-(\d{4})(\d{2})(\d{2})-(\d{4,5})$/;

export const generateSerial = ({ date, sequence }: SerialInput): string => {
  if (
    !Number.isInteger(sequence) ||
    sequence < MIN_SEQUENCE ||
    sequence > MAX_SEQUENCE
  ) {
    throw new RangeError(
      `[qr-engine serial] sequence must be integer in [${MIN_SEQUENCE}, ${MAX_SEQUENCE}], got ${sequence}`,
    );
  }
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const seq = sequence.toString().padStart(4, '0');
  return `M-${year}${month}${day}-${seq}`;
};

export const parseSerial = (serial: string): ParsedSerial | undefined => {
  const match = SERIAL_PATTERN.exec(serial);
  if (!match) return undefined;
  const [, yearStr, monthStr, dayStr, seqStr] = match;
  if (!yearStr || !monthStr || !dayStr || !seqStr) return undefined;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const sequence = Number(seqStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return undefined;
  return { date, sequence };
};
