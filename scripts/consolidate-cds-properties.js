'use strict';
/**
 * Consolidates the two CDS property rows:
 *   - legacy   slug='cabanas'           (12 expenses as of 2026-04-21)
 *   - canonical slug='cabanas-da-serra' (6 expenses as of 2026-04-21)
 *
 * Plan (soft-delete protocol — no hard deletes):
 *   1. Audit: print before-state for both properties.
 *   2. Reassign every row referencing the legacy property to the canonical one:
 *      - Expense.propertyId
 *      - BlockedDate.propertyId (if any)
 *      - StaffPropertyAssignment (merge; remove legacy link AFTER ensuring canonical link exists)
 *      - Any other row with propertyId FK (discover via schema comment)
 *   3. Mark legacy property.active = false. Do NOT delete the row.
 *   4. Audit: print after-state for both properties.
 *
 * Idempotent — re-runs are safe; after the first run the legacy row has
 * zero linked rows and just stays inactive.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const LEGACY_SLUG    = 'cabanas';
const CANONICAL_SLUG = 'cabanas-da-serra';

async function audit(label, legacyId, canonicalId) {
  const [legExp, canExp, legBlk, canBlk, legAssn, canAssn, legBook, canBook] = await Promise.all([
    p.expense.count({ where: { propertyId: legacyId } }),
    p.expense.count({ where: { propertyId: canonicalId } }),
    p.blockedDate.count({ where: { propertyId: legacyId } }).catch(() => 'n/a'),
    p.blockedDate.count({ where: { propertyId: canonicalId } }).catch(() => 'n/a'),
    p.staffPropertyAssignment.count({ where: { propertyId: legacyId } }),
    p.staffPropertyAssignment.count({ where: { propertyId: canonicalId } }),
    p.booking.count({ where: { propertyId: legacyId } }),
    p.booking.count({ where: { propertyId: canonicalId } }),
  ]);
  const [legacy, canonical] = await Promise.all([
    p.property.findUnique({ where: { id: legacyId }, select: { slug: true, active: true } }),
    p.property.findUnique({ where: { id: canonicalId }, select: { slug: true, active: true } }),
  ]);
  console.log(`── ${label} ──`);
  console.log(`   legacy    (${legacy.slug}, active=${legacy.active}): expenses=${legExp}, blockedDates=${legBlk}, staffAssignments=${legAssn}, bookings=${legBook}`);
  console.log(`   canonical (${canonical.slug}, active=${canonical.active}): expenses=${canExp}, blockedDates=${canBlk}, staffAssignments=${canAssn}, bookings=${canBook}`);
  console.log('');
}

async function main() {
  const [legacy, canonical] = await Promise.all([
    p.property.findUnique({ where: { slug: LEGACY_SLUG } }),
    p.property.findUnique({ where: { slug: CANONICAL_SLUG } }),
  ]);
  if (!legacy) {
    console.log(`ℹ️  No legacy '${LEGACY_SLUG}' row found — nothing to consolidate.`);
    process.exit(0);
  }
  if (!canonical) {
    console.error(`❌ Canonical '${CANONICAL_SLUG}' row missing. Seed it first; refusing to orphan data.`);
    process.exit(1);
  }

  await audit('Before', legacy.id, canonical.id);

  // 1. Reassign expenses.
  const moveExpenses = await p.expense.updateMany({
    where: { propertyId: legacy.id },
    data:  { propertyId: canonical.id },
  });

  // 2. Reassign blocked dates (ignore if the model doesn't exist).
  let moveBlocked = { count: 0 };
  try {
    moveBlocked = await p.blockedDate.updateMany({
      where: { propertyId: legacy.id },
      data:  { propertyId: canonical.id },
    });
  } catch {
    // BlockedDate may not reference Property — skip.
  }

  // 3. Reassign bookings (should be zero by 2026-04-21, but defensive).
  const moveBookings = await p.booking.updateMany({
    where: { propertyId: legacy.id },
    data:  { propertyId: canonical.id },
  });

  // 4. Merge staff assignments. Upsert each legacy assignment onto canonical,
  //    then delete the legacy link. `@@unique([staffId, propertyId])` makes
  //    this safe — upsert ignores duplicates.
  const legacyAssn = await p.staffPropertyAssignment.findMany({
    where:  { propertyId: legacy.id },
    select: { staffId: true },
  });
  for (const { staffId } of legacyAssn) {
    await p.staffPropertyAssignment.upsert({
      where:  { staffId_propertyId: { staffId, propertyId: canonical.id } },
      create: { staffId, propertyId: canonical.id },
      update: {},
    });
  }
  const deleteAssn = await p.staffPropertyAssignment.deleteMany({
    where: { propertyId: legacy.id },
  });

  // 5. Soft-delete the legacy row — keep the ID so future deploys don't
  //    crash if anything still references it (e.g. historical exports).
  await p.property.update({
    where: { id: legacy.id },
    data:  { active: false },
  });

  console.log('── Changes ──');
  console.log(`   expenses moved:          ${moveExpenses.count}`);
  console.log(`   blockedDates moved:      ${moveBlocked.count}`);
  console.log(`   bookings moved:          ${moveBookings.count}`);
  console.log(`   staffAssignments merged: ${legacyAssn.length} (${deleteAssn.count} legacy links removed)`);
  console.log(`   legacy property.active:  false`);
  console.log('');

  await audit('After', legacy.id, canonical.id);

  console.log('✅ CDS consolidation complete.');
  console.log(`   Legacy slug='${LEGACY_SLUG}' soft-deleted (active=false). Row preserved for audit trail.`);
}

main()
  .catch(e => { console.error('\n❌ ERROR:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
