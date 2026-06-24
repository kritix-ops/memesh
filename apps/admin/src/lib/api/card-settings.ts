import { apiRequest, type ApiResult } from '@memesh/web-shared';

// Mirrors apps/api/src/routes/card-settings.ts response shapes.

export type CancelRole = 'admin' | 'manager';

export interface CardSettings {
  id: string;
  singleton: boolean;
  // Pricing + lifetime
  priceShekels: number;
  validityDays: number;
  totalEntries: number;
  pitchLabel: string;
  // Mechanics
  sameDayLockoutMinutes: number;
  gracePeriodDays: number;
  // Cancellation
  allowCancelAfterFirstPunch: boolean;
  minCancelReasonLength: number;
  refundPolicyText: string;
  cancelRole: CancelRole;
  // SMS + email
  smsOnPurchase: boolean;
  emailOnPurchase: boolean;
  smsLowEntriesThreshold: number;
  smsQuietStartMinutes: number;
  smsQuietEndMinutes: number;
  // Operational + customer
  expiryBadgeThresholdDays: number;
  requireEmailOnNewCustomer: boolean;
  requireChildOnNewCustomer: boolean;
  // Cashier anti-fraud controls (Yanay 2026-06-20)
  requireReceiptNumberOnPos: boolean;
  requireSellerPin: boolean;
  pinLength: number;
  pinMemoryMinutes: number;
  pinMaxFailures: number;
  pinLockoutMinutes: number;
  // Editable customer-facing copy
  posNameOnReceiptLabel: string;
  posEmailNudgeText: string;
  emailOtpSubject: string;
  emailOtpBodyTemplate: string;
  // Editable thank-you page (my.memesh.co.il/checkout-complete after a WC
  // checkout). Same {{firstName}} placeholder semantics as the email-OTP
  // body template.
  checkoutThankyouTitle: string;
  checkoutThankyouBody: string;
  checkoutThankyouButtonText: string;

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

export interface CustomerFormRules {
  requireEmail: boolean;
  requireChild: boolean;
}

export interface CancelContext {
  refundPolicyText: string;
  minCancelReasonLength: number;
  allowCancelAfterFirstPunch: boolean;
  cancelRole: CancelRole;
}

export interface CardSettingsPatch {
  priceShekels?: number;
  validityDays?: number;
  totalEntries?: number;
  pitchLabel?: string;
  sameDayLockoutMinutes?: number;
  gracePeriodDays?: number;
  allowCancelAfterFirstPunch?: boolean;
  minCancelReasonLength?: number;
  refundPolicyText?: string;
  cancelRole?: CancelRole;
  smsOnPurchase?: boolean;
  emailOnPurchase?: boolean;
  smsLowEntriesThreshold?: number;
  smsQuietStartMinutes?: number;
  smsQuietEndMinutes?: number;
  expiryBadgeThresholdDays?: number;
  requireEmailOnNewCustomer?: boolean;
  requireChildOnNewCustomer?: boolean;
  requireReceiptNumberOnPos?: boolean;
  requireSellerPin?: boolean;
  pinLength?: number;
  pinMemoryMinutes?: number;
  pinMaxFailures?: number;
  pinLockoutMinutes?: number;
  posNameOnReceiptLabel?: string;
  posEmailNudgeText?: string;
  emailOtpSubject?: string;
  emailOtpBodyTemplate?: string;
  checkoutThankyouTitle?: string;
  checkoutThankyouBody?: string;
  checkoutThankyouButtonText?: string;
}

export const getCardSettings = (): Promise<ApiResult<CardSettingsResponse>> =>
  apiRequest('/admin/card-settings');

export const updateCardSettings = (
  patch: CardSettingsPatch,
): Promise<ApiResult<CardSettingsUpdatedResponse>> =>
  apiRequest('/admin/card-settings', { method: 'PATCH', body: patch });

export const getCardPricing = (): Promise<ApiResult<CardPricing>> =>
  apiRequest('/pos/card-pricing');

export const getCustomerFormRules = (): Promise<ApiResult<CustomerFormRules>> =>
  apiRequest('/pos/customer-form-rules');

export const getCancelContext = (): Promise<ApiResult<CancelContext>> =>
  apiRequest('/admin/cancel-context');

// Sell-flow controls exposed to the cashier POS so the modal can render the
// right inputs (receipt number, PIN prompt) and the editable Hebrew labels
// without round-tripping through the admin settings endpoint.
export interface PosSellControls {
  requireReceiptNumberOnPos: boolean;
  requireSellerPin: boolean;
  pinLength: number;
  pinMemoryMinutes: number;
  nameOnReceiptLabel: string;
  emailNudgeText: string;
}

export const getPosSellControls = (): Promise<ApiResult<PosSellControls>> =>
  apiRequest('/pos/sell-controls');

// HH:MM helpers used by the SMS quiet-hours fields.
export const formatHHMM = (minutes: number): string => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
export const parseHHMM = (input: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return undefined;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return undefined;
  if (hours < 0 || hours > 23 || mins < 0 || mins > 59) return undefined;
  return hours * 60 + mins;
};
