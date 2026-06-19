import { apiRequest, type ApiResult } from '../api';

// Mirrors apps/api/src/routes/card-settings.ts response shapes.

export interface CardSettings {
  id: string;
  singleton: boolean;
  priceShekels: number;
  validityDays: number;
  totalEntries: number;
  pitchLabel: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface CardSettingsResponse {
  settings: CardSettings;
}

export interface CardSettingsUpdatedResponse {
  settings: CardSettings;
  diff: Record<string, [unknown, unknown]>;
}

export interface CardPricing {
  priceShekels: number;
  pitchLabel: string;
}

export interface CardSettingsPatch {
  priceShekels?: number;
  validityDays?: number;
  totalEntries?: number;
  pitchLabel?: string;
}

export const getCardSettings = (): Promise<ApiResult<CardSettingsResponse>> =>
  apiRequest('/admin/card-settings');

export const updateCardSettings = (
  patch: CardSettingsPatch,
): Promise<ApiResult<CardSettingsUpdatedResponse>> =>
  apiRequest('/admin/card-settings', { method: 'PATCH', body: patch });

export const getCardPricing = (): Promise<ApiResult<CardPricing>> =>
  apiRequest('/pos/card-pricing');
