import { apiRequest, type ApiResult } from '../api';

// Mirrors apps/api/src/routes/punch.ts response shape. The endpoint accepts
// either a token or a serial; the POS detail screen always uses the serial
// path because it already knows the active card's serialNumber. The QR-scan
// surface (not yet wired) will use the token path through the same module.

export interface PunchSuccess {
  ok: true;
  /** True if the server treated this as a replay of a previous idempotent call. */
  replay: boolean;
  remaining: number;
  usedEntries: number;
  totalEntries: number;
}

export interface PunchByserialOptions {
  /** 1–4. Defaults to 1 on the server when omitted. */
  companions?: number;
  /** Per-intent UUID. The same key on a retry is a no-op (returns replay:true). */
  idempotencyKey?: string;
  /** Optional terminal id for the audit row. Unused by the web app today. */
  terminalId?: string;
}

/** Punch a card by its serial number (M-YYYYMMDD-NNNN). */
export const punchBySerial = (
  serial: string,
  opts: PunchByserialOptions = {},
): Promise<ApiResult<PunchSuccess>> =>
  apiRequest('/punch', {
    method: 'POST',
    body: {
      serial,
      ...(opts.companions !== undefined && { companions: opts.companions }),
      ...(opts.idempotencyKey !== undefined && { idempotencyKey: opts.idempotencyKey }),
      ...(opts.terminalId !== undefined && { terminalId: opts.terminalId }),
    },
  });

export interface PunchByTokenOptions {
  /** 1–4. Defaults to 1 on the server when omitted. */
  companions?: number;
  /** Per-intent UUID. Same key on a retry is a no-op (returns replay:true). */
  idempotencyKey?: string;
  /** Optional terminal id for the audit row. */
  terminalId?: string;
}

/**
 * Punch a card by the QR token scanned from the camera. The token is the
 * full base64url-encoded HMAC string; the server validates the signature.
 * The client never parses the token — a tampered or foreign QR surfaces as
 * `invalid_signature` from the server.
 */
export const punchByToken = (
  token: string,
  opts: PunchByTokenOptions = {},
): Promise<ApiResult<PunchSuccess>> =>
  apiRequest('/punch', {
    method: 'POST',
    body: {
      token,
      ...(opts.companions !== undefined && { companions: opts.companions }),
      ...(opts.idempotencyKey !== undefined && { idempotencyKey: opts.idempotencyKey }),
      ...(opts.terminalId !== undefined && { terminalId: opts.terminalId }),
    },
  });
