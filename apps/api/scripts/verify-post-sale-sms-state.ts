// One-off verification helper: prints the per-customer marketing-consent
// flag and the current card_settings row's smsOnPurchase value, so we can
// answer "would the post-sale SMS actually go out today, given the link
// work we just shipped?" without firing a real sale.
//
// Usage:
//   tsx --env-file-if-exists=../../.env apps/api/scripts/verify-post-sale-sms-state.ts
//
// Read-only. Closes its own pool. Safe to run against prod (no writes).

import { fileURLToPath } from 'node:url';

async function run(): Promise<void> {
  const { db, customers, pool, getCardSettings } = await import('@memesh/db');

  try {
    const settings = await getCardSettings(db);
    console.info('[verify] card_settings', {
      smsOnPurchase: settings.smsOnPurchase,
      smsQuietStartMinutes: settings.smsQuietStartMinutes,
      smsQuietEndMinutes: settings.smsQuietEndMinutes,
      smsLowEntriesThreshold: settings.smsLowEntriesThreshold,
    });

    const rows = await db
      .select({
        id: customers.id,
        customerNumber: customers.customerNumber,
        firstName: customers.firstName,
        lastName: customers.lastName,
        phone: customers.phone,
        marketingConsentAt: customers.marketingConsentAt,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .limit(50);

    const total = rows.length;
    const withConsent = rows.filter((r) => r.marketingConsentAt !== null).length;
    console.info('[verify] customers sampled', {
      total,
      withConsent,
      withoutConsent: total - withConsent,
      consentRate: total === 0 ? 'n/a' : `${Math.round((withConsent / total) * 100)}%`,
    });

    for (const r of rows) {
      console.info('[verify] customer', {
        customerNumber: r.customerNumber,
        name: `${r.firstName} ${r.lastName}`,
        phone: r.phone,
        marketingConsentAt: r.marketingConsentAt
          ? r.marketingConsentAt.toISOString()
          : null,
      });
    }
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === entryPath) {
  await run();
}
