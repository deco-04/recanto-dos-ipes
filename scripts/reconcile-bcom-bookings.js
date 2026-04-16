'use strict';

/**
 * reconcile-bcom-bookings.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces Booking.com monthly-invoice aggregate placeholders with real
 * individual reservation records sourced from the Booking.com extranet
 * (screenshots + PDF from drive-download-20260416T025442Z-3-001).
 *
 * Strategy:
 *  • FULL MATCH months  → delete aggregate, insert individual(s)
 *  • PARTIAL (Apr 2025) → insert Patrick Meireles, update aggregate to residual
 *  • NO DATA months     → keep aggregates as-is (already flagged isInvoiceAggregate=true)
 *  • Rodrigo (existing) → update guestCount + grossAmount + commissionAmount
 *  • Roberta (future)   → insert (Jun 2026, 16% commission)
 *  • Upsell fixes       → update Luanda upsell dates/link; fix Hamilton's orphaned notes
 *
 * All monetary amounts stored:
 *   totalAmount        = gross − commission  (net payout to property)
 *   grossAmount        = total reservation price (what guest paid)
 *   commissionAmount   = platform commission taken from host
 *
 * Idempotent: safe to re-run.
 */

const prisma = require('../lib/db');

const RDI_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

// ── Individual Booking.com reservations (from extranet screenshots + PDF) ────
// net = grossAmount − commissionAmount
// commission rates: 13% for all except Roberta Magalhães (16%)
const INDIVIDUAL_BOOKINGS = [
  // ── April 2025 (partial coverage — Patrick only, unknown residual ~R$1,197.99) ──
  {
    externalId:   'bcom-PATRICK-MEIRELES-20250418',
    guestName:    'Patrick Meireles',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-04-18',
    checkOut:     '2025-04-20',
    nights:       2,
    guestCount:   14,          // 11 adults + 3 children (8, 5, 2 years)
    grossAmount:  1569.78,
    commissionAmount: 204.07, // 13.0%
    // net = 1569.78 − 204.07 = 1365.71
    notes:        'Booking.com — 11 adultos + 3 crianças (8, 5 e 2 anos). Comissão 13%. Parte do faturamento de Abr/2025 (bcom-inv-19835038).',
    relatedAggregateId: 'bcom-inv-19835038',
  },
  // ── May 2025 — FULL MATCH: Ranifia + Luciana = R$3,334.41 ──
  {
    externalId:   'bcom-4492644379',
    guestName:    'Ranifia Aparecida Evangelista Dos Santos',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-05-02',
    checkOut:     '2025-05-05',
    nights:       3,
    guestCount:   20,          // 17 adults + 3 children (15, 14, 8 years)
    grossAmount:  2478.60,
    commissionAmount: 322.22, // 13.0%
    // net = 2478.60 − 322.22 = 2156.38
    notes:        'Booking.com Genius — 17 adultos + 3 crianças (15, 14 e 8 anos). Comissão 13%. Fatura Mai/2025 (bcom-inv-19911676).',
    deletesAggregate: 'bcom-inv-19911676', // shared with Luciana below — deleted once
  },
  {
    externalId:   'bcom-4792792517',
    guestName:    'Luciana Santos',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-05-09',
    checkOut:     '2025-05-11',
    nights:       2,
    guestCount:   11,          // 10 adults + 1 child (1 year)
    grossAmount:  1354.06,
    commissionAmount: 176.03, // 13.0%
    // net = 1354.06 − 176.03 = 1178.03
    notes:        'Booking.com Genius — 10 adultos + 1 criança (1 ano). Comissão 13%. Hóspede pediu preferência não-fumante e estacionamento. Fatura Mai/2025 (bcom-inv-19911676).',
    // aggregate already deleted by Ranifia entry above
  },
  // ── June 2025 — FULL MATCH: Martins Fernanda = R$1,974.46 ──
  {
    externalId:   'bcom-4819583532',
    guestName:    'Martins Fernanda',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-06-19',
    checkOut:     '2025-06-22',
    nights:       3,
    guestCount:   8,
    grossAmount:  2269.50,
    commissionAmount: 295.04, // 13.0%
    // net = 2269.50 − 295.04 = 1974.46
    notes:        'Booking.com Genius — 8 adultos. Comissão 13%. Fatura Jun/2025 (bcom-inv-19983589).',
    deletesAggregate: 'bcom-inv-19983589',
  },
  // ── August 2025 — FULL MATCH: Amanda Castro = R$1,054.23 ──
  {
    externalId:   'bcom-5274535267',
    guestName:    'Amanda Castro',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-08-15',
    checkOut:     '2025-08-17',
    nights:       2,
    guestCount:   6,
    grossAmount:  1211.76,
    commissionAmount: 157.53, // 13.0%
    // net = 1211.76 − 157.53 = 1054.23
    notes:        'Booking.com Genius — 6 adultos. Chegada prevista entre 09h–10h. Comissão 13%. Fatura Ago/2025 (bcom-inv-20128683).',
    deletesAggregate: 'bcom-inv-20128683',
  },
  // ── September 2025 — FULL MATCH: Isabella + Victor ≈ R$2,893.97 ──
  {
    externalId:   'bcom-5464416400',
    guestName:    'Isabella Queiroz Cury',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-09-12',
    checkOut:     '2025-09-14',
    nights:       2,
    guestCount:   8,
    grossAmount:  1663.20,
    commissionAmount: 216.22, // 13.0% — Genius Dynamic Pricing −12%
    // net = 1663.20 − 216.22 = 1446.98
    notes:        'Booking.com Genius — 8 adultos. Chegada entre 07h–08h. Taxa não-reembolsável, Genius Dynamic Pricing −12%. Comissão 13%. Fatura Set/2025 (bcom-inv-20230644).',
    deletesAggregate: 'bcom-inv-20230644', // shared with Victor — deleted once
  },
  {
    externalId:   'bcom-6034166664',
    guestName:    'Victor Andrade',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-09-26',
    checkOut:     '2025-09-28',
    nights:       2,
    guestCount:   10,
    grossAmount:  1663.20,
    commissionAmount: 216.22, // 13.0%
    // net = 1663.20 − 216.22 = 1446.98
    notes:        'Booking.com Genius — 10 adultos. Comissão 13%. Fatura Set/2025 (bcom-inv-20230644).',
    // aggregate already deleted by Isabella entry above
  },
  // ── October 2025 — FULL MATCH: Pedro João = R$1,642.66 ──
  {
    externalId:   'bcom-6071621799',
    guestName:    'Pedro João',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-10-24',
    checkOut:     '2025-10-26',
    nights:       2,
    guestCount:   11,
    grossAmount:  1888.12,
    commissionAmount: 245.46, // 13.0%
    // net = 1888.12 − 245.46 = 1642.66
    notes:        'Booking.com Genius — 11 adultos. Comissão 13%. Fatura Out/2025 (bcom-inv-20285055).',
    deletesAggregate: 'bcom-inv-20285055',
  },
  // ── November 2025 — FULL MATCH: Luanda Pimenta = R$1,131.44 ──
  {
    externalId:   'bcom-4459596599',
    guestName:    'Luanda Pimenta',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2025-11-22',
    checkOut:     '2025-11-24',
    nights:       2,
    guestCount:   5,
    grossAmount:  1300.50,
    commissionAmount: 169.06, // 13.0%
    // net = 1300.50 − 169.06 = 1131.44
    notes:        'Booking.com — 5 adultos. Comissão 13%. Fatura Nov/2025 (bcom-inv-20367297). Nota: hóspede também pagou R$950 via PIX (add-on — ver upsell-bcomINV20367297).',
    deletesAggregate: 'bcom-inv-20367297',
    fixUpsell: {
      oldExternalId: 'upsell-bcomINV20367297-20251115',
      newCheckIn:    '2025-11-22',
      newLinkedId:   'bcom-4459596599',
    },
  },
  // ── January 2026 — Rodrigo already in DB as bcom-6413085515, just update ──
  // (handled separately below, not in CREATE loop)

  // ── June 2026 — NEW future booking (16% commission) ──
  {
    externalId:   'bcom-6715822503',
    guestName:    'Roberta Magalhães',
    guestEmail:   '',
    guestPhone:   '',
    checkIn:      '2026-06-04',
    checkOut:     '2026-06-07',
    nights:       3,
    guestCount:   7,           // 5 adults + 2 children (1 and 4 years)
    grossAmount:  1893.39,
    commissionAmount: 302.94, // 16.0% — Booking.com premium/Genius tier
    // net = 1893.39 − 302.94 = 1590.45
    notes:        'Booking.com Genius — 5 adultos + 2 crianças (1 e 4 anos). ⚠️ Comissão 16% (acima do padrão 13% — verificar contrato Booking.com). Hóspede solicitou estacionamento gratuito.',
  },
];

// ── Aggregates to delete (all fully covered by individual records above) ──────
// We track which aggregates to delete — only once per month even when
// two individuals share the same invoice.
const AGGREGATES_TO_DELETE = new Set([
  'bcom-inv-19911676', // May 2025
  'bcom-inv-19983589', // Jun 2025
  'bcom-inv-20128683', // Aug 2025
  'bcom-inv-20230644', // Sep 2025
  'bcom-inv-20285055', // Oct 2025
  'bcom-inv-20367297', // Nov 2025
]);

// ── April 2025: partial — residual unknown booking stays as aggregate ────────
// Patrick (R$1,365.71) + unknown = R$2,563.70 → residual = R$1,197.99
const APRIL_RESIDUAL = {
  externalId:   'bcom-inv-19835038',
  newAmount:    1197.99,
  newGuestName: 'Hóspedes Booking.com - 2025-04 (reserva não identificada)',
  newNotes:     'Fatura Abr/2025: uma reserva não identificada. Patrick Meireles (R$1.569,78 bruto) foi extraído como registro individual (bcom-PATRICK-MEIRELES-20250418). Residual = R$2.563,70 − R$1.365,71 = R$1.197,99 líquido.',
};

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== reconcile-bcom-bookings.js ===\n');

  // ── Step 1: Delete covered aggregates ────────────────────────────────────
  console.log('[1] Deleting fully-covered aggregate records...');
  let deletedCount = 0;
  for (const extId of AGGREGATES_TO_DELETE) {
    const b = await prisma.booking.findUnique({ where: { externalId: extId } });
    if (!b) { console.log(`  ⚠  Not found (already deleted?): ${extId}`); continue; }
    await prisma.booking.delete({ where: { id: b.id } });
    deletedCount++;
    console.log(`  ✓  Deleted: ${extId}  (was R$${parseFloat(b.totalAmount).toFixed(2)})`);
  }
  console.log(`  → ${deletedCount} aggregate(s) removed\n`);

  // ── Step 2: Update April 2025 aggregate to residual amount ───────────────
  console.log('[2] Updating April 2025 aggregate to residual (unknown booking)...');
  const aprAgg = await prisma.booking.findUnique({ where: { externalId: APRIL_RESIDUAL.externalId } });
  if (aprAgg) {
    await prisma.booking.update({
      where: { id: aprAgg.id },
      data: {
        totalAmount:        APRIL_RESIDUAL.newAmount,
        guestName:          APRIL_RESIDUAL.newGuestName,
        notes:              APRIL_RESIDUAL.newNotes,
        isInvoiceAggregate: true,
      },
    });
    console.log(`  ✓  ${APRIL_RESIDUAL.externalId} updated to residual R$${APRIL_RESIDUAL.newAmount}\n`);
  } else {
    console.log(`  ⚠  April aggregate not found: ${APRIL_RESIDUAL.externalId}\n`);
  }

  // ── Step 3: Create individual booking records ─────────────────────────────
  console.log('[3] Creating individual Booking.com reservation records...');
  let created = 0;
  let skipped = 0;
  const deletedAggregates = new Set(); // track which aggregates we've already deleted

  for (const b of INDIVIDUAL_BOOKINGS) {
    const net = parseFloat((b.grossAmount - b.commissionAmount).toFixed(2));

    // Idempotent check
    const existing = await prisma.booking.findUnique({ where: { externalId: b.externalId } });
    if (existing) {
      console.log(`  ⚠  Already exists: ${b.externalId} — skipping`);
      skipped++;

      // Still apply upsell fix if needed
      if (b.fixUpsell) await applyUpsellFix(b.fixUpsell, b.externalId);
      continue;
    }

    const checkIn  = new Date(`${b.checkIn}T12:00:00.000Z`);
    const checkOut = new Date(`${b.checkOut}T12:00:00.000Z`);

    await prisma.booking.create({
      data: {
        externalId:        b.externalId,
        guestName:         b.guestName,
        guestEmail:        b.guestEmail,
        guestPhone:        b.guestPhone,
        checkIn,
        checkOut,
        nights:            b.nights,
        guestCount:        b.guestCount,
        extraGuests:       0,
        hasPet:            false,
        baseRatePerNight:  parseFloat((net / b.nights).toFixed(2)),
        extraGuestFee:     0,
        petFee:            0,
        totalAmount:       net,
        grossAmount:       b.grossAmount,
        commissionAmount:  b.commissionAmount,
        isInvoiceAggregate: false,
        status:            'CONFIRMED',
        source:            'BOOKING_COM',
        propertyId:        RDI_ID,
        notes:             b.notes,
      },
    });
    created++;
    const commPct = ((b.commissionAmount / b.grossAmount) * 100).toFixed(1);
    console.log(`  ✓  Created: ${b.externalId.padEnd(38)} ${b.guestName.padEnd(38)} R$${b.grossAmount.toFixed(2)} gross → R$${net.toFixed(2)} net (${commPct}% comm)`);

    // Apply upsell fix if this booking has one
    if (b.fixUpsell) await applyUpsellFix(b.fixUpsell, b.externalId);
  }
  console.log(`\n  → ${created} created, ${skipped} already existed\n`);

  // ── Step 4: Update Rodrigo's existing record with proper data ────────────
  console.log('[4] Updating Rodrigo Castro Vilela (bcom-6413085515)...');
  const rodrigo = await prisma.booking.findUnique({ where: { externalId: 'bcom-6413085515' } });
  if (rodrigo) {
    await prisma.booking.update({
      where: { id: rodrigo.id },
      data: {
        guestCount:        8,      // was 1 (wrong from aggregate import)
        grossAmount:       1501.50,
        commissionAmount:  195.19, // 13.0%
        isInvoiceAggregate: false,
        notes:             'Booking.com Genius — 8 adultos. Comissão 13.0%. Reserva futura Jan/2026. Também pagou R$200 PIX direto (ver upsell-bcom6413085515-20260129).',
      },
    });
    console.log('  ✓  Updated: guestCount=8, grossAmount=R$1501.50, commissionAmount=R$195.19\n');
  } else {
    console.log('  ⚠  Rodrigo record not found — check externalId\n');
  }

  // ── Step 5: Fix Hamilton Alves upsell (orphaned link) ────────────────────
  console.log('[5] Fixing Hamilton Alves upsell (link was to deleted aggregate)...');
  const hamilton = await prisma.booking.findUnique({
    where: { externalId: 'upsell-bcomINV19911676-20250510' },
  });
  if (hamilton) {
    await prisma.booking.update({
      where: { id: hamilton.id },
      data: {
        notes: 'PIX direto R$150 — pagamento adicional Mai/2025. A reserva base do hóspede pode ser referente a Luciana Santos (bcom-4792792517, check-in 09/05) ou Ranifia (bcom-4492644379, check-in 02/05). Verificar com André. [Ref: bcom-inv-19911676 fatura Mai/2025].',
      },
    });
    console.log('  ✓  Hamilton upsell notes updated (orphaned aggregate link clarified)\n');
  } else {
    console.log('  ⚠  Hamilton upsell not found\n');
  }

  // ── Step 6: Summary ───────────────────────────────────────────────────────
  console.log('[6] Final Booking.com record summary:');
  const bcomAll = await prisma.booking.findMany({
    where: { propertyId: RDI_ID, source: 'BOOKING_COM' },
    select: {
      externalId: true, guestName: true, checkIn: true, nights: true,
      guestCount: true, totalAmount: true, grossAmount: true,
      commissionAmount: true, isInvoiceAggregate: true, status: true,
    },
    orderBy: { checkIn: 'asc' },
  });

  const individuals = bcomAll.filter(b => !b.isInvoiceAggregate);
  const aggregates  = bcomAll.filter(b => b.isInvoiceAggregate);

  console.log(`\n  Individual reservations (${individuals.length}):`);
  console.log('  ' + '─'.repeat(110));
  let totalGross = 0, totalNet = 0, totalComm = 0;
  for (const b of individuals) {
    const net  = parseFloat(b.totalAmount);
    const gross = b.grossAmount ? parseFloat(b.grossAmount) : null;
    const comm  = b.commissionAmount ? parseFloat(b.commissionAmount) : null;
    const commPct = gross && comm ? `${((comm / gross) * 100).toFixed(1)}%` : 'est.';
    totalNet  += net;
    if (gross)  totalGross += gross;
    if (comm)   totalComm  += comm;
    console.log(
      `  [${b.status}] ${b.checkIn.toISOString().slice(0,10)}  ${b.guestName.padEnd(40)} ` +
      `${b.nights}n ${String(b.guestCount).padStart(2)}p ` +
      `gross=${gross ? `R$${gross.toFixed(2)}` : '  N/A  '} ` +
      `net=R$${net.toFixed(2)} ` +
      `comm=${commPct}`
    );
  }
  console.log('  ' + '─'.repeat(110));
  console.log(`  TOTAL  gross=R$${totalGross.toFixed(2)}  net=R$${totalNet.toFixed(2)}  commission=R$${totalComm.toFixed(2)}  avg-comm=${totalGross > 0 ? ((totalComm/totalGross)*100).toFixed(1) : 0}%`);

  console.log(`\n  Invoice aggregates still in DB (${aggregates.length}) — months without individual data:`);
  for (const b of aggregates) {
    console.log(`    ${b.externalId.padEnd(30)} ${b.guestName.padEnd(45)} R$${parseFloat(b.totalAmount).toFixed(2)} (net)`);
  }

  // ── Upsell cross-check ─────────────────────────────────────────────────────
  console.log('\n[7] Upsell cross-check (DIRECT source, externalId starts with "upsell-bcom"):');
  const upsells = await prisma.booking.findMany({
    where: { propertyId: RDI_ID, source: 'DIRECT', externalId: { startsWith: 'upsell-bcom' } },
    select: { externalId: true, guestName: true, checkIn: true, totalAmount: true, notes: true },
    orderBy: { checkIn: 'asc' },
  });
  for (const u of upsells) {
    console.log(`  ${u.externalId.padEnd(45)} ${u.guestName.padEnd(35)} R$${parseFloat(u.totalAmount).toFixed(2)} | ${u.checkIn.toISOString().slice(0,10)}`);
  }

  console.log('\nDone.');
}

// ── Helper: fix a upsell record's checkIn date and notes ──────────────────────
async function applyUpsellFix(fix, newLinkedExternalId) {
  const u = await prisma.booking.findUnique({ where: { externalId: fix.oldExternalId } });
  if (!u) {
    console.log(`    ⚠  Upsell not found: ${fix.oldExternalId}`);
    return;
  }
  const newCheckIn = new Date(`${fix.newCheckIn}T12:00:00.000Z`);
  const newCheckOut = new Date(newCheckIn);
  newCheckOut.setUTCDate(newCheckOut.getUTCDate() + u.nights);

  await prisma.booking.update({
    where: { id: u.id },
    data: {
      checkIn:  newCheckIn,
      checkOut: newCheckOut,
      notes: `PIX direto R$${parseFloat(u.totalAmount).toFixed(2)} — add-on sobre reserva Booking.com Nov/2025 (${newLinkedExternalId}). Check-in 22/11/2025. Booking.com paga até dia 5/12/2025.`,
    },
  });
  console.log(`    ✓  Upsell ${fix.oldExternalId}: checkIn corrected to ${fix.newCheckIn}, link → ${newLinkedExternalId}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
