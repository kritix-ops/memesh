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
