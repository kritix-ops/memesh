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

export interface CustomerSearchResponse {
  results: Customer[];
}

export interface CustomerDetailResponse {
  customer: Customer;
  cards: PunchCard[];
  entries: PunchCardEntry[];
}

/**
 * List or search customers. With a non-empty `q`, returns up to 20 matches
 * by name, phone, or customer number. With an empty `q` (or omitted), the
 * server returns the 50 most recently created customers — used as the
 * default list on the admin Customers tab so the operator sees existing
 * customers without having to type a search.
 */
export const searchCustomers = (
  q: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<CustomerSearchResponse>> => {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
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

/**
 * Change a customer's phone number (admin/manager only). Phone is the customer's
 * login identity, so this is the staff-only override for the "customer changed
 * her number" case. Returns `phone_taken` (409) when another customer already
 * owns the number. The server normalizes the input, so any local formatting is
 * accepted.
 */
export const updateCustomerPhone = (
  id: string,
  phone: string,
): Promise<ApiResult<{ customer: Customer }>> =>
  apiRequest(`/customers/${id}/phone`, { method: 'PATCH', body: { phone } });
