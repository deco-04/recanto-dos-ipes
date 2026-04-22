'use strict';
/**
 * Create/update a dedicated e2e testing admin account.
 * Separate from Andre's real account so CI can authenticate without
 * leaking his production password into GitHub secrets.
 *
 * Idempotent — safe to re-run. Always resets password to env-provided value.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

const EMAIL    = process.env.E2E_ADMIN_EMAIL    || 'e2e-tests@recantosdaserra.com';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;
if (!PASSWORD) {
  console.error('❌ E2E_ADMIN_PASSWORD env var required');
  process.exit(1);
}

(async () => {
  const hash = await bcrypt.hash(PASSWORD, 12);

  let staff = await p.staffMember.findUnique({ where: { email: EMAIL } });
  if (staff) {
    staff = await p.staffMember.update({
      where: { id: staff.id },
      data: { passwordHash: hash, active: true, firstLoginDone: true, role: 'ADMIN' },
    });
    console.log(`✓ Updated existing e2e admin: ${staff.id}`);
  } else {
    staff = await p.staffMember.create({
      data: {
        name:           'E2E Test Admin',
        email:          EMAIL,
        role:           'ADMIN',
        active:         true,
        firstLoginDone: true,
        passwordHash:   hash,
      },
    });
    console.log(`✓ Created e2e admin: ${staff.id}`);
  }

  // Assign to ALL active properties so dashboards render
  const properties = await p.property.findMany({ where: { active: true } });
  for (const prop of properties) {
    await p.staffPropertyAssignment.upsert({
      where:  { staffId_propertyId: { staffId: staff.id, propertyId: prop.id } },
      create: { staffId: staff.id, propertyId: prop.id },
      update: {},
    });
  }

  console.log(`✓ Assigned to ${properties.length} properties`);
  console.log('');
  console.log('────────────────────── CI CREDENTIALS ──────────────────────');
  console.log(`  E2E_ADMIN_EMAIL    = ${EMAIL}`);
  console.log(`  E2E_ADMIN_PASSWORD = ${PASSWORD}`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('');
  console.log('Set these as GitHub Actions secrets:');
  console.log('  https://github.com/deco-04/recantos-central-equipe/settings/secrets/actions/new');

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
