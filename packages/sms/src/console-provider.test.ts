import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleSmsProvider } from './console-provider';

test('ConsoleSmsProvider records sent messages and returns ok', async () => {
  const logs: string[] = [];
  const sms = new ConsoleSmsProvider({ log: (line) => logs.push(line) });

  const res = await sms.send({ to: '052-1234567', body: 'קוד הכניסה שלך: 123456' });

  assert.equal(res.ok, true);
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0]?.to, '052-1234567');
  assert.match(logs[0] ?? '', /\[sms:console\]/);
});

test('ConsoleSmsProvider returns a distinct id per message', async () => {
  const sms = new ConsoleSmsProvider({ log: () => {} });
  const a = await sms.send({ to: '050-0000000', body: 'a' });
  const b = await sms.send({ to: '050-0000000', body: 'b' });
  assert.notEqual(a.id, b.id);
  assert.equal(sms.sent.length, 2);
});
