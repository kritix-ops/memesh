import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHebcalClient, hebcalStableKey } from './hebcal-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

// Holiday items as Hebcal returns them (English vs Hebrew, parallel order).
const EN_HOLIDAYS = {
  items: [
    { title: 'Pesach I', date: '2026-04-02', category: 'holiday', subcat: 'major', yomtov: true },
    { title: 'Pesach II (CH’’M)', date: '2026-04-03', category: 'holiday', subcat: 'major' },
    { title: 'Rosh Hashana 5787', date: '2026-09-12', category: 'holiday', subcat: 'major', yomtov: true },
    { title: 'Rosh Chodesh Elul', date: '2026-08-14', category: 'roshchodesh', subcat: 'minor' },
  ],
};
const HE_HOLIDAYS = {
  items: [
    { title: 'פֶּסַח א׳', hebrew: 'פסח א׳', date: '2026-04-02', category: 'holiday', subcat: 'major', yomtov: true },
    { title: 'פֶּסַח ב׳', hebrew: 'פסח ב׳ (חוה״מ)', date: '2026-04-03', category: 'holiday', subcat: 'major' },
    { title: 'ראש השנה', hebrew: 'ראש השנה 5787', date: '2026-09-12', category: 'holiday', subcat: 'major', yomtov: true },
    { title: 'ראש חודש אלול', hebrew: 'ראש חודש אלול', date: '2026-08-14', category: 'roshchodesh', subcat: 'minor' },
  ],
};
const CANDLES = {
  location: { title: 'Tel Aviv', tzid: 'Asia/Jerusalem' },
  items: [
    { title: 'הדלקת נרות: 19:11', date: '2026-07-03T19:11:00+03:00', category: 'candles' },
    { title: 'הבדלה: 20:33', date: '2026-07-04T20:33:00+03:00', category: 'havdalah' },
    { title: 'הדלקת נרות: 19:09', date: '2026-07-10T19:09:00+03:00', category: 'candles' },
  ],
};

test('hebcalStableKey strips the trailing Hebrew year but keeps day markers', () => {
  assert.equal(hebcalStableKey('Rosh Hashana 5787'), 'rosh_hashana');
  assert.equal(hebcalStableKey('Rosh Hashana 5788'), 'rosh_hashana');
  assert.equal(hebcalStableKey('Pesach I'), 'pesach_i');
  assert.equal(hebcalStableKey('Yom Kippur'), 'yom_kippur');
  assert.equal(hebcalStableKey("Tish'a B'Av"), 'tish_a_b_av');
});

test('listHolidays fetches Israel schedule in both languages and joins them', async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    return jsonResponse(String(url).includes('lg=he') ? HE_HOLIDAYS : EN_HOLIDAYS);
  }) as unknown as typeof fetch;

  const client = createHebcalClient({ fetchImpl });
  const holidays = await client.listHolidays(2026);

  // Two fetches: English (for the key) and Hebrew (for display).
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes('i=on') && u.includes('maj=on') && u.includes('mf=on')));
  assert.ok(urls.some((u) => u.includes('lg=he')));
  assert.ok(urls.some((u) => !u.includes('lg=he')));

  // roshchodesh is filtered out; only category 'holiday' survives.
  assert.equal(holidays.length, 3);
  const pesach = holidays[0]!;
  assert.equal(pesach.date, '2026-04-02');
  assert.equal(pesach.englishTitle, 'Pesach I');
  assert.equal(pesach.hebrewName, 'פסח א׳');
  assert.equal(pesach.yomtov, true);

  // Hebrew display carries the year suffix, but the stable key drops it.
  const rh = holidays[2]!;
  assert.equal(rh.hebrewName, 'ראש השנה 5787');
  assert.equal(hebcalStableKey(rh.englishTitle), 'rosh_hashana');
});

test('listHolidays falls back to a date-join when the arrays are not parallel', async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('lg=he')) {
      // Hebrew has an extra leading item, so index-zip would misalign.
      return jsonResponse({
        items: [
          { title: 'ט״ו בשבט', hebrew: 'ט״ו בשבט', date: '2026-02-02', category: 'holiday', subcat: 'minor' },
          ...HE_HOLIDAYS.items,
        ],
      });
    }
    return jsonResponse(EN_HOLIDAYS);
  }) as unknown as typeof fetch;

  const client = createHebcalClient({ fetchImpl });
  const holidays = await client.listHolidays(2026);
  // Still matched by date, so Pesach I keeps its correct Hebrew name.
  assert.equal(holidays[0]!.hebrewName, 'פסח א׳');
});

test('listCandleLighting reads venue-local HH:MM and keeps only candle events', async () => {
  let capturedUrl = '';
  const fetchImpl = (async (url: string) => {
    capturedUrl = String(url);
    return jsonResponse(CANDLES);
  }) as unknown as typeof fetch;

  const client = createHebcalClient({ fetchImpl });
  const fridays = await client.listCandleLighting(2026, { kind: 'geoname', geonameid: 293397 }, 40);

  assert.match(capturedUrl, /c=on/);
  assert.match(capturedUrl, /b=40/);
  assert.match(capturedUrl, /geonameid=293397/);
  assert.deepEqual(fridays, [
    { date: '2026-07-03', time: '19:11' },
    { date: '2026-07-10', time: '19:09' },
  ]);
});

test('a non-2xx response throws rather than fabricating data', async () => {
  const fetchImpl = (async () => jsonResponse({ error: 'nope' }, 500)) as unknown as typeof fetch;
  const client = createHebcalClient({ fetchImpl });
  await assert.rejects(() => client.listHolidays(2026), /\[hebcal\] fetch failed: 500/);
});
