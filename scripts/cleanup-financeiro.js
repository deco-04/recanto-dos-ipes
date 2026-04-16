'use strict';

/**
 * cleanup-financeiro.js
 * ─────────────────────────────────────────────────────────────────────────
 * Comprehensive financial data cleanup (run once, idempotent):
 *
 *  1. Delete 3 non-rental "bookings":
 *     - Jenepher Felício (R$3,171) — misc payment, not a stay
 *     - Demerge Brasil Mar (R$1,586) — payment facilitator
 *     - Demerge Brasil Jul (R$1,140) — payment facilitator
 *
 *  2. Convert 4 bank-verified PIX add-on payments to proper Booking.com upsells:
 *     - Christiane Alvarenga → bcom-inv-19579121 (Jan 2025)
 *     - Hamilton Alves       → bcom-inv-19911676 (May 2025)
 *     - João Pedro Araújo    → bcom-inv-20285055 (Oct 2025)
 *     - Luanda Pimenta       → bcom-inv-20367297 (Nov 2025)
 *
 *  3. Add today's expenses (2026-04-15, bank balance R$21,586.77):
 *     - R$150.00   Capas de travesseiro impermeáveis (MATERIAIS_MELHORIAS, RDI)
 *     - R$400.00   Jair Junior — adiantamento Mai/2026 (MANUTENCAO_PISCINA, RDI)
 *     - R$216.95   Condomínio dos Ipês Abr/2026 (CONDOMINIO, RDI)
 *     - R$263.40   FIT Associação de Consumidores de Energia Abr/2026 (ENERGIA_ELETRICA, CDS)
 *
 *  4. Print upsell % analysis and final revenue summary
 */

const prisma = require('../lib/db');

const RDI_ID = 'cmnvjziwv0000ohgcb3nxbl4j';
const CDS_ID = 'cmnyakdcw0003oh14vcmoq2o2';

// ── 1. Non-rental bookings to delete ────────────────────────────────────────
const TO_DELETE = [
  {
    externalId: 'direct-JENEPHER-FELICIO-2024-09',
    reason: 'Não é reserva — R$3.171 pagamento misc (líquido após estorno R$829)',
  },
  {
    externalId: 'direct-DEMERGE-2024-03',
    reason: 'Demerge Brasil = facilitador de pagamento, não reserva direta (R$1.586)',
  },
  {
    externalId: 'direct-DEMERGE-2024-07',
    reason: 'Demerge Brasil = facilitador de pagamento, não reserva direta (R$1.140)',
  },
];

// ── 2. Bank-verified PIX add-ons → Booking.com upsells ──────────────────────
// The guest paid the OTA base rate through Booking.com + extra amount via PIX direct.
// We delete the DIRECT "booking" placeholder and create a proper upsell record.
const BCOM_UPSELLS = [
  {
    deleteExternalId: 'direct-CHRISTIANE-2025-01',
    upsellExternalId: 'upsell-bcomINV19579121-20250111',
    guestName:        'Christiane Alvarenga Dolabela',
    checkIn:          '2025-01-11',
    nights:           2,
    amount:           1218.00,
    linkedBcomId:     'bcom-inv-19579121',
    invoiceNumber:    'UPSELL-BCOMJ25-CHR01',
    notes:            'PIX direto R$1.218 — add-on sobre reserva Booking.com Jan/2025 (bcom-inv-19579121). Booking.com paga até dia 5 do mês seguinte.',
  },
  {
    deleteExternalId: 'direct-HAMILTON-ALVES-2025-05',
    upsellExternalId: 'upsell-bcomINV19911676-20250510',
    guestName:        'Hamilton Alves dos Santos',
    checkIn:          '2025-05-10',
    nights:           2,
    amount:           150.00,
    linkedBcomId:     'bcom-inv-19911676',
    invoiceNumber:    'UPSELL-BCOMM25-HAM05',
    notes:            'PIX direto R$150 — add-on sobre reserva Booking.com Mai/2025 (bcom-inv-19911676). Possível taxa extra hóspedes ou pet.',
  },
  {
    deleteExternalId: 'direct-JOAO-PEDRO-ARAUJO-2025-10',
    upsellExternalId: 'upsell-bcomINV20285055-20251025',
    guestName:        'João Pedro Barbosa de Araújo',
    checkIn:          '2025-10-25',
    nights:           2,
    amount:           900.00,
    linkedBcomId:     'bcom-inv-20285055',
    invoiceNumber:    'UPSELL-BCOMO25-JPE10',
    notes:            'PIX direto R$900 — add-on sobre reserva Booking.com Out/2025 (bcom-inv-20285055). Booking.com paga até dia 5/11/2025.',
  },
  {
    deleteExternalId: 'direct-LUANDA-PIMENTA-2025-11',
    upsellExternalId: 'upsell-bcomINV20367297-20251115',
    guestName:        'Luanda Pimenta Bonfim',
    checkIn:          '2025-11-15',
    nights:           2,
    amount:           950.00,
    linkedBcomId:     'bcom-inv-20367297',
    invoiceNumber:    'UPSELL-BCOMN25-LUA11',
    notes:            'PIX direto R$950 — add-on sobre reserva Booking.com Nov/2025 (bcom-inv-20367297). Booking.com paga até dia 5/12/2025.',
  },
];

// ── 3. Today's expenses (2026-04-15) ────────────────────────────────────────
const TODAY = new Date('2026-04-15T12:00:00.000Z');

const TODAY_EXPENSES = [
  {
    propertyId:  RDI_ID,
    date:        TODAY,
    amount:      150.00,
    category:    'MATERIAIS_MELHORIAS',
    description: 'Capas de travesseiro impermeáveis',
    payee:       'Loja de cama mesa e banho',
    source:      'MANUAL',
    bankRef:     '15/04/2026|CAPAS TRAVESSEIRO IMPERM|150.00',
    notes:       'Compra de capas de travesseiro impermeáveis. Saldo banco antes: R$21.586,77.',
  },
  {
    propertyId:  RDI_ID,
    date:        TODAY,
    amount:      400.00,
    category:    'MANUTENCAO_PISCINA',
    description: 'Jair Junior — adiantamento serviços piscina Mai/2026',
    payee:       'Jair Junio',
    source:      'MANUAL',
    bankRef:     '15/04/2026|JAIR JUNIO PISCINA ADV|400.00',
    notes:       'Adiantamento referente a maio/2026 — manutenção piscina.',
  },
  {
    propertyId:  RDI_ID,
    date:        TODAY,
    amount:      216.95,
    category:    'CONDOMINIO',
    description: 'Condomínio dos Ipês Abr/2026',
    payee:       'Condomínio Sítio dos Ipês',
    source:      'MANUAL',
    bankRef:     '15/04/2026|CONDOMINIO SITIO IPES|216.95',
    notes:       'Taxa condominial abril/2026.',
  },
  {
    propertyId:  CDS_ID,
    date:        TODAY,
    amount:      263.40,
    category:    'ENERGIA_ELETRICA',
    description: 'FIT Associação de Consumidores de Energia — CDS Abr/2026',
    payee:       'FIT Associação de Consumidores de Energia',
    source:      'MANUAL',
    bankRef:     '15/04/2026|FIT ASSOC CONSUMIDORES|263.40',
    notes:       'Energia elétrica Cabanas da Serra abril/2026.',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractBcomGross(notes) {
  if (!notes) return null;
  const m = notes.match(/Vendas:\s*R\$([\d,.]+)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== cleanup-financeiro.js ===\n');

  // ── Step 1: Delete non-rental bookings ─────────────────────────────────────
  console.log('[1] Deleting non-rental bookings...');
  let totalRemoved = 0;

  for (const d of TO_DELETE) {
    const b = await prisma.booking.findUnique({ where: { externalId: d.externalId } });
    if (!b) {
      console.log(`  ⚠  Not found: ${d.externalId} (already deleted)`);
      continue;
    }
    const amt = parseFloat(String(b.totalAmount));
    await prisma.bookingGuest.deleteMany({ where: { bookingId: b.id } });
    await prisma.booking.delete({ where: { id: b.id } });
    totalRemoved += amt;
    console.log(`  ✓  Deleted: ${d.externalId}  R$${amt.toFixed(2)}`);
    console.log(`     ${d.reason}`);
  }
  console.log(`\n  Total DIRECT revenue removed: R$${totalRemoved.toFixed(2)}\n`);

  // ── Step 2: Convert to Booking.com upsells ─────────────────────────────────
  console.log('[2] Converting bank PIX payments → Booking.com upsells...');
  const upsellAnalysis = [];

  for (const u of BCOM_UPSELLS) {
    // Look up the linked Booking.com aggregate
    const bcom = await prisma.booking.findUnique({
      where:  { externalId: u.linkedBcomId },
      select: { id: true, totalAmount: true, notes: true },
    });

    // Delete old DIRECT placeholder
    const old = await prisma.booking.findUnique({ where: { externalId: u.deleteExternalId } });
    if (old) {
      await prisma.bookingGuest.deleteMany({ where: { bookingId: old.id } });
      await prisma.booking.delete({ where: { id: old.id } });
      console.log(`  ✓  Deleted direct placeholder: ${u.deleteExternalId}`);
    } else {
      console.log(`  ⚠  Direct placeholder not found: ${u.deleteExternalId}`);
    }

    // Create upsell (idempotent)
    const existing = await prisma.booking.findUnique({ where: { externalId: u.upsellExternalId } });
    if (!existing) {
      const checkIn  = new Date(`${u.checkIn}T12:00:00.000Z`);
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + u.nights);

      await prisma.booking.create({
        data: {
          externalId:       u.upsellExternalId,
          guestName:        u.guestName,
          guestEmail:       '',
          guestPhone:       '',
          checkIn,
          checkOut,
          nights:           u.nights,
          guestCount:       0,
          extraGuests:      0,
          hasPet:           false,
          baseRatePerNight: parseFloat((u.amount / u.nights).toFixed(2)),
          extraGuestFee:    0,
          petFee:           0,
          totalAmount:      u.amount,
          status:           'CONFIRMED',
          source:           'DIRECT',
          propertyId:       RDI_ID,
          invoiceNumber:    u.invoiceNumber,
          notes:            u.notes,
        },
      });
      console.log(`  ✓  Created upsell: ${u.upsellExternalId}  R$${u.amount.toFixed(2)}`);
    } else {
      console.log(`  ⚠  Upsell already exists: ${u.upsellExternalId}`);
    }

    if (bcom) {
      const bcomNet   = parseFloat(String(bcom.totalAmount));
      const bcomGross = extractBcomGross(bcom.notes) || bcomNet / 0.87;
      upsellAnalysis.push({ u, bcomNet, bcomGross });
    }
  }

  // ── Step 3: Upsell revenue analysis ────────────────────────────────────────
  console.log('\n[3] Upsell revenue analysis — add-on % of total stay revenue');
  console.log('');
  console.log('  Booking.com add-ons (new, this session):');
  console.log('  ─────────────────────────────────────────────────────────────────────────────');
  console.log('  Guest                           Upsell     BcomGross   Total      Upsell%');

  for (const { u, bcomGross } of upsellAnalysis) {
    const totalStay = bcomGross + u.amount;
    const pct = (u.amount / totalStay * 100).toFixed(1);
    const name = u.guestName.padEnd(32);
    console.log(
      `  ${name} R$${String(u.amount.toFixed(2)).padStart(8)}` +
      `  R$${String(bcomGross.toFixed(2)).padStart(9)}` +
      `  R$${String(totalStay.toFixed(2)).padStart(9)}` +
      `  ${pct}%`
    );
  }

  // All existing upsells with Airbnb parents
  console.log('');
  console.log('  Airbnb add-ons (existing):');
  console.log('  ─────────────────────────────────────────────────────────────────────────────');
  console.log('  Guest                           Upsell     AirbnbAmt   Total      Upsell%');

  const allUpsells = await prisma.booking.findMany({
    where: {
      source:     'DIRECT',
      externalId: { startsWith: 'upsell-' },
      propertyId: RDI_ID,
    },
    select: { externalId: true, guestName: true, totalAmount: true },
    orderBy: { checkIn: 'asc' },
  });

  for (const us of allUpsells) {
    // Skip Booking.com upsells — already shown above
    if (us.externalId.includes('bcom')) continue;

    const uAmt   = parseFloat(String(us.totalAmount));
    // Extract Airbnb code: upsell-{CODE}-{date}
    const parts  = us.externalId.replace('upsell-', '').split('-');
    const code   = parts[0];
    const parent = code ? await prisma.booking.findUnique({
      where:  { externalId: code },
      select: { totalAmount: true },
    }) : null;

    if (!parent) {
      console.log(`  ${us.guestName.padEnd(32)} R$${String(uAmt.toFixed(2)).padStart(8)}  (parent not found: ${code})`);
      continue;
    }

    const pAmt      = parseFloat(String(parent.totalAmount));
    const totalStay = pAmt + uAmt;
    const pct       = (uAmt / totalStay * 100).toFixed(1);
    const name      = us.guestName.padEnd(32);
    console.log(
      `  ${name} R$${String(uAmt.toFixed(2)).padStart(8)}` +
      `  R$${String(pAmt.toFixed(2)).padStart(9)}` +
      `  R$${String(totalStay.toFixed(2)).padStart(9)}` +
      `  ${pct}%`
    );
  }

  // ── Step 4: Add today's expenses ───────────────────────────────────────────
  console.log('\n[4] Adding expenses for 2026-04-15...');
  let expCreated = 0;
  let expTotal   = 0;

  for (const e of TODAY_EXPENSES) {
    const existing = await prisma.expense.findFirst({ where: { bankRef: e.bankRef } });
    if (existing) {
      console.log(`  ⚠  Already exists: ${e.bankRef}`);
      expTotal += parseFloat(String(e.amount));
      continue;
    }
    await prisma.expense.create({ data: e });
    expCreated++;
    expTotal += parseFloat(String(e.amount));
    const prop = e.propertyId === RDI_ID ? 'RDI' : 'CDS';
    console.log(`  ✓  [${prop}] ${e.category.padEnd(22)} R$${parseFloat(String(e.amount)).toFixed(2).padStart(8)}  ${e.description}`);
  }

  console.log(`\n  Expenses added: ${expCreated}`);
  console.log(`  Bank balance before:  R$21,586.77`);
  console.log(`  Total paid (RDI+CDS): R$${expTotal.toFixed(2)}`);
  console.log(`  Estimated balance:    R$${(21586.77 - expTotal).toFixed(2)}`);

  // ── Step 5: Final revenue summary ──────────────────────────────────────────
  console.log('\n[5] Final revenue summary — RDI CONFIRMED bookings:');

  const bySource = await prisma.$queryRawUnsafe(`
    SELECT source::text, COUNT(*)::int AS cnt,
           ROUND(SUM("totalAmount")::numeric, 2) AS total
    FROM   "Booking"
    WHERE  "propertyId" = $1 AND status = 'CONFIRMED'
    GROUP  BY source
    ORDER  BY SUM("totalAmount") DESC
  `, RDI_ID);

  let grand = 0;
  for (const s of bySource) {
    const t = parseFloat(s.total);
    grand += t;
    console.log(`  ${s.source.padEnd(14)} ${String(s.cnt).padStart(3)} bookings   R$${t.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'─'.repeat(55)}`);
  console.log(`  ${'GRAND TOTAL'.padEnd(14)} ${''.padStart(3)}            R$${grand.toFixed(2).padStart(12)}`);

  // Upsell sub-total
  const [uRow] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS cnt,
           ROUND(SUM("totalAmount")::numeric, 2) AS total
    FROM   "Booking"
    WHERE  "propertyId" = $1 AND status = 'CONFIRMED'
      AND  source = 'DIRECT' AND "externalId" LIKE 'upsell-%'
  `, RDI_ID);

  if (uRow) {
    const ut  = parseFloat(uRow.total);
    const pct = (ut / grand * 100).toFixed(1);
    console.log(`\n  ↳ of which upsells: ${uRow.cnt} entries — R$${ut.toFixed(2)} (${pct}% of total revenue)`);
  }

  // ── Step 6: Price evolution note ───────────────────────────────────────────
  console.log('\n[6] ⚠  Price evolution flag:');
  console.log('  WA-estimated DIRECT bookings use 2024 baseline rates:');
  console.log('  LOW=R$720 | MID=R$850 | HIGH_MID=R$1.050 | PEAK=R$1.300/noite');
  console.log('  Rates have evolved since then. 2025–2026 estimates may be understated.');
  console.log('  Action: Confirm current nightly rates with André and re-run tier pricing');
  console.log('  for WA-estimated bookings with checkIn ≥ 2025-01-01 if needed.');

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
