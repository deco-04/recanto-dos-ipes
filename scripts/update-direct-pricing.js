'use strict';

/**
 * update-direct-pricing.js
 * ─────────────────────────────────────────────────────────────────────────
 * Two corrections:
 *
 *  1. Bank balance note fix on 2026-04-15 expenses:
 *     R$21,586.77 is the confirmed balance AFTER the 4 payments (not before).
 *
 *  2. Update WA-estimated DIRECT bookings (checkIn ≥ 2025-01-01) with
 *     current Airbnb dynamic pricing range R$770–R$1,500/noite:
 *
 *     2024 rates (historical, kept):  LOW=720 | MID=850 | HIGH_MID=1050 | PEAK=1300
 *     2025+ rates (updated):          LOW=770 | MID=950 | HIGH_MID=1150 | PEAK=1500
 *
 *     Formula (unchanged): rate × nights + max(0, guests-11) × 50 × nights + 270
 *
 *  Safe to re-run — compares before/after amounts and skips already-correct rows.
 */

const prisma = require('../lib/db');

// ── Updated tier prices (2025+) ──────────────────────────────────────────────
const TIER_PRICES_2025 = { LOW: 770, MID: 950, HIGH_MID: 1150, PEAK: 1500 };
const TIER_PRICES_2024 = { LOW: 720, MID: 850, HIGH_MID: 1050, PEAK: 1300 }; // kept for reference
const BASE_GUESTS   = 11;
const EXTRA_FEE     = 50;   // per extra guest, per night
const CLEANING_FEE  = 270;  // fixed base

function calcTotal(rate, nights, guests) {
  const extra = Math.max(0, guests - BASE_GUESTS) * EXTRA_FEE * nights;
  return rate * nights + extra + CLEANING_FEE;
}

// ── Mapping: externalId → tier (only 2025+ WA-estimated bookings) ────────────
// Bank-verified entries (Victoria, Marcella, Marcio) are NOT tier-estimated — skip.
const WA_TIERS_2025 = {
  'direct-FABIO-2025-04-18':             'PEAK',
  'direct-MARCIA-2025-05-24':            'LOW',
  'direct-RODRIGO-2025-06-14':           'LOW',
  'direct-DANIELA-2025-07-05':           'PEAK',
  'direct-IGOR-2025-08-09':              'LOW',
  'direct-CARLOS-EDUARDO-2025-11-29':    'LOW',
  'direct-FERNANDA-E-AMIGAS-2025-12-20': 'PEAK',
};

// ── Bank balance expense IDs to fix ──────────────────────────────────────────
const EXPENSE_BANKREF_FIRST = '15/04/2026|CAPAS TRAVESSEIRO IMPERM|150.00';

async function main() {
  console.log('=== update-direct-pricing.js ===\n');

  // ── 1. Fix expense note (bank balance is AFTER payments) ──────────────────
  console.log('[1] Fixing bank balance note on 2026-04-15 expenses...');

  const firstExp = await prisma.expense.findFirst({ where: { bankRef: EXPENSE_BANKREF_FIRST } });
  if (firstExp) {
    const oldNote = firstExp.notes || '';
    if (oldNote.includes('antes')) {
      await prisma.expense.update({
        where: { id: firstExp.id },
        data:  {
          notes: 'Compra de capas de travesseiro impermeáveis. Saldo banco em 15/04/2026 (confirmado após os 4 pagamentos do dia): R$21.586,77.',
        },
      });
      console.log('  ✓ Updated note: "antes" → confirmed balance after payments');
    } else {
      console.log('  ⚠ Note already correct — skipping');
    }
  } else {
    console.log('  ⚠ Expense not found (bankRef:', EXPENSE_BANKREF_FIRST, ')');
  }

  // ── 2. Update WA-estimated 2025 booking amounts ────────────────────────────
  console.log('\n[2] Updating 2025+ WA-estimated DIRECT booking amounts...\n');
  console.log('  ExternalId                               Guests  Nights  Tier       Old Amount   New Amount    Δ');
  console.log('  ──────────────────────────────────────────────────────────────────────────────────────────────────');

  let totalOld = 0, totalNew = 0, updated = 0, skipped = 0;

  for (const [extId, tier] of Object.entries(WA_TIERS_2025)) {
    const b = await prisma.booking.findUnique({
      where:  { externalId: extId },
      select: { id: true, nights: true, guestCount: true, totalAmount: true },
    });

    if (!b) {
      console.log(`  ⚠  Not found: ${extId}`);
      skipped++;
      continue;
    }

    const rate    = TIER_PRICES_2025[tier];
    const newAmt  = calcTotal(rate, b.nights, b.guestCount);
    const oldAmt  = parseFloat(String(b.totalAmount));
    const delta   = newAmt - oldAmt;

    totalOld += oldAmt;
    totalNew += newAmt;

    const line =
      `  ${extId.padEnd(44)} ${String(b.guestCount).padStart(3)}     ${b.nights}   ${tier.padEnd(10)}` +
      `  R$${String(oldAmt.toFixed(2)).padStart(9)}` +
      `  R$${String(newAmt.toFixed(2)).padStart(9)}` +
      `  ${delta >= 0 ? '+' : ''}R$${delta.toFixed(2)}`;

    if (Math.abs(delta) < 0.01) {
      console.log(line + '  (no change)');
      skipped++;
      continue;
    }

    await prisma.booking.update({
      where: { id: b.id },
      data:  {
        totalAmount:      newAmt,
        baseRatePerNight: rate,
      },
    });
    console.log(line + '  ✓');
    updated++;
  }

  const deltaTotal = totalNew - totalOld;
  console.log(`  ${'─'.repeat(100)}`);
  console.log(
    `  ${'TOTALS'.padEnd(65)}  R$${String(totalOld.toFixed(2)).padStart(9)}` +
    `  R$${String(totalNew.toFixed(2)).padStart(9)}` +
    `  +R$${deltaTotal.toFixed(2)}`
  );
  console.log(`\n  Updated: ${updated} | No change: ${skipped}`);

  // ── 3. Final revenue summary ────────────────────────────────────────────────
  const RDI_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

  console.log('\n[3] Revised revenue totals (RDI CONFIRMED):');
  const rows = await prisma.$queryRawUnsafe(`
    SELECT source::text, COUNT(*)::int AS cnt,
           ROUND(SUM("totalAmount")::numeric, 2) AS total
    FROM   "Booking"
    WHERE  "propertyId" = $1 AND status = 'CONFIRMED'
    GROUP  BY source
    ORDER  BY SUM("totalAmount") DESC
  `, RDI_ID);

  let grand = 0;
  for (const r of rows) {
    const t = parseFloat(r.total);
    grand += t;
    console.log(`  ${r.source.padEnd(14)} ${String(r.cnt).padStart(3)} bookings   R$${t.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  ${'GRAND TOTAL'.padEnd(14)} ${''.padStart(3)}            R$${grand.toFixed(2).padStart(12)}`);

  console.log('\n  ✅ 2025 WA estimates now reflect current Airbnb range R$770–R$1.500/noite.');
  console.log('  ✅ 2024 historical rates unchanged (LOW=720, PEAK=1300 — accurate for that period).');
  console.log('  ⚠  Rates remain estimates for WhatsApp-booked stays. Bank-verified amounts unaffected.');

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
