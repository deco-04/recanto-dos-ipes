'use strict';

/**
 * update-aggregate-dates.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces the full-month date spans (Jan 1 → Jan 31) on the 7 remaining
 * Booking.com invoice-aggregate placeholders with realistic weekend stays.
 *
 * Rationale per record:
 *   Each aggregate is a monthly payout from Booking.com whose individual
 *   reservation details weren't available. Instead of a 30-day span (which
 *   distorts occupancy charts), we assign a realistic 2–3 night Friday–Sunday
 *   stay that (a) falls within that month, (b) doesn't conflict with any
 *   confirmed individual booking already in the DB, and (c) produces a
 *   nightly rate consistent with the property's pricing range.
 *
 * Date/rate logic per record:
 * ┌────────────────┬─────────────────┬───────┬────────────────────────────────────┐
 * │ Record         │ Placeholder dates│ Nights│ Rational                           │
 * ├────────────────┼─────────────────┼───────┼────────────────────────────────────┤
 * │ Aug 2024       │ Aug 02–04       │   2   │ First free Fri–Sun; Weryk Aug 16    │
 * │ Sep 2024       │ Sep 06–08       │   2   │ Free Fri–Sun before Karen Sep 14    │
 * │ Nov 2024       │ Nov 01–03       │   2   │ Finados long weekend; Igo Nov 15    │
 * │ Jan 2025       │ Jan 17–20       │   3   │ Peak summer; free window mid-Jan    │
 * │ Feb 2025       │ Feb 14–16       │   2   │ Valentine's Fri–Sun; free window    │
 * │ Mar 2025       │ Mar 21–23       │   2   │ Post-Carnaval Fri–Sun; free window  │
 * │ Apr 2025 res.  │ Apr 04–06       │   2   │ Before Semana Santa / Patrick Apr18 │
 * └────────────────┴─────────────────┴───────┴────────────────────────────────────┘
 *
 * All amounts:  totalAmount = net payout (verified bank)
 *               grossAmount = net / 0.87  (estimated, 13% Booking.com comm)
 *               commissionAmount = grossAmount * 0.13
 *
 * isInvoiceAggregate stays TRUE — these are still placeholders, not real records.
 * guestName updated to reflect estimated status clearly.
 */

const prisma = require('../lib/db');

const BCOM_RATE = 0.13; // 13% Booking.com commission (standard)

const UPDATES = [
  {
    externalId:  'bcom-inv-19218253',
    monthLabel:  'Ago/2024',
    checkIn:     '2024-08-02',
    checkOut:    '2024-08-04',
    nights:      2,
    rational:    'Primeiro fim de semana livre em Ago/2024 (Weryk Rocha ocupa 16–18/08).',
  },
  {
    externalId:  'bcom-inv-19265543',
    monthLabel:  'Set/2024',
    checkIn:     '2024-09-06',
    checkOut:    '2024-09-08',
    nights:      2,
    rational:    'Fim de semana livre antes de Karen Karolina (14/09) e Lucas Milhorato (21/09).',
  },
  {
    externalId:  'bcom-inv-19418698',
    monthLabel:  'Nov/2024',
    checkIn:     '2024-11-01',
    checkOut:    '2024-11-03',
    nights:      2,
    rational:    'Feriado Finados (01/11 sexta-feira) — fim de semana prolongado. Igo Souza ocupa 15–17/11.',
  },
  {
    externalId:  'bcom-inv-19579121',
    monthLabel:  'Jan/2025',
    checkIn:     '2025-01-17',
    checkOut:    '2025-01-20',
    nights:      3,
    rational:    '3 noites (sex–seg) em plena temporada alta de verão. Paulo Otávio Jan 3–5, Christiane Jan 11–13, Larissa Jan 25–26 já ocupadas. Upsell de Christiane (R$1.218 PIX) vinculado a esta fatura.',
  },
  {
    externalId:  'bcom-inv-19663917',
    monthLabel:  'Fev/2025',
    checkIn:     '2025-02-14',
    checkOut:    '2025-02-16',
    nights:      2,
    rational:    'Fim de semana do Valentine\'s Day (14/02 = sexta). Elaine Fev 1–2 e Paulinho/Paulo Ricardo Fev 8–10 já ocupados. Carnaval começa 01/03.',
  },
  {
    externalId:  'bcom-inv-19750621',
    monthLabel:  'Mar/2025',
    checkIn:     '2025-03-21',
    checkOut:    '2025-03-23',
    nights:      2,
    rational:    'Pós-Carnaval. Raquel Mar 1–5, Pedro Mar 7–9, Thais Mar 14–16 já ocupados. R$544/noite bruto é condizente com período fora de temporada.',
  },
  {
    externalId:  'bcom-inv-19835038',
    monthLabel:  'Abr/2025 (residual)',
    checkIn:     '2025-04-04',
    checkOut:    '2025-04-06',
    nights:      2,
    rational:    'Reserva não identificada residual (Patrick extraído como bcom-PATRICK-MEIRELES-20250418). Abr 4–6 livre antes de Thalles Abr 12–14 e Patrick/Fábio Abr 18–21.',
  },
];

async function main() {
  console.log('=== update-aggregate-dates.js ===\n');
  console.log('Replacing full-month date spans with realistic weekend placeholders.\n');

  for (const u of UPDATES) {
    const b = await prisma.booking.findUnique({ where: { externalId: u.externalId } });
    if (!b) {
      console.log(`  ⚠  Not found: ${u.externalId}`);
      continue;
    }

    const net     = parseFloat(b.totalAmount);
    const gross   = parseFloat((net / (1 - BCOM_RATE)).toFixed(2));
    const comm    = parseFloat((gross * BCOM_RATE).toFixed(2));
    const nightlyNet   = parseFloat((net   / u.nights).toFixed(2));
    const nightlyGross = parseFloat((gross / u.nights).toFixed(2));

    const checkIn  = new Date(`${u.checkIn}T12:00:00.000Z`);
    const checkOut = new Date(`${u.checkOut}T12:00:00.000Z`);

    // Verify no overlap with existing confirmed individual bookings
    const overlap = await prisma.booking.findFirst({
      where: {
        propertyId:         b.propertyId,
        status:             'CONFIRMED',
        isInvoiceAggregate: false,
        id:                 { not: b.id },
        OR: [
          { checkIn:  { gte: checkIn,  lt: checkOut } },
          { checkOut: { gt: checkIn,  lte: checkOut } },
          { checkIn:  { lte: checkIn }, checkOut: { gte: checkOut } },
        ],
      },
      select: { guestName: true, checkIn: true, checkOut: true, source: true },
    });

    if (overlap) {
      console.log(`  ❌ CONFLICT for ${u.externalId}: overlaps with ${overlap.guestName} (${overlap.checkIn.toISOString().slice(0,10)}→${overlap.checkOut.toISOString().slice(0,10)}) — SKIPPING`);
      continue;
    }

    const newGuestName = `Hóspede Booking.com — ${u.monthLabel} (estimativa)`;
    const newNotes =
      `⚠️ PLACEHOLDER — datas estimadas. Reserva individual não identificada para ${u.monthLabel}.\n` +
      `Fatura Booking.com: ${u.externalId}. Valor líquido verificado: R$${net.toFixed(2)}.\n` +
      `Datas escolhidas: ${u.checkIn} → ${u.checkOut} (${u.nights} noites, ${u.rational})\n` +
      `Diária estimada: R$${nightlyGross.toFixed(2)} bruto / R$${nightlyNet.toFixed(2)} líquido. Comissão estimada 13%.`;

    await prisma.booking.update({
      where: { id: b.id },
      data: {
        guestName:         newGuestName,
        checkIn,
        checkOut,
        nights:            u.nights,
        guestCount:        0,          // unknown
        baseRatePerNight:  nightlyNet,
        grossAmount:       gross,
        commissionAmount:  comm,
        isInvoiceAggregate: true,      // still a placeholder
        notes:             newNotes,
      },
    });

    console.log(
      `  ✓  ${u.externalId.padEnd(30)} ${u.monthLabel.padEnd(22)} ` +
      `${u.checkIn} → ${u.checkOut}  ${u.nights}n  ` +
      `net=R$${net.toFixed(2)}  gross≈R$${gross.toFixed(2)}  R$${nightlyGross.toFixed(2)}/noite`
    );
    console.log(`     ${u.rational}`);
  }

  console.log('\nFinal state of all Booking.com invoice aggregates:');
  const aggs = await prisma.booking.findMany({
    where: { propertyId: 'cmnvjziwv0000ohgcb3nxbl4j', source: 'BOOKING_COM', isInvoiceAggregate: true },
    select: { externalId: true, guestName: true, checkIn: true, checkOut: true,
              nights: true, totalAmount: true, grossAmount: true },
    orderBy: { checkIn: 'asc' },
  });
  for (const a of aggs) {
    const net   = parseFloat(a.totalAmount);
    const gross = a.grossAmount ? parseFloat(a.grossAmount) : null;
    console.log(
      `  ${a.externalId.padEnd(30)} ${a.checkIn.toISOString().slice(0,10)} → ${a.checkOut.toISOString().slice(0,10)}` +
      `  ${a.nights}n  net=R$${net.toFixed(2)}${gross ? `  gross≈R$${gross.toFixed(2)}` : ''}`
    );
  }

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
