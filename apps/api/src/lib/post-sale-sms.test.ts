// Unit tests for the post-sale SMS body builder. Pure-function tests, no DB,
// no SMS provider, no Fastify — the point is to pin down the Hebrew copy
// and the URL shape so a future edit can't silently break the link.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPosSellSmsBody } from './post-sale-sms';

const RAW_TOKEN = 'eHbCw0vSf3pq3pjN0lE7vQF1mGZqXk7d9BTNcL2y7Yc';
const LINK = `https://my.memesh.co.il/checkout-complete?token=${RAW_TOKEN}`;

test('buildPosSellSmsBody: golden path with an expiring card includes Hebrew copy, count, expiry date, and the magic link', () => {
  const body = buildPosSellSmsBody({
    totalEntries: 12,
    expiresAt: new Date('2026-12-31T22:00:00.000Z'),
    link: LINK,
  });
  assert.match(body, /הכרטיסייה שלך ב-Memesh נוצרה!/);
  assert.match(body, /12 כניסות/);
  assert.match(body, /תוקף עד 2026-12-31/);
  assert.match(body, /צפייה בכרטיסייה: /);
  assert.ok(body.includes(LINK), 'SMS body must contain the full magic link');
});

test('buildPosSellSmsBody: card with no expiry renders "(ללא תפוגה)" instead of a date', () => {
  const body = buildPosSellSmsBody({
    totalEntries: 6,
    expiresAt: null,
    link: LINK,
  });
  assert.match(body, /6 כניסות \(ללא תפוגה\)/);
  assert.equal(body.includes('תוקף עד'), false, 'no expiry date when expiresAt is null');
  assert.ok(body.includes(LINK), 'magic link is still present');
});

test('buildPosSellSmsBody: the link is embedded verbatim — no URL encoding, no trailing punctuation that would break tap-to-open', () => {
  const body = buildPosSellSmsBody({
    totalEntries: 1,
    expiresAt: null,
    link: LINK,
  });
  // The URL must be the last meaningful payload so a phone's URL detector
  // captures it cleanly. Specifically: nothing after the token.
  assert.ok(body.endsWith(LINK), `body must end with the magic link, got: ${body}`);
});

test('buildPosSellSmsBody: a different totalEntries renders without leaking other state', () => {
  const body = buildPosSellSmsBody({
    totalEntries: 50,
    expiresAt: new Date('2027-01-15T08:00:00.000Z'),
    link: 'https://example.test/c?t=abc',
  });
  assert.match(body, /50 כניסות/);
  assert.match(body, /תוקף עד 2027-01-15/);
  assert.match(body, /https:\/\/example\.test\/c\?t=abc/);
});
