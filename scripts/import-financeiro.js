'use strict';

/**
 * import-financeiro.js
 * One-time data seeder: bank CSV → Expense, Airbnb CSV → Booking, direct bookings → Booking
 * Run: node scripts/import-financeiro.js
 */

const fs   = require('fs');
const path = require('path');
const prisma = require('../lib/db');

// ── PATHS ─────────────────────────────────────────────────────────────────────
const UPLOADS = path.join(__dirname, '..', 'uploads', 'Finanças RDI', 'Relatórios do Recanto dos Ipes');
const BANK_CSV   = path.join(UPLOADS, '52-998-944-sthefane-lourdes-de-souza_01112021_a_13042026_2d745a63.csv');
const AIRBNB_CSV = path.join(UPLOADS, 'airbnb-completed-all.csv');

// ── HELPERS ───────────────────────────────────────────────────────────────────
function normalize(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().trim();
}

/** Parse DD/MM/YYYY → Date */
function parseBRDate(str) {
  const [d, m, y] = str.split('/');
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00Z`);
}

/** Parse MM/DD/YYYY → Date */
function parseUSDate(str) {
  const [m, d, y] = str.split('/');
  return new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00Z`);
}

function parseCSV(filePath, encoding = 'utf8') {
  let raw = fs.readFileSync(filePath, encoding);
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // strip BOM
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    // handle quoted fields with commas
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += ch;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (cols[i] || '').trim(); });
    return row;
  });
}

// ── CATEGORIZATION ────────────────────────────────────────────────────────────
const RULES = [
  { kw: ['JAIR JUNIO'],                         cat: 'MANUTENCAO_PISCINA'      },
  { kw: ['ANA MARIA SILVIA'],                   cat: 'PRODUTOS_LIMPEZA_PISCINA'},
  { kw: ['ALEX ANTONIO CORREIA'],               cat: 'MANUTENCAO_SOLAR_BOMBA'  },
  { kw: ['PROVERNET PLAY', 'PROVERNET'],        cat: 'INTERNET'                },
  { kw: ['FIT ASSOCIACAO', 'CEMIG DISTRIBUICAO','CEMIG'], cat: 'ENERGIA_ELETRICA'     },
  { kw: ['CONDOMINIO SITIO', 'CONDOMINIO'],     cat: 'CONDOMINIO'              },
  { kw: ['DAS - SIMPLES','DAS SIMPLES','DARF','MINISTERIO DA FAZENDA','RECEITA FEDERAL'], cat: 'IMPOSTOS' },
  { kw: ['NU PAGAMENTOS','NUBANK'],             cat: 'CARTAO_CREDITO'          },
  { kw: ['BRENO JARDIM VIEIRA'],                cat: 'DESIGN_ARQUITETURA'      },
  { kw: ['A X F MATERIAIS','AXF MATERIAIS','GUARANI COMERCIO','COMERCIAL SERRA'], cat: 'MATERIAIS_MELHORIAS' },
  { kw: ['SHOPEE','AMAZON SERVICOS','MAGAZINE LUIZA','MERCADO LIVRE'], cat: 'COMPRAS_ONLINE' },
];

// Payees to completely SKIP (owner transfers / washes)
const SKIP_PAYEES = ['STHEFANE LOURDES','WISE BRASIL','ANDRE LUIZ DE SOUZA','JOAQUIM PAULO'];

function categorize(payee, amount = 0) {
  const n = normalize(payee);
  // Jack Souza (Jacqueline Paula) — categorize by amount range:
  //   R$130–R$139 → GAS_COMBUSTIVEL (botijão gás sauna/fogão; histórico — agora elétrico)
  //   R$150–R$350 → SERVICOS_LIMPEZA (limpeza regular)
  //   Resto       → OUTROS (outros serviços/compras menores)
  if (n.includes('JACQUELINE PAULA')) {
    if (amount >= 130 && amount <= 139) return 'GAS_COMBUSTIVEL';
    if (amount >= 150 && amount <= 350) return 'SERVICOS_LIMPEZA';
    return 'OUTROS';
  }
  for (const rule of RULES) {
    if (rule.kw.some(k => n.includes(normalize(k)))) return rule.cat;
  }
  return 'A_CLASSIFICAR';
}

// ── DIRECT BOOKINGS (from WhatsApp history) ───────────────────────────────────
const DIRECT_BOOKINGS = [
  { guest: 'Fernando Henrique',  checkIn: '2023-12-22', checkOut: '2023-12-26', nights: 4, guests: 14, tier: 'PEAK'     },
  { guest: 'Mauricio',           checkIn: '2024-01-02', checkOut: '2024-01-06', nights: 4, guests: 12, tier: 'PEAK'     },
  { guest: 'Taíssa',             checkIn: '2024-01-06', checkOut: '2024-01-08', nights: 2, guests: 10, tier: 'PEAK'     },
  { guest: 'Marco Túlio',        checkIn: '2024-02-10', checkOut: '2024-02-12', nights: 2, guests: 10, tier: 'MID'      },
  { guest: 'Rafael Brandão',     checkIn: '2024-02-29', checkOut: '2024-03-04', nights: 4, guests: 14, tier: 'PEAK'     },
  { guest: 'Luanda Pimenta',     checkIn: '2024-03-08', checkOut: '2024-03-10', nights: 2, guests: 8,  tier: 'MID'      },
  { guest: 'Léo',                checkIn: '2024-04-20', checkOut: '2024-04-22', nights: 2, guests: 10, tier: 'PEAK'     },
  { guest: 'Henrique Maciel',    checkIn: '2024-05-25', checkOut: '2024-05-27', nights: 2, guests: 12, tier: 'MID'      },
  { guest: 'Douglas',            checkIn: '2024-06-07', checkOut: '2024-06-09', nights: 2, guests: 8,  tier: 'LOW'      },
  { guest: 'Patricia Lima',      checkIn: '2024-06-29', checkOut: '2024-07-01', nights: 2, guests: 10, tier: 'HIGH_MID' },
  { guest: 'Família Faria',      checkIn: '2024-07-06', checkOut: '2024-07-08', nights: 2, guests: 12, tier: 'PEAK'     },
  { guest: 'Andréia',            checkIn: '2024-07-27', checkOut: '2024-07-29', nights: 2, guests: 8,  tier: 'PEAK'     },
  { guest: 'Brunno',             checkIn: '2024-08-10', checkOut: '2024-08-12', nights: 2, guests: 10, tier: 'LOW'      },
  { guest: 'Vilma',              checkIn: '2024-08-31', checkOut: '2024-09-02', nights: 2, guests: 8,  tier: 'LOW'      },
  { guest: 'Alexandre',          checkIn: '2024-09-14', checkOut: '2024-09-16', nights: 2, guests: 10, tier: 'LOW'      },
  { guest: 'Tiago',              checkIn: '2024-09-28', checkOut: '2024-09-30', nights: 2, guests: 12, tier: 'LOW'      },
  { guest: 'Renata Oliveira',    checkIn: '2024-10-12', checkOut: '2024-10-14', nights: 2, guests: 10, tier: 'LOW'      },
  { guest: 'Geraldo',            checkIn: '2024-11-16', checkOut: '2024-11-18', nights: 2, guests: 8,  tier: 'LOW'      },
  { guest: 'Lucas',              checkIn: '2024-12-21', checkOut: '2024-12-25', nights: 4, guests: 14, tier: 'PEAK'     },
  { guest: 'Bruna',              checkIn: '2025-01-04', checkOut: '2025-01-06', nights: 2, guests: 10, tier: 'PEAK'     },
  { guest: 'Vanessa',            checkIn: '2025-02-08', checkOut: '2025-02-10', nights: 2, guests: 8,  tier: 'MID'      },
  { guest: 'Camila Nunes',       checkIn: '2025-03-08', checkOut: '2025-03-10', nights: 2, guests: 12, tier: 'HIGH_MID' },
  { guest: 'Fábio',              checkIn: '2025-04-18', checkOut: '2025-04-21', nights: 3, guests: 14, tier: 'PEAK'     },
  { guest: 'Márcia',             checkIn: '2025-05-24', checkOut: '2025-05-26', nights: 2, guests: 10, tier: 'LOW'      },
  { guest: 'Rodrigo',            checkIn: '2025-06-14', checkOut: '2025-06-16', nights: 2, guests: 8,  tier: 'LOW'      },
  { guest: 'Daniela',            checkIn: '2025-07-05', checkOut: '2025-07-07', nights: 2, guests: 12, tier: 'PEAK'     },
  { guest: 'Igor',               checkIn: '2025-08-09', checkOut: '2025-08-11', nights: 2, guests: 10, tier: 'LOW'      },
  { guest: 'Gisele',             checkIn: '2025-09-20', checkOut: '2025-09-22', nights: 2, guests: 8,  tier: 'LOW'      },
  { guest: 'Carlos Eduardo',     checkIn: '2025-11-29', checkOut: '2025-12-01', nights: 2, guests: 12, tier: 'LOW'      },
  { guest: 'Fernanda e amigas',  checkIn: '2025-12-20', checkOut: '2025-12-23', nights: 3, guests: 10, tier: 'PEAK'     },
];

// 2024 baseline rates (used for historical imports, kept for accuracy)
// Current Airbnb dynamic range: R$770–R$1.500/noite (updated 2025)
// 2025+ direct bookings should use: LOW=770, MID=950, HIGH_MID=1150, PEAK=1500
const TIER_PRICES = { LOW: 720, MID: 850, HIGH_MID: 1050, PEAK: 1300 };
const BASE_GUESTS = 11;
const EXTRA_GUEST_FEE = 50;
const CLEANING_FEE = 270;

function calcTotal(tier, nights, guests) {
  const base = TIER_PRICES[tier] * nights;
  const extra = Math.max(0, guests - BASE_GUESTS) * EXTRA_GUEST_FEE * nights;
  return base + extra + CLEANING_FEE;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== import-financeiro.js ===\n');

  // ── 0. Resolve property IDs ──────────────────────────────────────────────
  // Use the property with most bookings (primary RDI) — slug is 'recanto-dos-ipes'
  const rdi = await prisma.property.findFirst({
    where: { slug: { in: ['recanto-dos-ipes', 'sitio-recanto-dos-ipes', 'sitio'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (!rdi) throw new Error('RDI property not found. Check slug in DB.');
  console.log(`RDI property: ${rdi.id} (${rdi.name}) slug=${rdi.slug}`);

  // CDS property (Cabanas da Serra) — find or create
  let cds = await prisma.property.findFirst({
    where: { slug: { in: ['cabanas-da-serra', 'cabanas', 'cds'] } },
  });
  if (!cds) {
    cds = await prisma.property.create({
      data: { name: 'Cabanas da Serra', slug: 'cabanas-da-serra', type: 'CABANA_COMPLEX' }
    });
    console.log(`CDS property created: ${cds.id}`);
  } else {
    console.log(`CDS property: ${cds.id} (${cds.name}) slug=${cds.slug}`);
  }

  // ── 1. Bank CSV → Expense records ────────────────────────────────────────
  console.log('\n[1] Importing bank statement...');
  const bankRows = parseCSV(BANK_CSV);

  const expenses = [];
  const categoryCounts = {};
  let skipped = 0;

  for (const row of bankRows) {
    const type   = normalize(row['Tipo Transação'] || '');
    const payee  = row['Identificação'] || '';
    const nPayee = normalize(payee);

    // Skip CRÉDITO rows entirely (normalize strips accents: DÉBITO → DEBITO)
    if (type !== 'DEBITO') continue;

    // Skip owner/wash payees
    if (SKIP_PAYEES.some(s => nPayee.includes(normalize(s)))) {
      skipped++;
      continue;
    }

    const dateStr = row['Data'];
    const amount  = Math.abs(parseFloat(row['Valor'].replace(',', '.')));
    if (isNaN(amount) || amount === 0) continue;

    const cat = categorize(payee, amount);
    const bankRef = `${dateStr}|${nPayee}|${amount}`;

    // Determine which property: CDS for Breno
    const propId = cat === 'DESIGN_ARQUITETURA' ? cds.id : rdi.id;

    expenses.push({
      propertyId:  propId,
      date:        parseBRDate(dateStr),
      amount,
      category:    cat,
      description: row['Transação'] || 'Importado',
      payee,
      source:      'BANK_IMPORT',
      bankRef,
    });

    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }

  // Upsert by bankRef to avoid duplicates
  let expCreated = 0, expSkipped = 0;
  for (const exp of expenses) {
    const exists = await prisma.expense.findUnique({ where: { bankRef: exp.bankRef } });
    if (exists) { expSkipped++; continue; }
    await prisma.expense.create({ data: exp });
    expCreated++;
  }

  console.log(`  Created: ${expCreated} | Dupes skipped: ${expSkipped} | Owner txns skipped: ${skipped}`);
  console.log('  By category:', categoryCounts);

  // ── 2. Airbnb CSV → Booking records ──────────────────────────────────────
  console.log('\n[2] Importing Airbnb bookings...');
  const airbnbRows = parseCSV(AIRBNB_CSV);
  const reservations = airbnbRows.filter(r => r['Type'] === 'Reservation');

  let abCreated = 0, abSkipped = 0;
  for (const r of reservations) {
    const code = r['Confirmation code'];
    if (!code) continue;

    const exists = await prisma.booking.findUnique({ where: { externalId: code } });
    if (exists) { abSkipped++; continue; }

    // Amount = actual payout deposited to bank (bank-verified for every booking)
    // Gross earnings is pre-fee (~4.578% higher) — do NOT use for revenue
    const amountStr = r['Amount'];
    const amount = amountStr ? parseFloat(amountStr) : 0;
    const grossStr = r['Gross earnings'];
    const gross = grossStr ? parseFloat(grossStr) : 0;
    const feeStr = r['Service fee'];
    const fee = feeStr ? parseFloat(feeStr) : 0;
    const cleaningStr = r['Cleaning fee'];
    const cleaning = cleaningStr ? parseFloat(cleaningStr) : 0;
    const nights = parseInt(r['Nights']) || 1;
    // baseRate = (amount already net of host fee, subtract cleaning to get room rate)
    const baseRate = nights > 0 ? parseFloat(((amount - cleaning) / nights).toFixed(2)) : 0;

    await prisma.booking.create({
      data: {
        propertyId:       rdi.id,
        guestName:        r['Guest'] || 'Hóspede Airbnb',
        guestEmail:       `${code.toLowerCase()}@airbnb.import`,
        guestPhone:       `airbnb-${code}`,
        checkIn:          parseUSDate(r['Start date']),
        checkOut:         parseUSDate(r['End date']),
        nights,
        guestCount:       1,
        baseRatePerNight: baseRate,
        extraGuestFee:    0,
        petFee:           0,
        totalAmount:      amount,
        status:           'CONFIRMED',
        source:           'AIRBNB',
        externalId:       code,
        notes:            `Gross: R$${gross.toFixed(2)}${fee ? `. Taxa host: R$${fee.toFixed(2)}` : ''}`,
      }
    });
    abCreated++;
  }

  console.log(`  Created: ${abCreated} | Dupes skipped: ${abSkipped}`);

  // ── 2b. Booking.com invoices → Booking records ───────────────────────────
  // Each invoice = 1 aggregate Booking record (net payout as totalAmount, consistent with Airbnb)
  // Invoice data verified against bank CRÉDITO entries. Commission = exactly 13% on all invoices.
  // Apr 2025 and May 2025 have no matching bank entry (possibly deferred/combined payout) but
  // room sales documented in invoices are real.
  console.log('\n[2b] Importing Booking.com invoices...');

  // Monthly aggregate invoices (totalAmount = net after 13% commission = actual bank payout)
  const BCOM_INVOICES = [
    { invoiceId: '19218253', period: '2024-08', checkIn: '2024-08-01', checkOut: '2024-08-31', roomSales: 1377.00, commission: 179.01, net: 1197.99 },
    { invoiceId: '19265543', period: '2024-09', checkIn: '2024-09-01', checkOut: '2024-09-30', roomSales: 1591.20, commission: 206.86, net: 1384.34 },
    { invoiceId: '19418698', period: '2024-11', checkIn: '2024-11-01', checkOut: '2024-11-30', roomSales: 1407.60, commission: 182.99, net: 1224.61 },
    { invoiceId: '19579121', period: '2025-01', checkIn: '2025-01-01', checkOut: '2025-01-31', roomSales: 2845.80, commission: 369.95, net: 2475.85 },
    { invoiceId: '19663917', period: '2025-02', checkIn: '2025-02-01', checkOut: '2025-02-28', roomSales: 1354.06, commission: 176.03, net: 1178.03 },
    { invoiceId: '19750621', period: '2025-03', checkIn: '2025-03-01', checkOut: '2025-03-31', roomSales: 1089.36, commission: 141.62, net:  947.74 },
    { invoiceId: '19835038', period: '2025-04', checkIn: '2025-04-01', checkOut: '2025-04-30', roomSales: 2946.78, commission: 383.08, net: 2563.70 },
    { invoiceId: '19911676', period: '2025-05', checkIn: '2025-05-01', checkOut: '2025-05-31', roomSales: 3832.66, commission: 498.25, net: 3334.41 },
    { invoiceId: '19983589', period: '2025-06', checkIn: '2025-06-01', checkOut: '2025-06-30', roomSales: 2269.50, commission: 295.04, net: 1974.46 },
    { invoiceId: '20128683', period: '2025-08', checkIn: '2025-08-01', checkOut: '2025-08-31', roomSales: 1211.76, commission: 157.53, net: 1054.23 },
    { invoiceId: '20230644', period: '2025-09', checkIn: '2025-09-01', checkOut: '2025-09-30', roomSales: 3326.40, commission: 432.43, net: 2893.97 },
    { invoiceId: '20285055', period: '2025-10', checkIn: '2025-10-01', checkOut: '2025-10-31', roomSales: 1888.12, commission: 245.46, net: 1642.66 },
    { invoiceId: '20367297', period: '2025-11', checkIn: '2025-11-01', checkOut: '2025-11-30', roomSales: 1300.50, commission: 169.07, net: 1131.43 },
  ];

  // Individual booking from Mar 2026 payout summary (Rodrigo Castro Vilela)
  const BCOM_INDIVIDUAL = [
    { externalId: 'bcom-6413085515', guestName: 'Rodrigo Castro Vilela', checkIn: '2026-01-30', checkOut: '2026-02-01', nights: 2, roomSales: 1501.50, commission: 195.20, net: 1306.30 },
  ];

  let bcomCreated = 0, bcomSkipped = 0;

  for (const inv of BCOM_INVOICES) {
    const extId = `bcom-inv-${inv.invoiceId}`;
    const exists = await prisma.booking.findUnique({ where: { externalId: extId } });
    if (exists) { bcomSkipped++; continue; }

    await prisma.booking.create({
      data: {
        propertyId:       rdi.id,
        guestName:        `Hóspedes Booking.com - ${inv.period}`,
        guestEmail:       `${extId}@booking.import`,
        guestPhone:       extId,
        checkIn:          new Date(`${inv.checkIn}T00:00:00Z`),
        checkOut:         new Date(`${inv.checkOut}T23:59:59Z`),
        nights:           0, // aggregate — multiple bookings within the month
        guestCount:       1,
        baseRatePerNight: 0,
        extraGuestFee:    0,
        petFee:           0,
        totalAmount:      inv.net,
        status:           'CONFIRMED',
        source:           'BOOKING_COM',
        externalId:       extId,
        notes:            `Fatura Booking.com ${inv.period}. Vendas: R$${inv.roomSales.toFixed(2)}. Comissão 13%: R$${inv.commission.toFixed(2)}. Líquido: R$${inv.net.toFixed(2)}.`,
      }
    });
    bcomCreated++;
  }

  for (const b of BCOM_INDIVIDUAL) {
    const exists = await prisma.booking.findUnique({ where: { externalId: b.externalId } });
    if (exists) { bcomSkipped++; continue; }

    await prisma.booking.create({
      data: {
        propertyId:       rdi.id,
        guestName:        b.guestName,
        guestEmail:       `${b.externalId}@booking.import`,
        guestPhone:       b.externalId,
        checkIn:          new Date(`${b.checkIn}T00:00:00Z`),
        checkOut:         new Date(`${b.checkOut}T23:59:59Z`),
        nights:           b.nights,
        guestCount:       1,
        baseRatePerNight: parseFloat((b.net / b.nights).toFixed(2)),
        extraGuestFee:    0,
        petFee:           0,
        totalAmount:      b.net,
        status:           'CONFIRMED',
        source:           'BOOKING_COM',
        externalId:       b.externalId,
        notes:            `Booking.com ref#${b.externalId.replace('bcom-','')}. Vendas: R$${b.roomSales.toFixed(2)}. Comissão 13%: R$${b.commission.toFixed(2)}.`,
      }
    });
    bcomCreated++;
  }

  console.log(`  Created: ${bcomCreated} | Dupes skipped: ${bcomSkipped}`);

  // ── 3. Direct bookings (WhatsApp history) ────────────────────────────────
  console.log('\n[3] Importing direct bookings (WhatsApp history)...');
  let dirCreated = 0, dirSkipped = 0;

  for (const b of DIRECT_BOOKINGS) {
    const extId = `direct-${normalize(b.guest).replace(/\s+/g,'-')}-${b.checkIn}`;
    const exists = await prisma.booking.findUnique({ where: { externalId: extId } });
    if (exists) { dirSkipped++; continue; }

    const total   = calcTotal(b.tier, b.nights, b.guests);
    const base    = TIER_PRICES[b.tier];
    const extra   = Math.max(0, b.guests - BASE_GUESTS) * EXTRA_GUEST_FEE;

    await prisma.booking.create({
      data: {
        propertyId:       rdi.id,
        guestName:        b.guest,
        guestEmail:       `direct-${normalize(b.guest).toLowerCase().replace(/\s+/g,'.')}-${b.checkIn}@whatsapp.import`,
        guestPhone:       `direct-${b.checkIn}`,
        checkIn:          new Date(`${b.checkIn}T00:00:00Z`),
        checkOut:         new Date(`${b.checkOut}T00:00:00Z`),
        nights:           b.nights,
        guestCount:       b.guests,
        baseRatePerNight: base,
        extraGuestFee:    extra * b.nights,
        petFee:           0,
        totalAmount:      total,
        status:           'CONFIRMED',
        source:           'DIRECT',
        externalId:       extId,
        notes:            `Reserva direta via WhatsApp. Tier: ${b.tier}`,
      }
    });
    dirCreated++;
  }

  console.log(`  Created: ${dirCreated} | Dupes skipped: ${dirSkipped}`);

  // ── 4. Re-categorize existing Jack Souza expenses by amount ──────────────
  console.log('\n[4] Fixing Jack Souza (Jacqueline) expense categories by amount...');
  const jackRows = await prisma.expense.findMany({
    where: { propertyId: rdi.id, payee: { contains: 'Jacqueline', mode: 'insensitive' } },
    select: { id: true, amount: true, category: true },
  });
  let jackFixed = 0, jackSame = 0;
  for (const exp of jackRows) {
    const amt = parseFloat(String(exp.amount));
    let correct;
    if (amt >= 130 && amt <= 139) correct = 'GAS_COMBUSTIVEL';       // botijão gás sauna/fogão
    else if (amt >= 150 && amt <= 350) correct = 'SERVICOS_LIMPEZA'; // limpeza regular
    else correct = 'OUTROS';                                           // outros serviços
    if (exp.category !== correct) {
      await prisma.expense.update({ where: { id: exp.id }, data: { category: correct } });
      jackFixed++;
    } else {
      jackSame++;
    }
  }
  console.log(`  Fixed: ${jackFixed} | Unchanged: ${jackSame} | Total Jack rows: ${jackRows.length}`);

  // ── 5. Fix existing Airbnb bookings: update totalAmount to CSV Amount ────
  // Previously imported using Gross earnings (~4.578% inflated vs actual payout).
  // Now correct to Amount = exact bank deposit (verified for all 57 reservations).
  console.log('\n[5] Correcting Airbnb booking amounts to bank-verified CSV Amount...');

  // Build map: confirmationCode → Amount from CSV
  const airbnbAmountMap = {};
  for (const r of reservations) {
    const code = r['Confirmation code'];
    if (code && r['Amount']) {
      airbnbAmountMap[code] = parseFloat(r['Amount']);
    }
  }

  const existingAirbnb = await prisma.booking.findMany({
    where: { propertyId: rdi.id, source: 'AIRBNB' },
    select: { id: true, externalId: true, totalAmount: true },
  });

  let airFixedCount = 0, airAlreadyOk = 0, airNotInCsv = 0;
  for (const b of existingAirbnb) {
    const correct = airbnbAmountMap[b.externalId];
    if (correct === undefined) { airNotInCsv++; continue; }
    const current = parseFloat(String(b.totalAmount));
    if (Math.abs(current - correct) < 0.01) { airAlreadyOk++; continue; }
    await prisma.booking.update({
      where: { id: b.id },
      data: { totalAmount: correct },
    });
    airFixedCount++;
    console.log(`    Updated ${b.externalId}: ${current.toFixed(2)} → ${correct.toFixed(2)}`);
  }

  console.log(`  Fixed: ${airFixedCount} | Already correct: ${airAlreadyOk} | Not in CSV: ${airNotInCsv}`);

  // ── 6. Cleanup test / duplicate data ─────────────────────────────────────
  console.log('\n[6] Removing test bookings and duplicate property data...');

  // Delete bookings where guestName contains "teste" (case-insensitive)
  const testByName = await prisma.booking.findMany({
    where: { guestName: { contains: 'teste', mode: 'insensitive' } },
    select: { id: true, guestName: true, totalAmount: true },
  });
  for (const b of testByName) {
    console.log(`    Deleting test booking: "${b.guestName}" R$${parseFloat(String(b.totalAmount)).toFixed(2)}`);
    // Must delete FK-dependent BookingGuest records first
    await prisma.bookingGuest.deleteMany({ where: { bookingId: b.id } });
    await prisma.booking.delete({ where: { id: b.id } });
  }

  // Delete all bookings on the duplicate "sitio" property (test/stale data)
  const dupeProp = await prisma.property.findFirst({
    where: { slug: 'sitio' },
    select: { id: true, name: true },
  });
  if (dupeProp) {
    const dupeBookings = await prisma.booking.findMany({
      where: { propertyId: dupeProp.id },
      select: { id: true, guestName: true, totalAmount: true },
    });
    for (const b of dupeBookings) {
      console.log(`    Deleting dupe-property booking: "${b.guestName}" R$${parseFloat(String(b.totalAmount)).toFixed(2)}`);
      await prisma.bookingGuest.deleteMany({ where: { bookingId: b.id } });
      await prisma.booking.delete({ where: { id: b.id } });
    }
    if (dupeBookings.length === 0) console.log('    No bookings on dupe "sitio" property.');
  } else {
    console.log('    No "sitio" duplicate property found — skipping.');
  }

  console.log(`  Test bookings removed: ${testByName.length}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalExp  = await prisma.expense.count({ where: { propertyId: rdi.id } });
  const totalCDS  = await prisma.expense.count({ where: { propertyId: cds.id } });
  const totalBook = await prisma.booking.count({ where: { propertyId: rdi.id } });

  const bySource = await prisma.booking.groupBy({
    by: ['source'],
    where: { propertyId: rdi.id },
    _count: { id: true },
    _sum: { totalAmount: true },
  });

  console.log('\n=== FINAL COUNTS ===');
  console.log(`RDI Expenses: ${totalExp}`);
  console.log(`CDS Expenses: ${totalCDS}`);
  console.log(`RDI Bookings: ${totalBook}`);
  console.log('By source:');
  for (const s of bySource) {
    const total = parseFloat(String(s._sum.totalAmount || 0));
    console.log(`  ${s.source}: ${s._count.id} bookings, R$${total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  }
  console.log('\nDone.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
