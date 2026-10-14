// Client-side mirror of the server's card-status rule (cardIsCurrentlyActive
// in packages/db reports.ts). Nothing flips a card's isActive flag when its
// expiresAt passes (only exhaustion and cancellation do), so every status
// badge must derive date-expiry itself. Boundary matches the punch flow:
// expiresAt <= now is expired.

/** True when the card has an expiry date and it has already passed. */
export function isCardDateExpired(expiresAt: string | null, now: Date = new Date()): boolean {
  return expiresAt !== null && new Date(expiresAt).getTime() <= now.getTime();
}

/** True when the card is genuinely usable: flagged active AND not past its expiry date. */
export function isCardCurrentlyActive(
  card: { isActive: boolean; expiresAt: string | null },
  now: Date = new Date(),
): boolean {
  return card.isActive && !isCardDateExpired(card.expiresAt, now);
}
