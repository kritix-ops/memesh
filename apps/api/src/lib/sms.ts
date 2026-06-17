import { ConsoleSmsProvider, type SmsProvider } from '@memesh/sms';

// Single SMS provider for the app. Swap this for the real Israeli provider
// (e.g. 019) when credentials are wired; nothing else changes.
export const smsProvider: SmsProvider = new ConsoleSmsProvider();
