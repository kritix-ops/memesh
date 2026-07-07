// Thin read-only client for the Hebcal Jewish Calendar REST API. The
// holiday-closures sync uses it to fetch a year of Israel holidays and the
// Friday candle-lighting times that Yanay maps to venue closures / special
// hours. No API key; Hebcal is free (CC-BY 4.0, attributed in the admin
// holidays screen) and rate-limited to 90 req/10s — we call it a few times a
// year, cached behind an admin-triggered sync.
//
// Two fetches back the holiday list: one in English for a stable cross-year
// key (the English title minus any trailing Hebrew-year, so "Rosh Hashana
// 5787" and next year's occurrence share one key) and one in Hebrew for the
// display name. Hebcal returns both in identical order for the same params, so
// we zip by index.

/** Raw event as Hebcal returns it in the `items` array. */
interface HebcalRawEvent {
  title: string;
  date: string;
  category: string;
  subcat?: string;
  hebrew?: string;
  yomtov?: boolean;
  memo?: string;
}

interface HebcalRawResponse {
  location?: { title?: string; tzid?: string };
  items?: HebcalRawEvent[];
}

/** A holiday day, joined across the English + Hebrew fetches. */
export interface HebcalHoliday {
  /** YYYY-MM-DD (venue-local calendar date). */
  date: string;
  /** Hebcal English title, e.g. "Pesach I", "Yom Kippur". */
  englishTitle: string;
  /** Display name in Hebrew without nikud, e.g. "פסח א׳". */
  hebrewName: string;
  /** 'major' | 'minor' | 'modern' | 'fast'. */
  subcat: string;
  /** true on work-forbidden yom tov days (Pesach I, Yom Kippur, …). */
  yomtov: boolean;
}

/** One Friday's candle-lighting time, in venue-local wall-clock. */
export interface HebcalCandleLighting {
  /** YYYY-MM-DD of the Friday. */
  date: string;
  /** Venue-local "HH:MM" of candle lighting (Shabbat entry). */
  time: string;
}

/** Location for candle-lighting: a GeoNames id or an explicit lat/long. */
export type HebcalGeo =
  | { kind: 'geoname'; geonameid: number }
  | { kind: 'pos'; latitude: number; longitude: number; tzid: string };

export interface HebcalClient {
  /**
   * All Israel-schedule holidays for a Gregorian year across every category
   * Yanay manages: major, minor, modern, and fasts. Throws on non-2xx or a
   * malformed response so the sync can treat "could not fetch" as a no-op and
   * never fabricate a closure.
   */
  listHolidays(year: number): Promise<HebcalHoliday[]>;

  /**
   * Friday candle-lighting times for a Gregorian year at the given location.
   * `offsetMinutes` is Hebcal's `b=` (minutes before sunset). The returned time
   * is already venue-local, so no sunset/DST math happens on our side. Throws on
   * non-2xx.
   */
  listCandleLighting(
    year: number,
    geo: HebcalGeo,
    offsetMinutes: number,
  ): Promise<HebcalCandleLighting[]>;
}

export interface HebcalClientConfig {
  /** Defaults to the public endpoint; overridable for tests. */
  baseUrl?: string;
  /** Injected for tests so we run without a real network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://www.hebcal.com/hebcal';

/**
 * Strip a trailing Hebrew calendar year ("Rosh Hashana 5787" -> "Rosh
 * Hashana") so a holiday keeps one identity across Gregorian years. Leaves
 * roman-numeral day markers ("Pesach I") intact.
 */
export const hebcalStableKey = (englishTitle: string): string =>
  englishTitle
    .replace(/\s+\d{3,4}$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const buildUrl = (baseUrl: string, params: Record<string, string>): string => {
  const qs = new URLSearchParams({ v: '1', cfg: 'json', ...params });
  return `${baseUrl}?${qs.toString()}`;
};

const fetchJson = async (
  fetcher: typeof fetch,
  url: string,
): Promise<HebcalRawResponse> => {
  const res = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[hebcal] fetch failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as HebcalRawResponse;
  if (!body || !Array.isArray(body.items)) {
    throw new Error('[hebcal] response missing items array');
  }
  return body;
};

export const createHebcalClient = (config: HebcalClientConfig = {}): HebcalClient => {
  const fetcher = config.fetchImpl ?? globalThis.fetch;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    listHolidays: async (year) => {
      // Every category Yanay manages, Israel schedule. maj/min/mod/mf cover
      // yom tov, minor, modern, and fasts respectively.
      const common = {
        year: String(year),
        i: 'on',
        maj: 'on',
        min: 'on',
        mod: 'on',
        mf: 'on',
      };
      const [en, he] = await Promise.all([
        fetchJson(fetcher, buildUrl(baseUrl, common)),
        fetchJson(fetcher, buildUrl(baseUrl, { ...common, lg: 'he' })),
      ]);
      const enItems = en.items ?? [];
      const heItems = he.items ?? [];
      // Same params + different language return parallel arrays; fall back to a
      // date map if a proxy ever reorders or drops one.
      const parallel = enItems.length === heItems.length;
      const heByDate = new Map(heItems.map((it) => [it.date, it]));

      const out: HebcalHoliday[] = [];
      enItems.forEach((item, i) => {
        if (item.category !== 'holiday') return;
        const heItem = parallel ? heItems[i] : heByDate.get(item.date);
        out.push({
          date: item.date,
          englishTitle: item.title,
          hebrewName: heItem?.hebrew ?? heItem?.title ?? item.title,
          subcat: item.subcat ?? 'major',
          yomtov: item.yomtov === true,
        });
      });
      return out;
    },

    listCandleLighting: async (year, geo, offsetMinutes) => {
      const geoParams: Record<string, string> =
        geo.kind === 'geoname'
          ? { geo: 'geoname', geonameid: String(geo.geonameid) }
          : {
              geo: 'pos',
              latitude: String(geo.latitude),
              longitude: String(geo.longitude),
              tzid: geo.tzid,
            };
      const body = await fetchJson(
        fetcher,
        buildUrl(baseUrl, {
          year: String(year),
          i: 'on',
          lg: 'he',
          c: 'on',
          b: String(offsetMinutes),
          M: 'on',
          ...geoParams,
        }),
      );
      const out: HebcalCandleLighting[] = [];
      for (const item of body.items ?? []) {
        if (item.category !== 'candles') continue;
        // date is an ISO datetime with the venue offset, e.g.
        // "2026-07-03T19:11:00+03:00" — the local wall-clock is positions 11-16.
        const date = item.date.slice(0, 10);
        const time = item.date.slice(11, 16);
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)) {
          out.push({ date, time });
        }
      }
      return out;
    },
  };
};
