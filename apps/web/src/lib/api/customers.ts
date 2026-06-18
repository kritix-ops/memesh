import { apiRequest, type ApiResult } from '../api';

// Mirrors the brief-v3 customers schema (apps/api returns these directly from
// Drizzle's $inferSelect). Kept as a frontend-local interface so the web app
// doesn't import @memesh/db (which would drag pg into the browser bundle).

export type PreferredChannel = 'sms' | 'whatsapp' | 'email';
export type CustomerStatus = 'active' | 'frozen' | 'vip';
export type CustomerSource = 'referral' | 'social' | 'walk_by' | 'website' | 'other' | null;

export interface ChildRecord {
  name: string;
  dob: string; // yyyy-mm-dd
  notes?: string;
}

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

export interface PunchCard {
  id: string;
  customerId: string;
  wcOrderId: number | null;
  serialNumber: string;
  qrToken: string;
  keyId: string;
  totalEntries: number;
  usedEntries: number;
  isActive: boolean;
  expiresAt: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PunchCardEntry {
  id: string;
  punchCardId: string;
  punchedBy: string | null;
  method: string;
  companionCount: number;
  idempotencyKey: string | null;
  notes: string | null;
  punchedAt: string;
}

export interface CustomerSearchResponse {
  results: Customer[];
}

export interface CustomerDetailResponse {
  customer: Customer;
  cards: PunchCard[];
  entries: PunchCardEntry[];
}

/** Search customers by name, phone, or customer number. The API caps at 20 results. */
export const searchCustomers = (
  q: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ApiResult<CustomerSearchResponse>> => {
  const params = new URLSearchParams({ q });
  return apiRequest(`/customers?${params.toString()}`, opts.signal ? { signal: opts.signal } : {});
};

/** Fetch a single customer with their punch cards and recent entries. */
export const getCustomerDetail = (id: string): Promise<ApiResult<CustomerDetailResponse>> =>
  apiRequest(`/customers/${id}`);

// Mirrors createBodySchema in apps/api/src/routes/customers.ts. Email is optional;
// preferredChannel defaults to 'sms' server-side when omitted.
export interface CreateCustomerInput {
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  preferredChannel?: PreferredChannel;
}

export interface CreateCustomerResponse {
  customer: Customer;
}

/** Register a new customer (allocates the L-NNNN customer number). */
export const createCustomer = (
  input: CreateCustomerInput,
): Promise<ApiResult<CreateCustomerResponse>> =>
  apiRequest('/customers', { method: 'POST', body: input });
