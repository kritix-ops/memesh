import {
  apiRequest,
  type ApiResult,
  type ChildRecord,
  type PreferredChannel,
  type PunchCard,
} from '@memesh/web-shared';

// Re-export the shared customer/card types so files importing them from
// './customers' (PosApp, AdminApp, etc.) keep working through Phase 1.
// The canonical home is @memesh/web-shared; this is a compatibility surface.
export type { ChildRecord, PreferredChannel, PunchCard };

// Mirrors the brief-v3 customers schema (apps/api returns these directly from
// Drizzle's $inferSelect). Kept as a frontend-local interface so the web app
// doesn't import @memesh/db (which would drag pg into the browser bundle).

export type CustomerStatus = 'active' | 'frozen' | 'vip';
export type CustomerSourceValue = 'referral' | 'social' | 'walk_by' | 'website' | 'other';
export type CustomerSource = CustomerSourceValue | null;

export interface Customer {
  id: string;
  customerNumber: string; // L-NNNN
  wpUserId: number | null;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  preferredChannel: PreferredChannel;
  children: ChildRecord[];
  internalNotes: string | null;
  source: CustomerSource;
  status: CustomerStatus;
  marketingConsentAt: string | null;
  registeredBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PunchCardEntry {
  id: string;
  punchCardId: string;
  punchedBy: string | null;
  method: string;
  entriesConsumed: number;
  idempotencyKey: string | null;
  notes: string | null;
  punchedAt: string;
  /** Non-null when the entry has been refunded. */
  refundedAt: string | null;
  refundReason: string | null;
}

// Directory browse/sort/filter params understood by GET /customers. Mirrors
// listQuerySchema in apps/api/src/routes/customers.ts.
export type CustomerSort = 'name' | 'newest' | 'oldest' | 'lastPurchase';

export interface CustomerListFilters {
  sort?: CustomerSort;
  status?: CustomerStatus;
  hasActiveCard?: boolean;
  limit?: number;
  offset?: number;
}

export interface CustomerDirectoryEntry extends Customer {
  /** ISO timestamp of the most recent card purchase, null if none. */
  lastPurchaseAt: string | null;
}

export interface CustomerSearchResponse {
  results: CustomerDirectoryEntry[];
  /** Count across ALL pages of the current filter set, not just this one. */
  total: number;
}

export interface CustomerDetailResponse {
  customer: Customer;
  cards: PunchCard[];
  entries: PunchCardEntry[];
}

/**
 * List or search customers — the directory behind the staff lookup screen
 * and the admin Customers tab. `q` matches name, phone, customer number, or
 * email; sort/status/hasActiveCard/limit/offset compose with it server-side.
 * With no options at all the server keeps its legacy defaults (newest first,
 * 50 rows without q, 20 with), so existing callers behave as before.
 */
export const searchCustomers = (
  q: string,
  opts: CustomerListFilters & { signal?: AbortSignal } = {},
): Promise<ApiResult<CustomerSearchResponse>> => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.status) params.set('status', opts.status);
  if (opts.hasActiveCard !== undefined) params.set('hasActiveCard', String(opts.hasActiveCard));
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  const url = qs ? `/customers?${qs}` : '/customers';
  return apiRequest(url, opts.signal ? { signal: opts.signal } : {});
};

/** Fetch a single customer with their punch cards and recent entries. */
export const getCustomerDetail = (id: string): Promise<ApiResult<CustomerDetailResponse>> =>
  apiRequest(`/customers/${id}`);

// Mirrors createBodySchema in apps/api/src/routes/customers.ts. Email is
// optional; preferredChannel defaults to 'sms' server-side when omitted.
// Marketing fields (source / children / marketingConsent) are all independently
// optional — see Yanai feedback item 2.
export interface CreateCustomerInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  preferredChannel?: PreferredChannel;
  source?: CustomerSourceValue;
  children?: ChildRecord[];
  marketingConsent?: boolean;
}

export interface CreateCustomerResponse {
  customer: Customer;
}

/** Register a new customer (allocates the L-NNNN customer number). */
export const createCustomer = (
  input: CreateCustomerInput,
): Promise<ApiResult<CreateCustomerResponse>> =>
  apiRequest('/customers', { method: 'POST', body: input });

/**
 * Hard-delete a customer (admin/manager only). Returns the `has_dependents`
 * error code when the customer still has cards in any state — the UI surfaces
 * a "cancel/clear cards first" message and keeps the row visible.
 */
export const deleteCustomerById = (id: string): Promise<ApiResult<{ ok: true }>> =>
  apiRequest(`/customers/${id}`, { method: 'DELETE' });
