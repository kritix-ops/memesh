import { apiRequest, type ApiResult } from '../api';
import { type PunchCard } from './customers';

// Mirrors apps/api/src/routes/cards.ts response shape. The server allocates the
// serial (M-YYYYMMDD-NNNN), mints the signed QR token, and stores the card.
// Payment is taken externally in AccuPOS; the cashier confirms in this app.

export interface SellCardInput {
  customerId: string;
  /** Defaults to 12 server-side. */
  totalEntries?: number;
  /** Defaults to 'pos' server-side. */
  source?: 'pos' | 'online' | 'manual';
}

export interface SellCardResponse {
  card: PunchCard;
}

/** Sell a punch card to an existing customer. */
export const sellCard = (input: SellCardInput): Promise<ApiResult<SellCardResponse>> =>
  apiRequest('/cards', { method: 'POST', body: input });

// ---------------------------------------------------------------------------
// Admin list (GET /cards?status=...) — joined with customer info.
// ---------------------------------------------------------------------------

export type CardListStatus = 'active' | 'expired' | 'cancelled';

export interface AdminCardRow {
  id: string;
  customerId: string;
  serialNumber: string;
  totalEntries: number;
  usedEntries: number;
  isActive: boolean;
  /** null = "forever" card. */
  expiresAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  source: 'pos' | 'online' | 'manual';
  createdAt: string;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerNumber: string | null;
  customerPhone: string | null;
}

export interface AdminCardListResponse {
  cards: AdminCardRow[];
}

/** List cards (admin/manager) joined with customer info, optionally filtered. */
export const listCardsForAdmin = (
  opts: { status?: CardListStatus; limit?: number } = {},
): Promise<ApiResult<AdminCardListResponse>> => {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiRequest(`/cards${qs ? `?${qs}` : ''}`);
};

// Detail for the admin "drill into a card" modal. Mirrors the shape returned
// by GET /cards/:id on the API (joined customer + full entry history).

export interface CardDetailCard {
  id: string;
  customerId: string;
  serialNumber: string;
  keyId: string;
  totalEntries: number;
  usedEntries: number;
  isActive: boolean;
  /** null = "forever" card. */
  expiresAt: string | null;
  source: 'pos' | 'online' | 'manual';
  wcOrderId: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  customerNumber: string | null;
  customerFirstName: string | null;
  customerLastName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
}

export interface CardDetailEntry {
  id: string;
  punchedAt: string;
  method: string;
  companionCount: number;
  notes: string | null;
  punchedBy: string | null;
  staffFirstName: string | null;
  staffLastName: string | null;
  /** Non-null when the entry has been refunded. */
  refundedAt: string | null;
  refundReason: string | null;
}

export interface CardDetailResponse {
  card: CardDetailCard;
  entries: CardDetailEntry[];
}

/** Fetch one card with its customer + full entry history. Admin/manager only. */
export const getCardDetail = (id: string): Promise<ApiResult<CardDetailResponse>> =>
  apiRequest(`/cards/${id}`);

export interface CancelCardResponse {
  card: {
    id: string;
    serialNumber: string;
    isActive: boolean;
    cancelledAt: string;
    cancelReason: string;
  };
}

/** Cancel a card by id with a required reason. Manager + admin only. */
export const cancelCardForAdmin = (
  id: string,
  reason: string,
): Promise<ApiResult<CancelCardResponse>> =>
  apiRequest(`/cards/${id}/cancel`, { method: 'POST', body: { reason } });

// ---------------------------------------------------------------------------
// Refund a single entry. Admin can refund alone; cashier+manager must supply
// adminPassword which the server bcrypt-compares to active admins.
// ---------------------------------------------------------------------------

export interface RefundEntryResponse {
  entryId: string;
  cardId: string;
  usedEntries: number;
  totalEntries: number;
  remaining: number;
  reactivated: boolean;
}

export interface RefundEntryInput {
  reason: string;
  /** Required when the signed-in user is not admin. */
  adminPassword?: string;
}

export const refundEntry = (
  cardId: string,
  entryId: string,
  input: RefundEntryInput,
): Promise<ApiResult<RefundEntryResponse>> =>
  apiRequest(`/cards/${cardId}/entries/${entryId}/refund`, {
    method: 'POST',
    body: input,
  });

// ---------------------------------------------------------------------------
// Admin-only card creation with overrides + reassign.
// ---------------------------------------------------------------------------

export interface AdminCreateCardInput {
  customerId: string;
  totalEntries?: number;
  /** undefined = settings default, null or 0 = forever, N = N days. */
  validityDays?: number | null;
  source?: 'pos' | 'online' | 'manual';
}

export const createCardForAdmin = (
  input: AdminCreateCardInput,
): Promise<ApiResult<SellCardResponse>> =>
  apiRequest('/admin/cards', { method: 'POST', body: input });

export interface ReassignCardResponse {
  card: {
    id: string;
    customerId: string;
    serialNumber: string;
    usedEntries: number;
    totalEntries: number;
  };
  fromCustomerNumber: string | null;
}

export const reassignCardToCustomer = (
  cardId: string,
  customerId: string,
): Promise<ApiResult<ReassignCardResponse>> =>
  apiRequest(`/cards/${cardId}/reassign`, { method: 'POST', body: { customerId } });

// ---------------------------------------------------------------------------
// Admin-only direct edit of an existing card.
//   - expiresAt: undefined = keep, null = forever, "YYYY-MM-DD" = set
//   - totalEntries: number 1..1000
//   - source: pos / online / manual
// ---------------------------------------------------------------------------

export interface EditCardInput {
  totalEntries?: number;
  source?: 'pos' | 'online' | 'manual';
  expiresAt?: string | null;
}

export interface EditCardResponse {
  card: AdminCardRow;
  diff: Record<string, [unknown, unknown]>;
  reactivated: boolean;
}

export const editCardForAdmin = (
  cardId: string,
  input: EditCardInput,
): Promise<ApiResult<EditCardResponse>> =>
  apiRequest(`/cards/${cardId}/edit`, { method: 'POST', body: input });
