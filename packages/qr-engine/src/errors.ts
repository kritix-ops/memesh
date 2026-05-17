export type VerifyError =
  | 'invalid_format'
  | 'unknown_version'
  | 'unknown_key_id'
  | 'bad_signature'
  | 'malformed_payload';

export type VerifyResult<T> = { ok: true; payload: T } | { ok: false; error: VerifyError };
