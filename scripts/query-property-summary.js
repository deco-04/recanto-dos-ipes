'use strict';
/**
 * Mirrors GET /api/staff/_diag/property-data-summary without needing a
 * session cookie — queries the live DB directly via Prisma. Use this to
 * compare bookingCount / expenseCount / totalRevenue across properties.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

// Same constant the staff-portal.js endpoints use for "revenue-counting" rows.
const REVENUE_STATUS = ['CONFIRMED', 'COMPLETED'];

async function main() {
  const props = await p.property.findMany({
    where:   { active: true },
    select:  { id: true, slug: true, name: true },
    orderBy: { name: 'asc' },
  });

  console.log('\n== Property data summary ==\n');
  console.log('(bookings counted: status in [CONFIRMED, COMPLETED])');
  console.log('');

  const rows = [];
  for (const prop of props) {
    const [bookingCount, expenseCount, revenueAgg] = await Promise.all([
      p.booking.count({ where: { propertyId: prop.id, status: { in: REVENUE_STATUS } } }),
      p.expense.count({ where: { propertyId: prop.id } }),
      p.booking.aggregate({
        where: { propertyId: prop.id, status: { in: REVENUE_STATUS } },
        _sum:  { totalAmount: true },
      }),
    ]);

    const totalRevenue = parseFloat(revenueAgg._sum.totalAmount?.toString() || '0');
    rows.push({
      slug:          prop.slug,
      name:          prop.name,
      id:            prop.id,
      bookingCount,
      expenseCount,
      totalRevenue,
    });
  }

  // Pretty-print as a fixed-width table
  const padR = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const fmt  = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  console.log(
    padR('SLUG', 24) + padR('NAME', 34) +
    padL('BOOKINGS', 10) + padL('EXPENSES', 10) + padL('REVENUE (R$)', 18),
  );
  console.log('─'.repeat(96));
  for (const r of rows) {
    console.log(
      padR(r.slug, 24) + padR(r.name.slice(0, 33), 34) +
      padL(r.bookingCount, 10) + padL(r.expenseCount, 10) + padL(fmt(r.totalRevenue), 18),
    );
  }
  console.log('');

  // Orphan booking check (expense.propertyId is NOT NULL in the schema,
  // so it can't have orphans).
  const orphanBookings = await p.booking.count({
    where: { propertyId: null, status: { in: REVENUE_STATUS } },
  });
  if (orphanBookings) {
    console.log(`⚠️  Orphan bookings (propertyId=NULL, revenue-status): ${orphanBookings}`);
  } else {
    console.log('✅ No orphan propertyId=NULL bookings.\n');
  }
}

main()
  .catch(e => { console.error('\n❌ ERROR:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
