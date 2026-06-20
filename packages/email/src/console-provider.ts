import type { EmailMessage, EmailProvider, EmailSendResult } from './provider.js';

export interface ConsoleEmailOptions {
  log?: (line: string) => void;
}

/**
 * Development/test provider. Sends nothing; records and logs each message so
 * the full email-OTP flow works end to end before Resend is wired in. Mirrors
 * @memesh/sms ConsoleSmsProvider.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  readonly sent: EmailMessage[] = [];
  private readonly log: (line: string) => void;

  constructor(options: ConsoleEmailOptions = {}) {
    this.log = options.log ?? ((line) => console.info(line));
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(message);
    this.log(
      `[email:console] to=${message.to} subject=${message.subject} bodyLength=${message.text.length}`,
    );
    return { ok: true, id: `console-${this.sent.length}` };
  }
}
