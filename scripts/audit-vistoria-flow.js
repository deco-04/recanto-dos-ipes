'use strict';
/**
 * Audit the data the vistoria flow depends on.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  // 1. Property types + cabin counts per active property
  console.log('\n== Properties (type + cabins) ==');
  const props = await p.property.findMany({
    where: { active: true },
    include: { cabins: { select: { id: true, slug: true, name: true } } },
    orderBy: { slug: 'asc' },
  });
  for (const r of props) {
    console.log(`  ${r.slug.padEnd(22)} type=${String(r.type).padEnd(16)} cabins=${r.cabins.length}  [${r.cabins.map(c => c.slug).join(', ')}]`);
  }

  // 2. Recent vistorias — who submitted, for which booking, tipo, and PDF existence hint
  console.log('\n== Last 5 vistorias ==');
  const recents = await p.inspectionReport.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      booking: { select: { id: true, guestName: true, propertyId: true, cabinId: true, status: true, checkIn: true, checkOut: true } },
      staff:   { select: { id: true, name: true } },
    },
  });
  for (const v of recents) {
    console.log(`  ${v.id.slice(-8)} tipo=${v.tipo} status=${v.status} booking=${v.bookingId?.slice(-8)} hospede="${v.booking?.guestName ?? '?'}" checkout=${v.booking?.checkOut?.toISOString()?.slice(0,10)} staff="${v.staff?.name ?? '?'}" submittedAt=${v.submittedAt?.toISOString() ?? '(draft)'} `);
  }

  // 3. Existing BookingStatus enum values in use
  console.log('\n== Current booking statuses ==');
  const statuses = await p.booking.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  for (const s of statuses) console.log(`  ${s.status.padEnd(12)} ${s._count._all}`);

  // 4. Active RDI bookings (past checkout, still CONFIRMED)
  const now = new Date();
  const pastCheckout = await p.booking.findMany({
    where: {
      status: 'CONFIRMED',
      checkOut: { lt: now },
      property: { slug: 'recanto-dos-ipes' },
    },
    select: { id: true, guestName: true, checkOut: true, status: true },
    orderBy: { checkOut: 'desc' },
    take: 5,
  });
  console.log(`\n== RDI CONFIRMED bookings past checkout (should ideally be COMPLETED) ==`);
  for (const b of pastCheckout) {
    console.log(`  ${b.id.slice(-8)} ${b.guestName} checkout=${b.checkOut.toISOString().slice(0,16)} status=${b.status}`);
  }

  await p.$disconnect();
})();
