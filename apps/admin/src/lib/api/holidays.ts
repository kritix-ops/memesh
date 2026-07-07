import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors apps/api/src/routes/holidays-admin.ts. Admin-only Jewish-holiday +
// Shabbat closures. Times are "HH:MM"; a policy is one of normal / special_hours
// / closed and applies to the holiday every year.

export type HolidayPolicyState = 'normal' | 'closed' | 'special_hours';

export interface HolidayCalendarEntry {
  holidayKey: string;
  hebrewName: string;
  /** 'major' | 'minor' | 'modern' | 'fast' | 'shabbat'. */
  category: string;
  yomtov: boolean;
  policy: HolidayPolicyState;
  confirmed: boolean;
  openTime: string | null;
  closeTime: string | null;
  shabbatCloseOffsetMinutes: number | null;
  note: string | null;
  /** Occurrence date(s) this year — one per holiday, every Friday for Shabbat. */
  dates: string[];
}

export interface HolidayCalendar {
  year: number;
  entries: HolidayCalendarEntry[];
}

export interface HolidayPolicyPatch {
  /** The year to re-materialize after the change. Required. */
  year: number;
  policy?: HolidayPolicyState;
  openTime?: string | null;
  closeTime?: string | null;
  shabbatCloseOffsetMinutes?: number | null;
  note?: string | null;
  confirmed?: boolean;
}

export interface HolidaySyncResult {
  year: number;
  holidays: number;
  fridays: number;
  policiesInserted: number;
  policiesRefreshed: number;
  rulesDeleted: number;
  rulesCreated: number;
}

export const getHolidayCalendar = (year: number): Promise<ApiResult<HolidayCalendar>> =>
  apiRequest(`/admin/holidays?year=${year}`);

export const setHolidayPolicy = (
  key: string,
  patch: HolidayPolicyPatch,
): Promise<ApiResult<{ policy: HolidayCalendarEntry; regenerated: unknown; warning?: string }>> =>
  apiRequest(`/admin/holidays/${key}`, { method: 'PATCH', body: patch });

export const syncHolidays = (year: number): Promise<ApiResult<HolidaySyncResult>> =>
  apiRequest(`/admin/holidays/sync?year=${year}`, { method: 'POST' });
