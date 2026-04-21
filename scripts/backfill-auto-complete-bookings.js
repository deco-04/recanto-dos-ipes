'use strict';
/**
 * Backfill: any booking where status=CONFIRMED AND there's a SUBMITTED
 * CHECKOUT InspectionReport must transition to COMPLETED (the new auto-
 * complete logic shipped 2026-04-21 only applies going forward).
 *
 * Idempotent — next runs will find zero rows to update.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // Find every SUBMITTED CHECKOUT vistoria whose booking is still CONFIRMED.
  const candidates = await p.inspectionReport.findMany({
    where: { type: 'CHECKOUT', status: 'SUBMITTED', booking: { status: 'CONFIRMED' } },
    include: { booking: { select: { id: true, guestName: true, status: true, checkOut: true } } },
    orderBy: { submittedAt: 'desc' },
  });

  console.log(`\n🔍 Found ${candidates.length} CONFIRMED booking(s) with a submitted CHECKOUT vistoria.\n`);
  if (!candidates.length) {
    await p.$disconnect();
    return;
  }

  for (const v of candidates) {
    console.log(`   ${v.booking.id.slice(-8)}  "${v.booking.guestName}"  checkout=${v.booking.checkOut.toISOString().slice(0,10)}  vistoriaId=${v.id.slice(-8)}`);
  }

  const updated = await p.booking.updateMany({
    where: {
      status: 'CONFIRMED',
      inspections: { some: { type: 'CHECKOUT', status: 'SUBMITTED' } },
    },
    data: { status: 'COMPLETED' },
  });

  console.log(`\n✅ Transitioned ${updated.count} booking(s) from CONFIRMED → COMPLETED.\n`);
  await p.$disconnect();
})();
