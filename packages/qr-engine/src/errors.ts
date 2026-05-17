export type VerifyError =
  | 'invalid_format'
  | 'unknown_version'
  | 'unknown_key_id'
  | 'bad_signature'
  | 'malformed_payload';

export type VerifySuccess<T> = { ok: true; payload: T };
export type VerifyFailure = { ok: false; error: VerifyError };
export type VerifyResult<T> = VerifySuccess<T> | VerifyFailure;

export const isVerifySuccess = <T>(r: VerifyResult<T>): r is VerifySuccess<T> => r.ok;
export const isVerifyFailure = <T>(r: VerifyResult<T>): r is VerifyFailure => !r.ok;
