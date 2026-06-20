// Frontend-side shapes for customer/card data. These mirror the API responses
// from apps/api but live in @memesh/web-shared so multiple frontend packages
// (customer-auth's /me client, the staff/admin customers client) can reference
// the same types without depending on @memesh/db (which would drag pg into the
// browser bundle).

export type PreferredChannel = 'sms' | 'whatsapp' | 'email';

export interface ChildRecord {
  name: string;
  dob: string; // yyyy-mm-dd
  notes?: string;
}

export interface PunchCard {
  id: string;
  customerId: string;
  wcOrderId: string | null;
  serialNumber: string;
  qrToken: string;
  keyId: string;
  totalEntries: number;
  usedEntries: number;
  isActive: boolean;
  /** null = "forever" card (created when settings.validityDays=0). */
  expiresAt: string | null;
  source: 'pos' | 'online' | 'manual';
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}
