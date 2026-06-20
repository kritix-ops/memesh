/**
 * Normalize an Israeli mobile number to the `05XXXXXXXX` form most local
 * providers (including 019) expect. Strips dashes, spaces, parens, leading
 * `+`, and the `972` country code if present. Throws on empty input.
 *
 * Non-Israeli numbers (leading + with a non-972 country code) pass through
 * unchanged after stripping separators — we do NOT invent format rules for
 * countries we cannot verify.
 */
export function normalizeIsraeliPhone(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) throw new Error('[sms phone] phone is required');
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('[sms phone] phone is required');

  // Strip non-digit characters but keep a leading '+' so we can detect country code.
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D+/g, '');
  if (digits === '') throw new Error('[sms phone] phone has no digits');

  // Israeli country code (with or without the leading '+'): drop it and add a leading 0.
  if (plus && digits.startsWith('972')) {
    return `0${digits.slice(3)}`;
  }
  if (!plus && digits.startsWith('972') && digits.length >= 12) {
    // Bare 972XXXXXXXXX without the '+' (some users paste this from contacts).
    return `0${digits.slice(3)}`;
  }
  // Already in the 0XXXXXXXXX form, or a non-Israeli number we leave to the provider.
  if (plus) {
    // Foreign number with country code: keep the +<country><number> shape.
    return `+${digits}`;
  }
  return digits;
}
