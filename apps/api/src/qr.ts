import type { KeyResolver } from '@memesh/qr-engine';
import { env } from './config.js';

const keyTable: Record<string, string> = {
  [env.QR_KEY_ID]: env.SERVER_SECRET_KEY,
};

export const envKeyResolver: KeyResolver = {
  resolveSigningKey: () => ({
    keyId: env.QR_KEY_ID,
    secret: env.SERVER_SECRET_KEY,
  }),
  resolveVerifyKey: (keyId) => keyTable[keyId],
};
