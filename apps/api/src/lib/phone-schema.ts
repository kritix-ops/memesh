import { normalizeIsraeliPhone } from '@memesh/sms';
import { z } from 'zod';

/**
 * Zod schema for an incoming phone number on any auth or registration body.
 *
 * Accepts whatever the user types (with or without dashes, spaces, parens,
 * leading +, or +972 country code) and produces the canonical `05XXXXXXXX`
 * form. Every DB write and every DB lookup goes through this so the storage
 * representation is uniform and login works regardless of input formatting
 * (this is the fix for the "I typed 0545822079 and login failed because the
 * row stored 054-582-2079" UX trap).
 *
 * The schema rejects empty input and surfaces the underlying normalization
 * error via a Zod issue so the route returns 400 invalid_body with the same
 * shape as every other validation failure.
 */
export const phoneSchema = z
  .string()
  .min(3, 'phone is too short')
  .max(32, 'phone is too long')
  .transform((raw, ctx) => {
    try {
      return normalizeIsraeliPhone(raw);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : 'invalid_phone',
      });
      return z.NEVER;
    }
  });
