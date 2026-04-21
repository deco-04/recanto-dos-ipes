'use strict';
/**
 * Idempotent admin-master promotion — does NOT touch password.
 * Safe to re-run. Prints a before/after diff so the change is auditable.
 */
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const EMAIL = process.argv[2] || 'recantodoipes@gmail.com';

async function main() {
  console.log(`\n🔍 Looking up staff by email: ${EMAIL}\n`);

  const before = await p.staffMember.findUnique({
    where: { email: EMAIL },
    include: { properties: { include: { property: { select: { id: true, slug: true, name: true, active: true } } } } },
  });

  if (!before) {
    console.error(`❌ No staff found with email ${EMAIL}.`);
    console.error(`   Use scripts/create-admin.js if you need to seed a fresh admin.`);
    process.exit(1);
  }

  console.log('── Before ──');
  console.log(`   id:             ${before.id}`);
  console.log(`   role:           ${before.role}`);
  console.log(`   active:         ${before.active}`);
  console.log(`   firstLoginDone: ${before.firstLoginDone}`);
  console.log(`   properties:     ${before.properties.length ? before.properties.map(a => a.property?.slug).join(', ') : '(none)'}`);
  console.log('');

  // 1. Ensure role=ADMIN + active=true + firstLoginDone=true (skip onboarding).
  //    Password/phone/googleId/name stay untouched.
  const updated = await p.staffMember.update({
    where: { id: before.id },
    data: {
      role:           'ADMIN',
      active:         true,
      firstLoginDone: true,
    },
  });

  // 2. Assign to every active property (idempotent — upsert skips duplicates).
  const activeProps = await p.property.findMany({ where: { active: true } });
  const newlyAssigned = [];
  for (const prop of activeProps) {
    const res = await p.staffPropertyAssignment.upsert({
      where:  { staffId_propertyId: { staffId: before.id, propertyId: prop.id } },
      create: { staffId: before.id, propertyId: prop.id },
      update: {},
    });
    // Heuristic: if createdAt is within the last 2s, it was just inserted.
    if (Date.now() - new Date(res.createdAt).getTime() < 2000) {
      newlyAssigned.push(prop.slug);
    }
  }

  const after = await p.staffMember.findUnique({
    where: { id: before.id },
    include: { properties: { include: { property: { select: { slug: true } } } } },
  });

  console.log('── After ──');
  console.log(`   id:             ${after.id}`);
  console.log(`   role:           ${after.role}`);
  console.log(`   active:         ${after.active}`);
  console.log(`   firstLoginDone: ${after.firstLoginDone}`);
  console.log(`   properties:     ${after.properties.map(a => a.property?.slug).join(', ')}`);
  if (newlyAssigned.length) {
    console.log(`   (newly assigned: ${newlyAssigned.join(', ')})`);
  }
  console.log('');
  console.log('✅ Admin-master promotion complete. Password untouched.');
}

main()
  .catch(e => { console.error('\n❌ ERROR:', e.message); process.exit(1); })
  .finally(() => p.$disconnect());
