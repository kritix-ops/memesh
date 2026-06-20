import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, verifyPassword } from './password';

test('hashPassword produces a self-describing scrypt hash that verifies', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('1234');
  assert.equal(await verifyPassword('12345', hash), false);
});

test('hashPassword salts: the same password hashes differently each time', async () => {
  const a = await hashPassword('same-pin');
  const b = await hashPassword('same-pin');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-pin', a), true);
  assert.equal(await verifyPassword('same-pin', b), true);
});

test('verifyPassword rejects malformed stored values', async () => {
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'scrypt$bad'), false);
  assert.equal(await verifyPassword('x', 'bcrypt$15$8$1$AAAA$BBBB'), false);
});

test('verifyPassword handles unicode passwords (e.g. Hebrew)', async () => {
  const hash = await hashPassword('סיסמה-בעברית');
  assert.equal(await verifyPassword('סיסמה-בעברית', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});
