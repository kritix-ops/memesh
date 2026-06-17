import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// util.promisify drops the options overload from crypto.scrypt's type, so we
// re-type the promisified function to keep the cost-parameter options.
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: ScryptOptions,
) => Promise<Buffer>;

// OWASP Password Storage Cheat Sheet recommends Argon2id, then scrypt when
// Argon2id is unavailable. We use Node's built-in scrypt (no native build step)
// at N = 2^15 (32 MiB memory hardness), r = 8, p = 1. The parameters are stored
// inside each hash so they can be raised later without breaking existing hashes.
const ALGO = 'scrypt';
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// Node rejects scrypt if 128 * N * r * p exceeds maxmem; give generous headroom.
const MAXMEM = 256 * 1024 * 1024;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number, keylen: number) =>
  scrypt(password.normalize('NFKC'), salt, keylen, {
    N: n,
    r,
    p,
    maxmem: MAXMEM,
  });

/** Hash a password or PIN into a self-describing `scrypt$N$r$p$salt$hash` string. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(password, salt, N, R, P, KEYLEN);
  return [ALGO, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
};

/** Constant-time verification of a password against a stored scrypt hash. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [algo, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (!algo || !nStr || !rStr || !pStr || !saltB64 || !hashB64) return false;
  if (algo !== ALGO) return false;

  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = await derive(password, salt, n, r, p, expected.length);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
};
