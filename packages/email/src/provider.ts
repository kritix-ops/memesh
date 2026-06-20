export interface EmailMessage {
  /** Single recipient. Multi-recipient is intentionally not supported for OTP. */
  to: string;
  subject: string;
  /** Plain-text body. Required so messages render in clients that block HTML. */
  text: string;
  /** Optional HTML body. Providers fall back to `text` when missing. */
  html?: string;
}

export interface EmailSendResult {
  ok: boolean;
  /** Provider-side message id when available, useful for support look-ups. */
  id?: string;
  error?: string;
}

/**
 * Minimal email seam. The real provider (Resend) implements this behind the
 * same one-method interface so swapping or adding a provider is a one-file
 * change and never touches the OTP or notification call sites — same pattern
 * as @memesh/sms.
 */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
