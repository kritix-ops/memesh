export type AuthVerifyError =
  | 'invalid_format'
  | 'expired'
  | 'invalid_signature'
  | 'invalid_claims'
  | 'wrong_token_type';

export type AuthVerifySuccess<T> = { ok: true; claims: T };
export type AuthVerifyFailure = { ok: false; error: AuthVerifyError };
export type AuthVerifyResult<T> = AuthVerifySuccess<T> | AuthVerifyFailure;

export const isAuthSuccess = <T>(r: AuthVerifyResult<T>): r is AuthVerifySuccess<T> => r.ok;
export const isAuthFailure = <T>(r: AuthVerifyResult<T>): r is AuthVerifyFailure => !r.ok;
