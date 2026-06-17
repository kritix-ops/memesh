export interface SmsMessage {
  to: string; // Israeli mobile, e.g. 052-1234567
  body: string;
}

export interface SmsSendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Minimal SMS seam. The real provider (e.g. 019 SMS) implements this behind the
 * same one-method interface so swapping or adding a provider is a one-file change
 * and never touches the OTP or notification call sites.
 */
export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}
