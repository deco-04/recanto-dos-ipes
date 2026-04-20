'use strict';

/**
 * Seeds monthly "supplies overhead" expense records so the Financeiro Dashboard
 * reflects recurring non-booking costs (cleaning, pool, toilet paper, shampoo,
 * laundry soap, etc).
 *
 * Basis: ~R$1000 spent every 3 months per property, spread as ~R$333.33/month
 * on the 1st of each month. Idempotent — keyed off `bankRef` so re-running
 * won't create duplicates.
 *
 * Usage (Railway one-off):
 *   railway ssh --service recanto-dos-ipes "node scripts/seed-supplies-overhead.js"
 *
 * Options (env vars):
 *   OVERHEAD_MONTHLY (default: 333.33)   monthly amount per property (BRL)
 *   OVERHEAD_MONTHS  (default: 6)        how many months back+forward to seed
 */

const prisma = require('../lib/db');

const MONTHLY = parseFloat(process.env.OVERHEAD_MONTHLY || '333.33');
const MONTHS  = parseInt(process.env.OVERHEAD_MONTHS   || '6', 10);

function bankRef(propertySlug, year, month) {
  return `overhead:${propertySlug}:${year}-${String(month + 1).padStart(2, '0')}`;
}

async function main() {
  const properties = await prisma.property.findMany({
    where: { active: true },
    select: { id: true, slug: true, name: true },
  });

  if (properties.length === 0) {
    console.log('[seed-overhead] no active properties found — nothing to seed');
    return;
  }

  const now = new Date();
  const halfBack = Math.floor(MONTHS / 2);
  let created = 0;
  let skipped = 0;

  for (const prop of properties) {
    for (let i = -halfBack; i < MONTHS - halfBack; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const ref  = bankRef(prop.slug, date.getFullYear(), date.getMonth());

      const existing = await prisma.expense.findUnique({ where: { bankRef: ref } });
      if (existing) { skipped += 1; continue; }

      await prisma.expense.create({
        data: {
          propertyId:  prop.id,
          date,
          amount:      MONTHLY,
          category:    'PRODUTOS_LIMPEZA_PISCINA',
          description: 'Custos de insumos mensais (limpeza, piscina, higiênicos, etc.)',
          payee:       'Rateio mensal',
          source:      'MANUAL',
          bankRef:     ref,
          notes:       `Rateio R$${MONTHLY.toFixed(2)}/mês · baseado em R$1000 a cada 3 meses.`,
        },
      });
      created += 1;
    }
  }

  console.log(`[seed-overhead] done · created=${created} · skipped(already-existing)=${skipped} · properties=${properties.length}`);
}

main()
  .catch(err => { console.error('[seed-overhead] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
