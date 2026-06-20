import { apiRequest, type ApiResult } from '../api';
import { type ChildRecord, type PreferredChannel, type PunchCard } from './customers';

// Customer-facing "me" surface. The /me endpoint returns the same shape as
// the customer profile view in apps/api/src/routes/me.ts (omits staff-only
// fields like internalNotes and registeredBy).

export interface CustomerProfile {
  id: string;
  customerNumber: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  preferredChannel: PreferredChannel;
  children: ChildRecord[];
}

export interface MeProfileResponse {
  profile: CustomerProfile;
}

export interface MyCardsResponse {
  cards: PunchCard[];
}

export interface UpdateMeInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  preferredChannel?: PreferredChannel;
  children?: ChildRecord[];
}

/** Fetch the logged-in customer's profile. */
export const getMe = (): Promise<ApiResult<MeProfileResponse>> =>
  apiRequest('/me', { audience: 'customer' });

/** Fetch the logged-in customer's active cards. */
export const getMyCards = (): Promise<ApiResult<MyCardsResponse>> =>
  apiRequest('/me/cards', { audience: 'customer' });

/** Update the logged-in customer's profile (phone is not editable). */
export const updateMe = (patch: UpdateMeInput): Promise<ApiResult<MeProfileResponse>> =>
  apiRequest('/me', { method: 'PATCH', body: patch, audience: 'customer' });
