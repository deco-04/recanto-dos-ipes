'use strict';

/**
 * reclassify-financeiro.js
 * Re-categorizes all A_CLASSIFICAR / OUTROS expenses and creates booking
 * records for direct guest payments (upsells + unmatched direct stays).
 * Safe to re-run — all operations are idempotent.
 */

const prisma = require('../lib/db');
const RDI_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

function n(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

// ── PART A — Expense reclassification rules ───────────────────────────────────
// Each rule: { match: fn(payee, amount) → bool, cat: 'CATEGORY' }
const RECAT_RULES = [
  // A_CLASSIFICAR fixes
  { match: p => n(p).includes('MINISTERIO DA ECONOMIA'),           cat: 'IMPOSTOS' },
  { match: p => n(p).includes('TELEFONICA BRASIL'),                cat: 'INTERNET' },
  { match: p => n(p).includes('COMERCIO DE FERRAMENTAS SAO LUIZ'), cat: 'MATERIAIS_MELHORIAS' },
  { match: p => n(p).includes('MAPF ENXOVAIS'),                    cat: 'MATERIAIS_MELHORIAS' },
  { match: p => n(p).includes('PIX MARKETPLACE'),                  cat: 'COMPRAS_ONLINE' },
  { match: p => n(p).includes('JOAO HENRIQUE NOGUEIRA'),           cat: 'OBRAS_CONSTRUCAO' },
  { match: p => n(p).includes('JEAN CARLOS SOARES'),               cat: 'OBRAS_CONSTRUCAO' },
  { match: p => n(p).includes('DIEGO MATEUS MARTINS'),             cat: 'OBRAS_CONSTRUCAO' },
  { match: p => n(p).includes('LINDEMBERG HELENO'),                cat: 'OBRAS_CONSTRUCAO' },
  { match: p => n(p).includes('ELIZANE MARQUES'),                  cat: 'OBRAS_CONSTRUCAO' },
  { match: p => n(p).includes('GEYSSIARA') || n(p).includes('GEISIARA'), cat: 'MANUTENCAO_PISCINA' },
  { match: p => n(p).includes('JEISIANE APARECIDA'),               cat: 'MANUTENCAO_PISCINA' },
  { match: p => n(p).includes('CARLA FERNANDA DA SILVA'),          cat: 'SERVICOS_LIMPEZA' },
  { match: p => n(p).includes('HEMILLY NATALLY'),                  cat: 'SERVICOS_LIMPEZA' },
  { match: p => n(p).includes('OSVALDINEI'),                       cat: 'JARDINAGEM_PAISAGISMO' },
  { match: p => n(p).includes('ALEX ANTONIO DA SILVA CORREIA'),    cat: 'MANUTENCAO_SOLAR_BOMBA' },
  { match: p => n(p).includes('SHPP BRASIL'),                      cat: 'CARTAO_CREDITO' },
  { match: p => n(p).includes('FROGPAY'),                          cat: 'CARTAO_CREDITO' },
  { match: p => n(p).includes('MULTICOM INTERMEDIACAO'),           cat: 'CARTAO_CREDITO' },
  // Remaining A_CLASSIFICAR → OUTROS
  { match: (p, a, currentCat) => currentCat === 'A_CLASSIFICAR',  cat: 'OUTROS' },

  // OUTROS — Jacqueline re-split by amount
  // Large (> R$350): cleaning services
  { match: (p, a) => n(p).includes('JACQUELINE') && a > 350,      cat: 'SERVICOS_LIMPEZA' },
  // Mid (R$100–R$349): cleaning/maintenance services
  { match: (p, a) => n(p).includes('JACQUELINE') && a >= 100 && a <= 349, cat: 'SERVICOS_LIMPEZA' },
  // Small (< R$100): supply reimbursements
  { match: (p, a) => n(p).includes('JACQUELINE') && a < 100,      cat: 'PRODUTOS_LIMPEZA_PISCINA' },
];

// ── PART B — Upsells matched to existing Airbnb/Booking.com bookings ─────────
// These are direct PIX payments FROM guests who were booked via OTA.
// They represent add-ons not going through the platform — real additional revenue.
const UPSELLS = [
  { extId: 'upsell-HMY5DKXZJE-20260210',   guest: 'Lina Ferreira Fernandes',          checkIn: '2026-02-10', checkOut: '2026-02-11', amount: 25,     note: 'Upsell pago direto. Reserva Airbnb HMY5DKXZJE (Lina, check-in 2026-02-07)' },
  { extId: 'upsell-bcom6413085515-20260129',guest: 'Rodrigo Castro Vilela',            checkIn: '2026-01-30', checkOut: '2026-02-01', amount: 200,    note: 'Upsell pago direto. Reserva Booking.com bcom-6413085515 (check-in 2026-01-30)' },
  { extId: 'upsell-HMQ9EKAC2D-20260105',   guest: 'Douglas Dantas Campos',            checkIn: '2026-01-05', checkOut: '2026-01-06', amount: 164,    note: 'Upsell pago direto. Reserva Airbnb HMQ9EKAC2D (Douglas, check-in 2025-12-30)' },
  { extId: 'upsell-HME2T3BFEH-20251222',   guest: 'Matheus Ribeiro Cruz',             checkIn: '2026-01-03', checkOut: '2026-01-05', amount: 275,    note: 'Upsell/antecipação pago direto. Reserva Airbnb HME2T3BFEH (Matheus, check-in 2026-01-03)' },
  { extId: 'upsell-HM4A35BDBS-20251221',   guest: 'Andreia Caroline dos Santos Fonseca', checkIn: '2025-12-23', checkOut: '2025-12-25', amount: 400, note: 'Upsell pago direto. Reserva Airbnb HM4A35BDBS (Andreia, check-in 2025-12-23)' },
  { extId: 'upsell-HMYFS8MZSH-20251015',   guest: 'Luciana Bento de Oliveira',        checkIn: '2025-10-18', checkOut: '2025-10-20', amount: 309,    note: 'Upsell pago direto (R$200+R$50+R$59). Reserva Airbnb HMYFS8MZSH (Luciana, check-in 2025-10-18)' },
  { extId: 'upsell-HMHPSB3YCM-20250729',   guest: 'Eduarda Marques Celestino Azevedo',checkIn: '2025-07-12', checkOut: '2025-07-14', amount: 296,    note: 'Upsell pago direto. Reserva Airbnb HMHPSB3YCM (Eduarda, check-in 2025-07-12)' },
  { extId: 'upsell-HMHHPB54T2-20250721',   guest: 'Philip Brito Lima',                checkIn: '2025-07-19', checkOut: '2025-07-21', amount: 111,    note: 'Upsell pago direto. Reserva Airbnb HMHHPB54T2 (Philip, check-in 2025-07-19)' },
  { extId: 'upsell-HMMY5N85N5-20250408',   guest: 'Thalles Alves da Silva Sales',     checkIn: '2025-04-12', checkOut: '2025-04-14', amount: 400,    note: 'Upsell/antecipação pago direto. Reserva Airbnb HMMY5N85N5 (Thalles, check-in 2025-04-12)' },
  { extId: 'upsell-HMYR2BBDAS-20250206',   guest: 'Paulo Ricardo Freitas Macedo',     checkIn: '2025-02-08', checkOut: '2025-02-10', amount: 450,    note: 'Upsell pago direto (R$250+R$200). Reserva Airbnb HMYR2BBDAS (Paulinho Ricardo, check-in 2025-02-08)' },
  { extId: 'upsell-HMWTR9AP5T-20241003',   guest: 'Patricia Alves Guimarães',         checkIn: '2024-10-11', checkOut: '2024-10-13', amount: 800,    note: 'Upsell/antecipação pago direto. Reserva Airbnb HMWTR9AP5T (Patrícia, check-in 2024-10-11)' },
  { extId: 'upsell-HM39E2PTB8-20240924',   guest: 'Rosana Crist Brito Cupertino',     checkIn: '2024-12-21', checkOut: '2024-12-23', amount: 500,    note: 'Antecipação pago direto. Reserva Airbnb HM39E2PTB8 (Rosana, check-in 2024-12-21)' },
  { extId: 'upsell-HM2PZSKPQ9-20240924',   guest: 'Lucas Prado Milhorato',            checkIn: '2024-09-21', checkOut: '2024-09-23', amount: 89,     note: 'Upsell pago direto. Reserva Airbnb HM2PZSKPQ9 (Lucas Prado, check-in 2024-09-21)' },
  { extId: 'upsell-HMKTKEPMNY-20240725',   guest: 'Hugo Johnson Vieira Rocha',        checkIn: '2024-07-27', checkOut: '2024-07-29', amount: 400,    note: 'Upsell/antecipação pago direto. Reserva Airbnb HMKTKEPMNY (Nayara, check-in 2024-07-27)' },
  { extId: 'upsell-HMBZ9NQ2YT-20240711',   guest: 'Carolline Cunha Oliveira',         checkIn: '2024-07-13', checkOut: '2024-07-15', amount: 507.16, note: 'Antecipação pago direto. Reserva Airbnb HMBZ9NQ2YT (Carolline, check-in 2024-07-13)' },
  { extId: 'upsell-HMCMF5JCAD-20240206',   guest: 'Raquel Merces Ribeiro',            checkIn: '2024-02-09', checkOut: '2024-02-11', amount: 500,    note: 'Antecipação pago direto. Reserva Airbnb HMCMF5JCAD (Raquel Jardim, check-in 2024-02-09)' },
];

// ── PART C — New DIRECT bookings for unmatched payments ───────────────────────
// Dates estimated from payment date + typical same-weekend pattern.
const NEW_BOOKINGS = [
  // Jenepher Felício — 3 bank transfers = 1 big Sep 2024 stay
  { extId: 'direct-JENEPHER-FELICIO-2024-09', guest: 'Jenepher Felício da Silva', checkIn: '2024-09-20', checkOut: '2024-09-23', nights: 3, amount: 4000, note: 'Reserva direta. Pago em parcelas: R$1.000 (21/08) + R$1.000 + R$2.000 (21/09)' },
  // Demerge Brasil — payment processor, two separate bookings
  { extId: 'direct-DEMERGE-2024-03',          guest: 'Hóspede Demerge Brasil (Mar/2024)', checkIn: '2024-03-10', checkOut: '2024-03-12', nights: 2, amount: 1586.01, note: 'Reserva paga via Demerge Brasil Pagamentos. R$1.066,01 (03/03) + R$520 (07/03)' },
  { extId: 'direct-DEMERGE-2024-07',          guest: 'Hóspede Demerge Brasil (Jul/2024)',  checkIn: '2024-07-25', checkOut: '2024-07-27', nights: 2, amount: 1140, note: 'Reserva paga via Demerge Brasil Pagamentos. R$1.140 (25/07)' },
  // Marcio + Lucia Aguiar — family booking, Semana Santa 2024
  { extId: 'direct-MARCIO-AGUIAR-2024-03',    guest: 'Marcio Silveira de Aguiar',  checkIn: '2024-03-29', checkOut: '2024-04-01', nights: 3, amount: 1800, note: 'Reserva direta Semana Santa 2024. R$900 (17/02 Marcio) + R$100 Marcio + R$800 Lucia (28/03)' },
  // Christiane Alvarenga — Jan 2025 large payment
  { extId: 'direct-CHRISTIANE-2025-01',       guest: 'Christiane Alvarenga Dolabela', checkIn: '2025-01-11', checkOut: '2025-01-13', nights: 2, amount: 1218, note: 'Reserva direta. PIX R$1.218 (10/01/2025)' },
  // Raquel Merces Ribeiro — Feb 2025 (different from her Feb 2024 Airbnb upsell)
  { extId: 'direct-RAQUEL-RIBEIRO-2025-02',   guest: 'Raquel Merces Ribeiro',      checkIn: '2025-02-28', checkOut: '2025-03-02', nights: 2, amount: 650, note: 'Reserva direta. R$400 (17/02) + R$250 (26/02)' },
  // Luanda Pimenta — two Nov 2025 payments (likely one stay)
  { extId: 'direct-LUANDA-PIMENTA-2025-11',   guest: 'Luanda Pimenta Bonfim',      checkIn: '2025-11-15', checkOut: '2025-11-17', nights: 2, amount: 950, note: 'Reserva direta. R$650 (14/11) + R$300 (24/11)' },
  // João Pedro Barbosa — Oct 2025
  { extId: 'direct-JOAO-PEDRO-ARAUJO-2025-10',guest: 'João Pedro Barbosa de Araújo', checkIn: '2025-10-25', checkOut: '2025-10-27', nights: 2, amount: 900, note: 'Reserva direta. PIX R$900 (20/10/2025)' },
  // Cristiana Reis Andrade — Sep 2025
  { extId: 'direct-CRISTIANA-ANDRADE-2025-09',guest: 'Cristiana Reis Andrade',     checkIn: '2025-09-20', checkOut: '2025-09-22', nights: 2, amount: 200, note: 'Reserva direta. PIX R$200 (16/09/2025)' },
  // GMAP Serviços Médicos — Jul 2025 (company booking)
  { extId: 'direct-GMAP-2025-07',             guest: 'GMAP Serviços Médicos Ltda', checkIn: '2025-07-11', checkOut: '2025-07-13', nights: 2, amount: 325, note: 'Reserva direta (empresa). PIX R$325 (11/07/2025)' },
  // Patrick Meireles — Apr 2025
  { extId: 'direct-PATRICK-MEIRELES-2025-04', guest: 'Patrick Meireles de Melo Apolinário', checkIn: '2025-04-19', checkOut: '2025-04-21', nights: 2, amount: 150, note: 'Reserva direta. PIX R$150 (16/04/2025)' },
  // Hamilton Alves — May 2025
  { extId: 'direct-HAMILTON-ALVES-2025-05',   guest: 'Hamilton Alves dos Santos',  checkIn: '2025-05-10', checkOut: '2025-05-12', nights: 2, amount: 150, note: 'Reserva direta. PIX R$150 (02/05/2025)' },
  // Marina Correa — Jan 2026
  { extId: 'direct-MARINA-CORREA-2026-01',    guest: 'Marina Correa Gomes Paulino', checkIn: '2026-01-31', checkOut: '2026-02-02', nights: 2, amount: 400, note: 'Reserva direta. PIX R$400 (26/01/2026)' },
  // Ernane Lucas — Sep 2024
  { extId: 'direct-ERNANE-LUCAS-2024-09',     guest: 'Ernane Lucas França Alves dos Santos', checkIn: '2024-09-20', checkOut: '2024-09-22', nights: 2, amount: 180, note: 'Reserva direta. PIX R$180 (16/09/2024)' },
  // Victoria Aroeira Mueller — Nov/Dec 2023
  { extId: 'direct-VICTORIA-MUELLER-2023-11', guest: 'Victoria Aroeira Mueller',   checkIn: '2023-11-30', checkOut: '2023-12-02', nights: 2, amount: 300, note: 'Reserva direta. PIX R$300 (28/11/2023)' },
  { extId: 'direct-VICTORIA-MUELLER-2023-12', guest: 'Victoria Aroeira Mueller',   checkIn: '2023-12-29', checkOut: '2023-12-31', nights: 2, amount: 600, note: 'Reserva direta Réveillon 2024. PIX R$600 (31/12/2023)' },
  // Marcella Thamara — Dec 2023
  { extId: 'direct-MARCELLA-THAMARA-2023-12', guest: 'Marcella Thamara Gomes Pereira', checkIn: '2023-12-09', checkOut: '2023-12-11', nights: 2, amount: 300, note: 'Reserva direta. PIX R$300 (04/12/2023)' },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== reclassify-financeiro.js ===\n');

  // ── Part A: Reclassify expenses ───────────────────────────────────────────
  console.log('[A] Reclassifying expenses...');
  const expenses = await prisma.expense.findMany({
    where: { propertyId: RDI_ID },
    select: { id: true, payee: true, amount: true, category: true },
  });

  let updated = 0, unchanged = 0;
  for (const exp of expenses) {
    const amt = parseFloat(String(exp.amount));
    let target = null;
    for (const rule of RECAT_RULES) {
      if (rule.match(exp.payee, amt, exp.category)) {
        target = rule.cat;
        break;
      }
    }
    if (!target || target === exp.category) { unchanged++; continue; }
    // Use raw SQL — Prisma client enum may not include new values added via ALTER TYPE
    await prisma.$executeRawUnsafe(
      `UPDATE "Expense" SET "category" = '${target}'::"ExpenseCategory" WHERE id = '${exp.id}'`
    );
    updated++;
    console.log(`  ${exp.category} → ${target}: ${exp.payee.slice(0, 50)}`);
  }
  console.log(`  Updated: ${updated} | Unchanged: ${unchanged}`);

  // ── Part B: Create upsell booking records ─────────────────────────────────
  console.log('\n[B] Creating upsell booking records...');
  let upsellCreated = 0, upsellSkipped = 0;

  for (const u of UPSELLS) {
    const exists = await prisma.booking.findUnique({ where: { externalId: u.extId } });
    if (exists) { upsellSkipped++; continue; }

    await prisma.booking.create({
      data: {
        propertyId:       RDI_ID,
        guestName:        u.guest,
        guestEmail:       `${u.extId}@direct.import`,
        guestPhone:       u.extId,
        checkIn:          new Date(`${u.checkIn}T00:00:00Z`),
        checkOut:         new Date(`${u.checkOut}T00:00:00Z`),
        nights:           1,
        guestCount:       1,
        baseRatePerNight: u.amount,
        extraGuestFee:    0,
        petFee:           0,
        totalAmount:      u.amount,
        status:           'CONFIRMED',
        source:           'DIRECT',
        externalId:       u.extId,
        notes:            u.note,
      },
    });
    upsellCreated++;
    console.log(`  + Upsell: ${u.guest} R$${u.amount}`);
  }
  console.log(`  Created: ${upsellCreated} | Dupes skipped: ${upsellSkipped}`);

  // ── Part C: Create new direct booking records ─────────────────────────────
  console.log('\n[C] Creating new direct bookings...');
  let bookCreated = 0, bookSkipped = 0;

  for (const b of NEW_BOOKINGS) {
    const exists = await prisma.booking.findUnique({ where: { externalId: b.extId } });
    if (exists) { bookSkipped++; continue; }

    await prisma.booking.create({
      data: {
        propertyId:       RDI_ID,
        guestName:        b.guest,
        guestEmail:       `${b.extId}@direct.import`,
        guestPhone:       b.extId,
        checkIn:          new Date(`${b.checkIn}T00:00:00Z`),
        checkOut:         new Date(`${b.checkOut}T00:00:00Z`),
        nights:           b.nights,
        guestCount:       1,
        baseRatePerNight: parseFloat((b.amount / Math.max(b.nights, 1)).toFixed(2)),
        extraGuestFee:    0,
        petFee:           0,
        totalAmount:      b.amount,
        status:           'CONFIRMED',
        source:           'DIRECT',
        externalId:       b.extId,
        notes:            b.note,
      },
    });
    bookCreated++;
    console.log(`  + Booking: ${b.guest} R$${b.amount} (${b.checkIn})`);
  }
  console.log(`  Created: ${bookCreated} | Dupes skipped: ${bookSkipped}`);

  // ── Summary (raw SQL — Prisma client may not know new enum values) ────────
  const catCounts = await prisma.$queryRaw`
    SELECT category::text, COUNT(*)::int AS cnt, SUM(amount) AS total
    FROM "Expense" WHERE "propertyId" = ${RDI_ID}
    GROUP BY category ORDER BY SUM(amount) DESC`;

  const bySource = await prisma.$queryRaw`
    SELECT source::text, COUNT(*)::int AS cnt, SUM("totalAmount") AS total
    FROM "Booking" WHERE "propertyId" = ${RDI_ID}
    GROUP BY source ORDER BY SUM("totalAmount") DESC`;

  console.log('\n=== EXPENSE CATEGORIES (after) ===');
  for (const c of catCounts) {
    console.log(`  ${c.category}: ${c.cnt} entries, R$${parseFloat(String(c.total)).toFixed(2)}`);
  }

  console.log('\n=== BOOKINGS BY SOURCE ===');
  let grandTotal = 0;
  for (const s of bySource) {
    const total = parseFloat(String(s.total));
    grandTotal += total;
    console.log(`  ${s.source}: ${s.cnt} bookings, R$${total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  }
  console.log(`  TOTAL REVENUE: R$${grandTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
