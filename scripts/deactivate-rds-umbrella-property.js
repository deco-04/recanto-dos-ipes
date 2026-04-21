'use strict';
/**
 * Soft-delete the redundant `recantos-da-serra` umbrella property row.
 *
 * Per user 2026-04-21: "RDS · Visão Geral" in the PropertyPicker already
 * aggregates all properties into one view. Keeping a separate
 * `recantos-da-serra` row duplicates that responsibility and shows up
 * as a meaningless empty card (0 cabins / 0 bookings / 0 expenses).
 *
 * Idempotent soft-delete — no data is destroyed.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const SLUG = 'recantos-da-serra';
  const rds = await p.property.findUnique({
    where: { slug: SLUG },
    include: {
      cabins:   { select: { id: true } },
      bookings: { select: { id: true } },
      expenses: { select: { id: true } },
      staff:    { select: { id: true } },  // StaffPropertyAssignment via reverse relation
    },
  });
  if (!rds) {
    console.log(`ℹ️  No '${SLUG}' row found — nothing to deactivate.`);
    process.exit(0);
  }
  const counts = { cabins: rds.cabins.length, bookings: rds.bookings.length, expenses: rds.expenses.length, assignments: rds.staff.length };
  console.log(`\n── Before — '${SLUG}' (active=${rds.active}) ──`);
  console.log(`   ${JSON.stringify(counts)}`);

  if (counts.bookings > 0 || counts.expenses > 0) {
    console.error(`\n❌ REFUSING — '${SLUG}' has bookings (${counts.bookings}) or expenses (${counts.expenses}). Those would be orphaned. Consolidate first.`);
    process.exit(1);
  }

  // Drop any StaffPropertyAssignment pointing at RDS (admin had one from today's make-admin-master run).
  const delAssn = await p.staffPropertyAssignment.deleteMany({ where: { propertyId: rds.id } });

  // Soft-delete
  await p.property.update({ where: { id: rds.id }, data: { active: false } });

  const after = await p.property.findUnique({ where: { id: rds.id }, select: { active: true } });
  console.log(`\n── After ──`);
  console.log(`   active:                ${after.active}`);
  console.log(`   staff assignments cut: ${delAssn.count}`);
  console.log(`\n✅ Done. RDS · Visão Geral (the 'ALL' button in the picker) remains the canonical umbrella.`);
  await p.$disconnect();
})();
