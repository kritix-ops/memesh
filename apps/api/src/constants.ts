// Tunable / configurable values for the api. Per the deferred-settings-layer
// convention (CLAUDE.md rule 15): all magic numbers live here so that when we
// add a DB-backed settings UI later, the refactor is a single-file edit.

export const WC_PRODUCT_TO_TICKET_TYPE = {
  300: 'child_single',
  304: 'baby_single',
  305: 'companion',
  306: 'punch_card',
} as const;

export type WcProductId = keyof typeof WC_PRODUCT_TO_TICKET_TYPE;
export type WcTicketType = (typeof WC_PRODUCT_TO_TICKET_TYPE)[WcProductId];

export const isKnownWcProductId = (id: number): id is WcProductId =>
  id in WC_PRODUCT_TO_TICKET_TYPE;

export const PRIMARY_WC_PRODUCT_IDS = [300, 304, 306] as const;
export const COMPANION_WC_PRODUCT_ID = 305 as const;

export const isPrimaryWcProductId = (id: number): boolean =>
  (PRIMARY_WC_PRODUCT_IDS as readonly number[]).includes(id);

export const PUNCH_CARD_ENTRIES = 12;
export const PUNCH_CARD_VALIDITY_DAYS = 365;
