import type { SmsMessage, SmsProvider, SmsSendResult } from './provider.js';

export interface ConsoleSmsOptions {
  log?: (line: string) => void;
}

/**
 * Development/test provider. Sends nothing; records and logs each message so the
 * full OTP flow works end to end before a real provider is wired in.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  readonly sent: SmsMessage[] = [];
  private readonly log: (line: string) => void;

  constructor(options: ConsoleSmsOptions = {}) {
    this.log = options.log ?? ((line) => console.info(line));
  }

  async send(message: SmsMessage): Promise<SmsSendResult> {
    this.sent.push(message);
    this.log(`[sms:console] to=${message.to} body=${message.body}`);
    return { ok: true, id: `console-${this.sent.length}` };
  }
}
