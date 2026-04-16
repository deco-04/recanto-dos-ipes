'use strict';

/**
 * fix-direct-duplicates.js
 * ─────────────────────────────────────────────────────────────────────────
 * PROBLEM: The original import-financeiro.js created 30 WhatsApp direct
 * bookings WITHOUT cross-referencing the Airbnb CSV. Many of those guests
 * first contacted via WhatsApp, then completed booking through Airbnb.
 * Result: 21 phantom bookings that duplicate real Airbnb/Booking.com stays.
 *
 * FIX:
 *  1. Delete 21 DIRECT bookings whose dates overlap verified OTA bookings
 *  2. Correct Jenepher Felício's amount to net-of-refund (R$4,000 - R$829 = R$3,171)
 *  3. Print final corrected revenue totals
 *
 * Safe to re-run — deletes only by known externalId, updates only by externalId.
 */

const prisma = require('../lib/db');
const RDI_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

// ── Bookings to delete ──────────────────────────────────────────────────────
// Each of these conflicts with a verified Airbnb or Booking.com booking on
// the same dates. The OTA booking is ground truth (Airbnb CSV / bank-verified
// invoices). The WhatsApp estimated entry is the duplicate.
//
// Conflict evidence shown as: [source] GuestName | dates | amount
const DUPLICATES_TO_DELETE = [
  // Conflicts with AIRBNB HMAWMABWFF (Rodrigo Augusto, Dec 23-25 2023)
  { id: 'direct-FERNANDO-HENRIQUE-2023-12-22',  amount: 6070.00, reason: 'AIRBNB HMAWMABWFF (Rodrigo Augusto, Dec 23-25 2023)' },

  // Conflicts with AIRBNB HM4XF2RT3Q (Filipe Monteiro, Dec 27-Jan 1 2024)
  { id: 'direct-VICTORIA-MUELLER-2023-12',       amount: 600.00,  reason: 'AIRBNB HM4XF2RT3Q (Filipe Monteiro, Dec 27-Jan 1 2024)' },

  // Conflicts with AIRBNB HMCMF5JCAD (Raquel Jardim, Feb 9-14 2024) — completely contained
  { id: 'direct-MARCO-TULIO-2024-02-10',         amount: 1970.00, reason: 'AIRBNB HMCMF5JCAD (Raquel Jardim, Feb 9-14 2024)' },

  // Conflicts with AIRBNB HMM8AQY54J (Daniel Filipe, Mar 2-3 2024)
  { id: 'direct-RAFAEL-BRANDAO-2024-02-29',      amount: 6070.00, reason: 'AIRBNB HMM8AQY54J (Daniel Filipe, Mar 2-3 2024)' },

  // Conflicts with AIRBNB HMSNB3JQJF (Ageu E Debora, May 25-26 2024)
  { id: 'direct-HENRIQUE-MACIEL-2024-05-25',     amount: 2070.00, reason: 'AIRBNB HMSNB3JQJF (Ageu E Debora, May 25-26 2024)' },

  // Conflicts with AIRBNB HMDQDTQATS (Eduardo Gomes, Jun 29-30 2024)
  { id: 'direct-PATRICIA-LIMA-2024-06-29',       amount: 2370.00, reason: 'AIRBNB HMDQDTQATS (Eduardo Gomes, Jun 29-30 2024)' },

  // Conflicts with AIRBNB HMKTKEPMNY (Nayara Carcheno, Jul 27-28 2024)
  { id: 'direct-ANDREIA-2024-07-27',             amount: 2870.00, reason: 'AIRBNB HMKTKEPMNY (Nayara Carcheno, Jul 27-28 2024)' },

  // Conflicts with AIRBNB HM5ZE2MRR5 (Karen Karolina, Sep 14-15 2024)
  { id: 'direct-ALEXANDRE-2024-09-14',           amount: 1710.00, reason: 'AIRBNB HM5ZE2MRR5 (Karen Karolina, Sep 14-15 2024)' },

  // Conflicts with AIRBNB HM2PZSKPQ9 (Lucas Prado, Sep 21-22 2024) AND Jenepher
  { id: 'direct-ERNANE-LUCAS-2024-09',           amount: 180.00,  reason: 'AIRBNB HM2PZSKPQ9 (Lucas Prado, Sep 21-22) + Jenepher overlap' },

  // Conflicts with AIRBNB HMWTR9AP5T (Patrícia Guimarães, Oct 11-13 2024)
  { id: 'direct-RENATA-OLIVEIRA-2024-10-12',     amount: 1710.00, reason: 'AIRBNB HMWTR9AP5T (Patricia Guimarães, Oct 11-13 2024)' },

  // Conflicts with AIRBNB HMKEZTBM2D (Igo Souza, Nov 15-17 2024)
  { id: 'direct-GERALDO-2024-11-16',             amount: 1710.00, reason: 'AIRBNB HMKEZTBM2D (Igo Souza, Nov 15-17 2024)' },

  // Conflicts with AIRBNB HM39E2PTB8 (Rosana Cupertino, Dec 21-25 2024) — same exact dates
  { id: 'direct-LUCAS-2024-12-21',               amount: 6070.00, reason: 'AIRBNB HM39E2PTB8 (Rosana Cupertino, Dec 21-25 2024)' },

  // Conflicts with AIRBNB HMEWTK5AQA (Paulo Otávio, Jan 3-5 2025)
  { id: 'direct-BRUNA-2025-01-04',               amount: 2870.00, reason: 'AIRBNB HMEWTK5AQA (Paulo Otávio Alves, Jan 3-5 2025)' },

  // Conflicts with AIRBNB HMYR2BBDAS (Paulinho Ricardo, Feb 8-9 2025)
  { id: 'direct-VANESSA-2025-02-08',             amount: 1970.00, reason: 'AIRBNB HMYR2BBDAS (Paulinho Ricardo, Feb 8-9 2025)' },

  // Conflicts with AIRBNB HMJSH83F9Q (Raquel Jardim, Mar 1-5 2025)
  { id: 'direct-RAQUEL-RIBEIRO-2025-02',         amount: 650.00,  reason: 'AIRBNB HMJSH83F9Q (Raquel Jardim Jardim, Mar 1-5 2025)' },

  // Conflicts with AIRBNB HMKXKKAFZ9 (Pedro Cardoso, Mar 7-9 2025)
  { id: 'direct-CAMILA-NUNES-2025-03-08',        amount: 2470.00, reason: 'AIRBNB HMKXKKAFZ9 (Pedro Cardoso, Mar 7-9 2025)' },

  // R$150 deposit conflicts with Fábio (Apr 18-21) — too small to be independent booking
  { id: 'direct-PATRICK-MEIRELES-2025-04',       amount: 150.00,  reason: 'Conflicts with Fábio (Apr 18-21); R$150 too small to be full booking' },

  // Conflicts with AIRBNB HMHPSB3YCM (Eduarda Azevedo, Jul 12-13 2025)
  { id: 'direct-GMAP-2025-07',                   amount: 325.00,  reason: 'AIRBNB HMHPSB3YCM (Eduarda Azevedo, Jul 12-13 2025)' },

  // Conflicts with AIRBNB HMWZQHK3S9 (Tamiris Barbara, Sep 20-21 2025)
  { id: 'direct-GISELE-2025-09-20',              amount: 1710.00, reason: 'AIRBNB HMWZQHK3S9 (Tamiris Barbara, Sep 20-21 2025)' },

  // R$200 conflicts with AIRBNB Tamiris (same dates Sep 20-21/22 2025)
  { id: 'direct-CRISTIANA-ANDRADE-2025-09',      amount: 200.00,  reason: 'AIRBNB HMWZQHK3S9 (Tamiris Barbara, Sep 20-21 2025)' },

  // Conflicts with BOOKING_COM bcom-6413085515 (Rodrigo Castro, Jan 30-Feb 1 2026)
  { id: 'direct-MARINA-CORREA-2026-01',          amount: 400.00,  reason: 'BOOKING_COM bcom-6413085515 (Rodrigo Castro, Jan 30-Feb 1 2026)' },
];

// ── Amount corrections ──────────────────────────────────────────────────────
// Jenepher Felício: bank shows R$4,000 received, but R$829 was later refunded
// (expense JENEPHER SILVA / Transf Pix enviada, 2024-09-30, classified OUTROS)
// Net revenue = R$4,000 - R$829 = R$3,171
const AMOUNT_CORRECTIONS = [
  {
    externalId:   'direct-JENEPHER-FELICIO-2024-09',
    newAmount:    3171.00,
    reason:       'Deducted R$829 partial refund (Jenepher Silva PIX, 2024-09-30)',
  },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== fix-direct-duplicates.js ===\n');

  // Step 1: Delete phantom duplicate bookings
  console.log('[1] Deleting phantom duplicate bookings...');
  let deleted = 0, notFound = 0;
  let totalDeleted = 0;

  for (const d of DUPLICATES_TO_DELETE) {
    const b = await prisma.booking.findUnique({ where: { externalId: d.id } });
    if (!b) { notFound++; continue; }

    await prisma.bookingGuest.deleteMany({ where: { bookingId: b.id } });
    await prisma.booking.delete({ where: { id: b.id } });
    deleted++;
    totalDeleted += d.amount;
    console.log(`  ✓ Deleted: ${d.id} (R$${d.amount.toFixed(2)}) — ${d.reason}`);
  }
  console.log(`\n  Deleted: ${deleted} | Already gone: ${notFound}`);
  console.log(`  Revenue removed: R$${totalDeleted.toFixed(2)}`);

  // Step 2: Correct Jenepher's amount
  console.log('\n[2] Correcting booking amounts...');
  let corrected = 0;

  for (const c of AMOUNT_CORRECTIONS) {
    const b = await prisma.booking.findUnique({ where: { externalId: c.externalId } });
    if (!b) { console.log(`  ⚠ Not found: ${c.externalId}`); continue; }

    const old = parseFloat(String(b.totalAmount));
    await prisma.booking.update({
      where: { externalId: c.externalId },
      data:  { totalAmount: c.newAmount, baseRatePerNight: parseFloat((c.newAmount / Math.max(b.nights, 1)).toFixed(2)) },
    });
    corrected++;
    console.log(`  ✓ Corrected: ${c.externalId} R$${old.toFixed(2)} → R$${c.newAmount.toFixed(2)} (${c.reason})`);
  }

  // Step 3: Summary
  console.log('\n[3] Updated revenue totals...');
  const bySource = await prisma.$queryRawUnsafe(`
    SELECT source::text, COUNT(*)::int AS cnt, ROUND(SUM("totalAmount")::numeric, 2) AS total
    FROM "Booking" WHERE "propertyId" = $1 AND status = 'CONFIRMED'
    GROUP BY source ORDER BY SUM("totalAmount") DESC
  `, RDI_ID);

  let grand = 0;
  for (const s of bySource) {
    const t = parseFloat(s.total);
    grand += t;
    console.log(`  ${s.source.padEnd(12)} ${String(s.cnt).padStart(3)} bookings  R$${t.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(12)} ${''.padStart(3)}           R$${grand.toFixed(2).padStart(12)}`);

  console.log('\n  Note on Jenepher Felício (direct-JENEPHER-FELICIO-2024-09):');
  console.log('  → Conflicts with Airbnb HM2PZSKPQ9 (Lucas Prado, Sep 21-22 2024).');
  console.log('  → Bank shows R$4,000 received + R$829 refunded = net R$3,171.');
  console.log('  → Kept in DB at corrected amount. Review with André if dates need adjustment.');

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
