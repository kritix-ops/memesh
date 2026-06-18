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
  expiresAt: string;
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
  expiresAt: string;
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
