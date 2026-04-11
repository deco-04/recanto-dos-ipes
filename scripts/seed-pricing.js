'use strict';

/**
 * Seed script — populates SeasonalPricing for 2025 and 2026.
 * Run once: npm run db:seed
 */

const prisma = require('../lib/db');

const PRICES = {
  LOW:      720,
  MID:      850,
  HIGH_MID: 1050,
  PEAK:     1300,
};

const entries = [
  // ── PEAK PERIODS ────────────────────────────────────────────────────────────
  // Réveillon / Ano Novo 2024-2025
  { name: 'Réveillon / Ano Novo 2024-2025', tier: 'PEAK', start: '2024-12-20', end: '2025-01-10', minNights: 3 },

  // Carnaval 2025 (Thu Feb 27 – Wed Mar 5)
  { name: 'Carnaval 2025', tier: 'PEAK', start: '2025-02-27', end: '2025-03-05', minNights: 2 },

  // Semana Santa / Páscoa 2025 (Apr 13–21)
  { name: 'Semana Santa / Páscoa 2025', tier: 'PEAK', start: '2025-04-12', end: '2025-04-21', minNights: 2 },

  // Julho pico 2025 (Jul 5–20)
  { name: 'Julho Peak 2025', tier: 'PEAK', start: '2025-07-05', end: '2025-07-20', minNights: 2 },

  // Réveillon / Ano Novo 2025-2026
  { name: 'Réveillon / Ano Novo 2025-2026', tier: 'PEAK', start: '2025-12-20', end: '2026-01-10', minNights: 3 },

  // Carnaval 2026 (Sat Feb 14 – Wed Feb 18)
  { name: 'Carnaval 2026', tier: 'PEAK', start: '2026-02-13', end: '2026-02-18', minNights: 2 },

  // Semana Santa / Páscoa 2026 (Mar 29 – Apr 5)
  { name: 'Semana Santa / Páscoa 2026', tier: 'PEAK', start: '2026-03-28', end: '2026-04-06', minNights: 2 },

  // Julho pico 2026 (Jul 4–19)
  { name: 'Julho Peak 2026', tier: 'PEAK', start: '2026-07-04', end: '2026-07-19', minNights: 2 },

  // ── HIGH_MID PERIODS (Julho shoulder) ────────────────────────────────────────
  { name: 'Julho Shoulder 2025 (início)', tier: 'HIGH_MID', start: '2025-07-01', end: '2025-07-04', minNights: 2 },
  { name: 'Julho Shoulder 2025 (final)', tier: 'HIGH_MID', start: '2025-07-21', end: '2025-07-31', minNights: 2 },
  { name: 'Julho Shoulder 2026 (início)', tier: 'HIGH_MID', start: '2026-07-01', end: '2026-07-03', minNights: 2 },
  { name: 'Julho Shoulder 2026 (final)', tier: 'HIGH_MID', start: '2026-07-20', end: '2026-07-31', minNights: 2 },

  // ── MID PERIODS (feriados prolongados) ────────────────────────────────────────
  // 2025
  { name: 'Tiradentes 2025',             tier: 'MID', start: '2025-04-19', end: '2025-04-21', minNights: 2 },
  { name: 'Dia do Trabalho 2025',        tier: 'MID', start: '2025-05-01', end: '2025-05-04', minNights: 2 },
  { name: 'Corpus Christi 2025',         tier: 'MID', start: '2025-06-19', end: '2025-06-22', minNights: 2 },
  { name: 'Independência do Brasil 2025',tier: 'MID', start: '2025-09-05', end: '2025-09-07', minNights: 2 },
  { name: 'N.Sra. Aparecida 2025',       tier: 'MID', start: '2025-10-10', end: '2025-10-12', minNights: 2 },
  { name: 'Finados 2025',                tier: 'MID', start: '2025-10-31', end: '2025-11-02', minNights: 2 },
  { name: 'Proclamação da República 2025',tier:'MID', start: '2025-11-14', end: '2025-11-16', minNights: 2 },
  { name: 'Natal 2025',                  tier: 'MID', start: '2025-12-24', end: '2025-12-19', minNights: 2 },

  // 2026
  { name: 'Tiradentes 2026',             tier: 'MID', start: '2026-04-17', end: '2026-04-21', minNights: 2 },
  { name: 'Dia do Trabalho 2026',        tier: 'MID', start: '2026-05-01', end: '2026-05-03', minNights: 2 },
  { name: 'Corpus Christi 2026',         tier: 'MID', start: '2026-06-04', end: '2026-06-07', minNights: 2 },
  { name: 'Independência do Brasil 2026',tier: 'MID', start: '2026-09-04', end: '2026-09-07', minNights: 2 },
  { name: 'N.Sra. Aparecida 2026',       tier: 'MID', start: '2026-10-09', end: '2026-10-12', minNights: 2 },
  { name: 'Finados 2026',                tier: 'MID', start: '2026-10-30', end: '2026-11-02', minNights: 2 },
  { name: 'Proclamação da República 2026',tier:'MID', start: '2026-11-13', end: '2026-11-15', minNights: 2 },
  { name: 'Natal 2026',                  tier: 'MID', start: '2026-12-24', end: '2026-12-26', minNights: 2 },
];

async function main() {
  console.log('Seeding seasonal pricing…');
  let created = 0;
  let skipped = 0;

  for (const entry of entries) {
    const existing = await prisma.seasonalPricing.findFirst({
      where: { name: entry.name },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.seasonalPricing.create({
      data: {
        name:         entry.name,
        tier:         entry.tier,
        startDate:    new Date(entry.start),
        endDate:      new Date(entry.end),
        pricePerNight: PRICES[entry.tier],
        minNights:    entry.minNights,
      },
    });
    created++;
    console.log(`  ✔ ${entry.name} (${entry.tier} · R$${PRICES[entry.tier]})`);
  }

  console.log(`\nDone — ${created} created, ${skipped} already existed.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
