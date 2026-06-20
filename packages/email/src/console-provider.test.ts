import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleEmailProvider } from './console-provider';

test('ConsoleEmailProvider records sent messages and returns ok', async () => {
  const logs: string[] = [];
  const email = new ConsoleEmailProvider({ log: (line) => logs.push(line) });

  const res = await email.send({
    to: 'noa@example.com',
    subject: 'קוד הכניסה שלך',
    text: 'הקוד הוא 123456',
  });

  assert.equal(res.ok, true);
  assert.equal(email.sent.length, 1);
  assert.equal(email.sent[0]?.to, 'noa@example.com');
  assert.match(logs[0] ?? '', /\[email:console\]/);
});

test('ConsoleEmailProvider returns a distinct id per message', async () => {
  const email = new ConsoleEmailProvider({ log: () => {} });
  const a = await email.send({ to: 'a@example.com', subject: 's', text: 'a' });
  const b = await email.send({ to: 'b@example.com', subject: 's', text: 'b' });
  assert.notEqual(a.id, b.id);
  assert.equal(email.sent.length, 2);
});
