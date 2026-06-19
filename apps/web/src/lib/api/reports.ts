import { apiRequest, type ApiResult } from '../api';

// Mirrors apps/api/src/routes/reports.ts response shapes. All endpoints
// gated to manager+admin server-side.

// ---------------------------------------------------------------------------
// Customers report
// ---------------------------------------------------------------------------

export interface CustomersReportRow {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  source: string | null;
  marketingConsentAt: string | null;
  createdAt: string;
  lastVisit: string | null;
  activeCards: number;
  totalCards: number;
}

export interface CustomersReportFilters {
  q?: string;
  registeredFrom?: string;
  registeredTo?: string;
  source?: 'referral' | 'social' | 'walk_by' | 'website' | 'other';
  marketingConsent?: boolean;
  hasActiveCard?: boolean;
  dormantSinceDays?: number;
  limit?: number;
  sort?: 'createdAt' | 'lastVisit' | 'customerNumber';
  sortDir?: 'asc' | 'desc';
}

const buildQS = (params: object): string => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') qs.set(k, v ? 'true' : 'false');
    else qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
};

export const fetchCustomersReport = (
  f: CustomersReportFilters = {},
): Promise<ApiResult<{ rows: CustomersReportRow[] }>> =>
  apiRequest(`/admin/reports/customers${buildQS(f)}`);

// ---------------------------------------------------------------------------
// Cards report
// ---------------------------------------------------------------------------

export interface CardsReportRow {
  id: string;
  serialNumber: string;
  customerId: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerPhone: string | null;
  totalEntries: number;
  usedEntries: number;
  isActive: boolean;
  expiresAt: string | null;
  cancelledAt: string | null;
  source: string;
  createdAt: string;
  usagePct: number;
}

export interface CardsReportFilters {
  q?: string;
  status?: 'active' | 'expired' | 'cancelled';
  source?: 'pos' | 'online' | 'manual';
  soldFrom?: string;
  soldTo?: string;
  expiringWithinDays?: number;
  usageMinPct?: number;
  usageMaxPct?: number;
  limit?: number;
  sort?: 'createdAt' | 'expiresAt' | 'usedEntries' | 'serialNumber';
  sortDir?: 'asc' | 'desc';
}

export const fetchCardsReport = (
  f: CardsReportFilters = {},
): Promise<ApiResult<{ rows: CardsReportRow[] }>> =>
  apiRequest(`/admin/reports/cards${buildQS(f)}`);

// ---------------------------------------------------------------------------
// Entries report
// ---------------------------------------------------------------------------

export interface EntriesReportRow {
  id: string;
  punchedAt: string;
  method: string;
  companionCount: number;
  refundedAt: string | null;
  refundReason: string | null;
  cardId: string;
  cardSerial: string;
  customerId: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  staffId: string | null;
  staffFirstName: string | null;
  staffLastName: string | null;
}

export interface EntriesReportFilters {
  from?: string;
  to?: string;
  customerId?: string;
  cardSerial?: string;
  method?: 'qr_scan' | 'serial' | 'phone' | 'manual';
  refunded?: boolean;
  punchedBy?: string;
  limit?: number;
  offset?: number;
}

export interface EntriesReportPage {
  rows: EntriesReportRow[];
  total: number;
}

export const fetchEntriesReport = (
  f: EntriesReportFilters = {},
): Promise<ApiResult<EntriesReportPage>> =>
  apiRequest(`/admin/reports/entries${buildQS(f)}`);

// ---------------------------------------------------------------------------
// Revenue report
// ---------------------------------------------------------------------------

export interface RevenueReportRow {
  period: string;
  cardsSold: number;
  estimatedRevenueShekels: number;
}

export interface RevenueReportResult {
  rows: RevenueReportRow[];
  estimatedFromPriceShekels: number;
  totalCardsSold: number;
  totalEstimatedRevenueShekels: number;
}

export interface RevenueReportFilters {
  from?: string;
  to?: string;
  groupBy?: 'day' | 'week' | 'month';
}

export const fetchRevenueReport = (
  f: RevenueReportFilters = {},
): Promise<ApiResult<RevenueReportResult>> =>
  apiRequest(`/admin/reports/revenue${buildQS(f)}`);
