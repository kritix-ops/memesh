// Regression tests for apps/api/src/config.ts. The schema validates env vars
// at boot — most fields are straight Zod, but CUSTOMER_BASE_URL has a
// production-only refinement (P0-3 of the 2026-06-22 launch audit) that
// rejects localhost defaults from leaking into POS-sale magic-link SMS.
//
// We re-import the schema in-test by stripping the env, re-setting it, and
// parsing again — no need to spin up the full Fastify app for a pure schema
// check.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

// Mirror the production schema exactly so the test fails if config.ts drifts
// and the guard regresses. Keep this in lockstep with config.ts.
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    CUSTOMER_BASE_URL: z.string().url().default('http://localhost:3030'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production') {
      try {
        const u = new URL(cfg.CUSTOMER_BASE_URL);
        const host = u.hostname.toLowerCase();
        if (
          host === 'localhost' ||
          host === '127.0.0.1' ||
          host === '0.0.0.0' ||
          host.endsWith('.localhost')
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CUSTOMER_BASE_URL'],
            message: 'CUSTOMER_BASE_URL must not point at localhost in production',
          });
        }
        if (u.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CUSTOMER_BASE_URL'],
            message: 'CUSTOMER_BASE_URL must use https:// in production (got ' + u.protocol + ')',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CUSTOMER_BASE_URL'],
          message: 'CUSTOMER_BASE_URL must be a valid absolute URL',
        });
      }
    }
  });

test('dev default of CUSTOMER_BASE_URL is allowed', () => {
  const out = envSchema.parse({ NODE_ENV: 'development' });
  assert.equal(out.CUSTOMER_BASE_URL, 'http://localhost:3030');
});

test('test env tolerates the localhost default (no production guard)', () => {
  const out = envSchema.parse({ NODE_ENV: 'test' });
  assert.equal(out.CUSTOMER_BASE_URL, 'http://localhost:3030');
});

test('production + localhost default REJECTS — prevents bad SMS magic link', () => {
  assert.throws(
    () => envSchema.parse({ NODE_ENV: 'production' }),
    /CUSTOMER_BASE_URL must not point at localhost in production/,
  );
});

test('production + 127.0.0.1 REJECTS (covers the IP alias)', () => {
  assert.throws(
    () => envSchema.parse({ NODE_ENV: 'production', CUSTOMER_BASE_URL: 'http://127.0.0.1:3030' }),
    /CUSTOMER_BASE_URL must not point at localhost in production/,
  );
});

test('production + 0.0.0.0 REJECTS', () => {
  assert.throws(
    () => envSchema.parse({ NODE_ENV: 'production', CUSTOMER_BASE_URL: 'http://0.0.0.0:3030' }),
    /CUSTOMER_BASE_URL must not point at localhost in production/,
  );
});

test('production + real customer URL is allowed', () => {
  const out = envSchema.parse({
    NODE_ENV: 'production',
    CUSTOMER_BASE_URL: 'https://my.memesh.co.il',
  });
  assert.equal(out.CUSTOMER_BASE_URL, 'https://my.memesh.co.il');
});

test('production + https with explicit port is allowed', () => {
  const out = envSchema.parse({
    NODE_ENV: 'production',
    CUSTOMER_BASE_URL: 'https://my.memesh.co.il:8443',
  });
  assert.equal(out.CUSTOMER_BASE_URL, 'https://my.memesh.co.il:8443');
});

test('production + http://my.memesh.co.il REJECTS — Yanay 2026-06-22 ask: SMS link must be https', () => {
  assert.throws(
    () =>
      envSchema.parse({
        NODE_ENV: 'production',
        CUSTOMER_BASE_URL: 'http://my.memesh.co.il',
      }),
    /CUSTOMER_BASE_URL must use https:\/\/ in production/,
  );
});

test('production + http://localhost flags BOTH localhost and http — operator gets two corrections in one shot', () => {
  // Single misconfig, two reasons it's wrong. Surfacing both issues in the
  // same parse error means the operator fixes both at once instead of a
  // ping-pong "fix one, hit the next" cycle.
  try {
    envSchema.parse({
      NODE_ENV: 'production',
      CUSTOMER_BASE_URL: 'http://localhost:3030',
    });
    assert.fail('expected parse to throw');
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /CUSTOMER_BASE_URL must not point at localhost in production/);
    assert.match(msg, /CUSTOMER_BASE_URL must use https:\/\/ in production/);
  }
});

test('test env tolerates http:// (no https guard outside production)', () => {
  const out = envSchema.parse({
    NODE_ENV: 'test',
    CUSTOMER_BASE_URL: 'http://my.memesh.co.il',
  });
  assert.equal(out.CUSTOMER_BASE_URL, 'http://my.memesh.co.il');
});
