'use strict';

/**
 * backfill-airbnb-commission.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts the exact Airbnb host fee ("Taxa Airbnb: R$XXX.XX") already stored
 * in the `notes` field of each Airbnb booking, then populates:
 *   commissionAmount = the exact host fee
 *   grossAmount      = totalAmount (net) + commissionAmount
 *
 * This makes Airbnb and Booking.com financially comparable in the dashboard —
 * both now carry verified gross/net/commission data per booking.
 *
 * Idempotent: skips records that already have commissionAmount set.
 */

const prisma = require('../lib/db');

const RDI_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

// Regex: "Taxa Airbnb: R$XXX.XX" or "Taxa Airbnb: R$X,XXX.XX"
const FEE_REGEX = /Taxa Airbnb:\s*R\$\s*([\d.,]+)/i;

function parseBRL(str) {
  // Handle both "189.87" and "1,234.56" formats
  return parseFloat(str.replace(/,/g, ''));
}

async function main() {
  console.log('=== backfill-airbnb-commission.js ===\n');

  const airbnbBookings = await prisma.booking.findMany({
    where: {
      propertyId:       RDI_ID,
      source:           'AIRBNB',
      commissionAmount: null,   // only process records without commission yet
      notes:            { not: null },
    },
    select: { id: true, externalId: true, guestName: true, totalAmount: true, notes: true },
    orderBy: { checkIn: 'asc' },
  });

  console.log(`Found ${airbnbBookings.length} Airbnb record(s) missing commissionAmount.\n`);

  let updated = 0;
  let noMatch = 0;

  for (const b of airbnbBookings) {
    const m = b.notes?.match(FEE_REGEX);
    if (!m) {
      console.log(`  ⚠  No fee in notes: ${b.externalId?.slice(0, 20).padEnd(22)} "${b.notes?.slice(0, 60)}"`);
      noMatch++;
      continue;
    }

    const commissionAmount = parseBRL(m[1]);
    const net              = parseFloat(b.totalAmount);
    const grossAmount      = parseFloat((net + commissionAmount).toFixed(2));
    const commPct          = ((commissionAmount / grossAmount) * 100).toFixed(2);

    await prisma.booking.update({
      where: { id: b.id },
      data:  { commissionAmount, grossAmount },
    });

    updated++;
    console.log(
      `  ✓  ${b.externalId?.slice(0, 18).padEnd(20)} ${b.guestName.padEnd(36)} ` +
      `net=R$${net.toFixed(2).padStart(9)} + comm=R$${commissionAmount.toFixed(2).padStart(7)} ` +
      `→ gross=R$${grossAmount.toFixed(2).padStart(9)} (${commPct}%)`
    );
  }

  console.log(`\n  Updated: ${updated}  |  No fee in notes: ${noMatch}`);

  // Summary of all Airbnb records after backfill
  const total = await prisma.booking.count({ where: { propertyId: RDI_ID, source: 'AIRBNB' } });
  const withComm = await prisma.booking.count({
    where: { propertyId: RDI_ID, source: 'AIRBNB', commissionAmount: { not: null } },
  });
  console.log(`\n  Airbnb records total: ${total}  |  with commissionAmount: ${withComm}  |  still missing: ${total - withComm}`);

  // Show average commission rate across all Airbnb bookings that now have data
  const agg = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*)::int                               AS cnt,
      ROUND(SUM("grossAmount")::numeric, 2)       AS total_gross,
      ROUND(SUM("commissionAmount")::numeric, 2)  AS total_comm,
      ROUND(AVG("commissionAmount" / NULLIF("grossAmount", 0) * 100)::numeric, 3) AS avg_rate
    FROM "Booking"
    WHERE "propertyId" = $1 AND source = 'AIRBNB'
      AND "commissionAmount" IS NOT NULL
  `, RDI_ID);

  if (agg[0]) {
    const r = agg[0];
    console.log(
      `\n  Airbnb commission summary (${r.cnt} bookings):` +
      `\n    Total gross paid by guests: R$${parseFloat(r.total_gross).toFixed(2)}` +
      `\n    Total commission to Airbnb: R$${parseFloat(r.total_comm).toFixed(2)}` +
      `\n    Average commission rate:    ${parseFloat(r.avg_rate).toFixed(3)}%`
    );
  }

  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
