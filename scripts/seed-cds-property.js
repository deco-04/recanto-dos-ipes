'use strict';

/**
 * Idempotent seed for the Cabanas da Serra (CDS) Property row.
 *
 * Ensures CDS exists so the staff-app invite form and obra workflow can target
 * it. Safe to re-run: checks by slug first, only creates if missing.
 *
 * Usage (Railway one-off):
 *   railway run --service recanto-dos-ipes node scripts/seed-cds-property.js
 *
 * Usage (local, with DATABASE_URL set):
 *   node scripts/seed-cds-property.js
 */

const prisma = require('../lib/db');

const CDS = {
  slug: 'cabanas-da-serra',
  name: 'Cabanas da Serra',
  type: 'CABANA_COMPLEX',
  city: 'Lima Duarte',
  state: 'MG',
  hasPool: false,
  websiteUrl: 'https://cabanasdaserra.com',
  active: true,
};

async function main() {
  const existing = await prisma.property.findUnique({
    where: { slug: CDS.slug },
    select: { id: true, name: true, active: true },
  });

  if (existing) {
    if (!existing.active) {
      await prisma.property.update({ where: { id: existing.id }, data: { active: true } });
      console.log(`[seed-cds] Re-activated existing CDS property (${existing.id})`);
    } else {
      console.log(`[seed-cds] CDS already exists and active (${existing.id}) — no-op`);
    }
    return;
  }

  const created = await prisma.property.create({ data: CDS });
  console.log(`[seed-cds] Created CDS property: ${created.id}`);
}

main()
  .catch(err => { console.error('[seed-cds] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
