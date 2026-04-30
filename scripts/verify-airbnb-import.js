'use strict';

/**
 * Spot-check verification for the Airbnb financial import. Reads a small
 * sample of recent Airbnb bookings + the historical R$200/250/270 boundary
 * cases and prints their financial fields so an operator can confirm the
 * UPSERT actually landed correctly.
 *
 * One-off — written 2026-04-30 to verify commit 5ef7cfc + the dry-run +
 * commit cycle. Safe to delete once the financial dashboard (Sprint 3 E1)
 * is in place and gives the same view through the UI.
 */

const prisma = require('../lib/db');

async function main() {
  // Sample: 3 most recent + 1 each from the R$200, R$250, R$270 eras
  const recent = await prisma.booking.findMany({
    where:   { source: 'AIRBNB', actualCleaningFee: { not: null } },
    select:  {
      externalId: true, guestName: true, checkIn: true, checkOut: true,
      actualCleaningFee: true, airbnbHostFee: true, actualPayout: true,
      airbnbReportedAt: true,
    },
    orderBy: { checkIn: 'desc' },
    take:    3,
  });

  const oldEra = await prisma.booking.findFirst({
    where:   { source: 'AIRBNB', actualCleaningFee: 200 },
    select:  {
      externalId: true, guestName: true, checkIn: true,
      actualCleaningFee: true, airbnbHostFee: true, actualPayout: true,
    },
  });

  const totalUpdated = await prisma.booking.count({
    where: { airbnbReportedAt: { not: null } },
  });

  console.log('=== Recent 3 Airbnb bookings (post-import) ===');
  recent.forEach(b => {
    const ci = b.checkIn.toISOString().slice(0, 10);
    const co = b.checkOut.toISOString().slice(0, 10);
    console.log(`  ${b.externalId} · ${b.guestName} · ${ci} → ${co}`);
    console.log(`    cleaning=R$${b.actualCleaningFee} hostFee=R$${b.airbnbHostFee} payout=R$${b.actualPayout}`);
    console.log(`    reportedAt=${b.airbnbReportedAt?.toISOString() || 'null'}`);
  });

  if (oldEra) {
    console.log('\n=== Sample old-era R$200 booking ===');
    console.log(`  ${oldEra.externalId} · ${oldEra.guestName} · ${oldEra.checkIn.toISOString().slice(0, 10)}`);
    console.log(`    cleaning=R$${oldEra.actualCleaningFee} hostFee=R$${oldEra.airbnbHostFee} payout=R$${oldEra.actualPayout}`);
  } else {
    console.log('\n(no R$200 era booking found in DB — may pre-date iCal sync)');
  }

  console.log(`\nTotal bookings with airbnbReportedAt set: ${totalUpdated}`);
}

main()
  .catch(err => {
    console.error('verify failed:', err.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
