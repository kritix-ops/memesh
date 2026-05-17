import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyWcSignature } from './wc-webhook.js';

const SECRET = 'a-test-webhook-secret-of-sufficient-length';

const signBody = (body: Buffer): string =>
  createHmac('sha256', SECRET).update(body).digest('base64');

test('verifyWcSignature accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ id: 12345, status: 'completed' }), 'utf8');
  const sig = signBody(body);
  assert.equal(verifyWcSignature(body, sig, SECRET), true);
});

test('verifyWcSignature rejects a tampered body with the right signature shape', () => {
  const body = Buffer.from(JSON.stringify({ id: 12345 }), 'utf8');
  const tampered = Buffer.from(JSON.stringify({ id: 99999 }), 'utf8');
  const sig = signBody(body);
  assert.equal(verifyWcSignature(tampered, sig, SECRET), false);
});

test('verifyWcSignature rejects a wrong secret', () => {
  const body = Buffer.from(JSON.stringify({ id: 12345 }), 'utf8');
  const sig = createHmac('sha256', 'totally-different-secret-of-sufficient-len')
    .update(body)
    .digest('base64');
  assert.equal(verifyWcSignature(body, sig, SECRET), false);
});

test('verifyWcSignature rejects missing header', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWcSignature(body, undefined, SECRET), false);
});

test('verifyWcSignature rejects empty header', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWcSignature(body, '', SECRET), false);
});

test('verifyWcSignature rejects garbage with wrong length', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWcSignature(body, 'not-a-base64-sig', SECRET), false);
});

test('verifyWcSignature trims whitespace from header', () => {
  const body = Buffer.from('{}', 'utf8');
  const sig = signBody(body);
  assert.equal(verifyWcSignature(body, `  ${sig}  `, SECRET), true);
});
