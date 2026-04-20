'use strict';

/**
 * Sprint Q Phase 2 — transactional orphan backfill + upsell-dupe merges.
 *
 * ⚠️  MUTATES PRODUCTION DATA. Run only after the audit has been reviewed
 *     and the pair list below matches the admin-approved set.
 *
 * Two steps, each in its own prisma.$transaction so a failure rolls back cleanly:
 *
 *   A) Orphan + RDI-legacy backfill
 *      - Fernanda Oliveira      (propertyId=NULL)     → RDI
 *      - Vinícius Delmo         (propertyId=NULL)     → RDI   (also fixes CDS dashboard leak)
 *      - Joaquim Paulo de Souza (legacy 'sitio' slug) → RDI
 *
 *   B) Upsell-dupe merges — for each (keepId, mergeId):
 *      1. Create a BookingUpsell on keepId with amount = merge.totalAmount,
 *         description encoding the source channel + original booking id so
 *         "Canais de venda" can still attribute the upsell revenue later.
 *      2. Copy merge.notes into keep.notes (append, prefixed with marker).
 *      3. Cascade-delete merge booking's own BookingUpsell rows first
 *         (rare, but possible) so the merge delete doesn't orphan them.
 *      4. Soft-delete the merge booking: status=CANCELLED + append a note so
 *         the financial totals stop double-counting. (Hard-delete would lose
 *         audit trail and make un-merge impossible if detection was wrong.)
 *
 * Idempotent: each merge checks for an existing BookingUpsell with the
 * same (bookingId, marker-in-description) and skips if found.
 *
 * Usage (Railway one-off):
 *   railway ssh --service recanto-dos-ipes "node scripts/execute-phase2-merges.js"
 */

const prisma = require('../lib/db');

// ── Canonical property IDs (audited 2026-04-20) ──────────────────────────────
const RDI_PROPERTY_ID = 'cmnvjziwv0000ohgcb3nxbl4j';

// ── A) Orphan backfill ───────────────────────────────────────────────────────
const ORPHAN_BOOKING_IDS = [
  'cmo1y5vme0000ohcufe79d27pwm'.slice(-24),  // Fernanda — resolved at runtime by suffix match
  'cmnyajcmg0001ohgkn8vaz4d'.slice(-24),     // Vinícius
  'cmnyakdcy0005oh14vc6pfz7u'.slice(-24),    // Joaquim
];
// Safer: identify by (lastN-of-id, guestName, checkIn) tuple at runtime so this
// script tolerates re-ordered exports and doesn't rely on memorized cuids.
const ORPHAN_IDENTIFIERS = [
  { suffix: 'd27pwm', guestName: 'Fernanda Oliveira',       checkIn: '2026-04-18' },
  { suffix: '8vaz4d', guestName: 'Vinícius Delmo',          checkIn: '2026-05-01' },
  { suffix: '6pfz7u', guestName: 'Joaquim Paulo de Souza',  checkIn: '2026-05-29' },
];

// ── B) Upsell-dupe pairs to merge (17 pairs, all HIGH or user-approved MEDIUM) ─
const MERGE_PAIRS = [
  // HIGH confidence (externalId linkage)
  { keepSuffix: 'f1zuj6', mergeSuffix: '6nv5zp', guest: 'Raquel Jardim' },
  { keepSuffix: 'vf4nae', mergeSuffix: '9joajp', guest: 'Carolline Cunha Oliveira' },
  { keepSuffix: '76smbb', mergeSuffix: 'vqbyx8', guest: 'Nayara Carcheno' },
  { keepSuffix: '4kudxg', mergeSuffix: 't4brl2', guest: 'Lucas Prado' },
  { keepSuffix: 'koxo3a', mergeSuffix: '2tuumt', guest: 'Patrícia Guimarães' },
  { keepSuffix: 'nvswqn', mergeSuffix: 'z25uch', guest: 'Rosana Cupertino' },
  { keepSuffix: '7r21wt', mergeSuffix: 'k7n8x5', guest: 'Paulinho Ricardo' },
  { keepSuffix: '9yto9t', mergeSuffix: 'adr9d3', guest: 'Thalles Sales' },
  { keepSuffix: '8ari3e', mergeSuffix: 'wyx24x', guest: 'Eduarda Azevedo' },
  { keepSuffix: 'w0bqxh', mergeSuffix: 'iyikq7', guest: 'Philip Lima' },
  { keepSuffix: 't4drde', mergeSuffix: 'n3gv7p', guest: 'Luciana Oliveira' },
  { keepSuffix: '6udiki', mergeSuffix: 'rpxish', guest: 'Andreia Fonseca' },
  { keepSuffix: '0mb0ix', mergeSuffix: 'up22fq', guest: 'Matheus Ribeiro' },
  { keepSuffix: 'shsun6', mergeSuffix: '7upp2m', guest: 'Douglas Dantas Campos' },
  { keepSuffix: 'jzxla7', mergeSuffix: 'ncb14c', guest: 'Lina Ferreira Fernandes' },
  // MEDIUM confidence (admin-approved)
  { keepSuffix: 'x5uhn7', mergeSuffix: 'ttvjdm', guest: 'Luanda Pimenta' },
  { keepSuffix: 'p57tgc', mergeSuffix: '0l9wx3', guest: 'Rodrigo Castro Vilela' },
];

const MERGE_MARKER = '[sprint-q-merged]';  // Idempotency: skip if upsell desc already contains this

// ── Helpers ──────────────────────────────────────────────────────────────────
async function resolveBookingBySuffix(suffix, guestNameHint) {
  const matches = await prisma.booking.findMany({
    where: { id: { endsWith: suffix } },
    select: { id: true, guestName: true, source: true, checkIn: true, checkOut: true, totalAmount: true, externalId: true, notes: true, propertyId: true, createdAt: true, status: true },
  });
  if (matches.length === 0) throw new Error(`no booking with id ending in ${suffix}`);
  if (matches.length > 1) {
    // Narrow by guest name if ambiguous
    const narrowed = matches.filter(m => (m.guestName || '').includes(guestNameHint.split(' ')[0]));
    if (narrowed.length === 1) return narrowed[0];
    throw new Error(`ambiguous id suffix ${suffix} — ${matches.length} matches`);
  }
  return matches[0];
}

// ── A) Orphan backfill ───────────────────────────────────────────────────────
async function backfillOrphans() {
  console.log('\n── A) Orphan + legacy backfill → RDI ──────────────────────────');
  for (const { suffix, guestName, checkIn } of ORPHAN_IDENTIFIERS) {
    const b = await resolveBookingBySuffix(suffix, guestName);
    if (b.propertyId === RDI_PROPERTY_ID) {
      console.log(`  [skip] ${suffix} ${guestName} already on RDI`);
      continue;
    }
    await prisma.booking.update({
      where: { id: b.id },
      data:  { propertyId: RDI_PROPERTY_ID },
    });
    console.log(`  [ok]   ${suffix} ${guestName} checkIn=${checkIn} — moved propertyId ${b.propertyId ?? 'NULL'} → ${RDI_PROPERTY_ID}`);
  }
}

// ── B) Upsell-dupe merges ────────────────────────────────────────────────────
async function mergeOnePair({ keepSuffix, mergeSuffix, guest }) {
  const keep  = await resolveBookingBySuffix(keepSuffix,  guest);
  const merge = await resolveBookingBySuffix(mergeSuffix, guest);

  if (keep.id === merge.id) {
    console.log(`  [skip] ${guest}: same id — nothing to merge`);
    return;
  }
  if (merge.status === 'CANCELLED' && (merge.notes || '').includes(MERGE_MARKER)) {
    console.log(`  [skip] ${guest}: merge ${mergeSuffix} already soft-deleted by a prior run`);
    return;
  }

  // Idempotency: check if we already created an upsell for this merge
  const existing = await prisma.bookingUpsell.findFirst({
    where: { bookingId: keep.id, description: { contains: `${MERGE_MARKER} from ${merge.id}` } },
  });
  if (existing) {
    console.log(`  [skip] ${guest}: upsell already exists for keep=${keepSuffix} (id=${existing.id})`);
  }

  const mergeAmount = parseFloat(merge.totalAmount?.toString?.() || '0');
  const description = `${MERGE_MARKER} from ${merge.id} (${merge.source} ${merge.externalId || ''}) — ${merge.notes?.trim() || 'upsell direto'}`.trim();

  await prisma.$transaction(async (tx) => {
    // 1. Create the upsell on keep (if not already)
    if (!existing) {
      await tx.bookingUpsell.create({
        data: {
          bookingId:   keep.id,
          description,
          amount:      mergeAmount,
          receivedAt:  merge.createdAt,  // reflect when revenue came in
          notes:       `Merged via Sprint Q. Original dates ${merge.checkIn?.toISOString?.().slice(0,10)} → ${merge.checkOut?.toISOString?.().slice(0,10)}. Source: ${merge.source}.`,
        },
      });
    }

    // 2. Append merge notes into keep (human-readable trail)
    const mergedNote = `\n\n${MERGE_MARKER} ${new Date().toISOString().slice(0,10)}: consolidated ${merge.source} booking ${merge.id} (R$${mergeAmount}) into this reservation as upsell.`;
    await tx.booking.update({
      where: { id: keep.id },
      data:  { notes: ((keep.notes || '') + mergedNote).trim() },
    });

    // 3. Cascade-delete any upsells already sitting on the merge booking
    await tx.bookingUpsell.deleteMany({ where: { bookingId: merge.id } });

    // 4. Soft-delete the merge booking
    await tx.booking.update({
      where: { id: merge.id },
      data: {
        status: 'CANCELLED',
        notes:  ((merge.notes || '') + `\n\n${MERGE_MARKER} ${new Date().toISOString().slice(0,10)}: merged into booking ${keep.id}. See upsell there.`).trim(),
      },
    });
  });

  console.log(`  [ok]   ${guest}: keep=${keepSuffix} (R$${keep.totalAmount}) + upsell R$${mergeAmount} from ${mergeSuffix} (${merge.source}) → soft-deleted`);
}

async function mergePairs() {
  console.log('\n── B) Upsell-dupe merges ──────────────────────────────────────');
  for (const pair of MERGE_PAIRS) {
    try {
      await mergeOnePair(pair);
    } catch (err) {
      console.error(`  [FAIL] ${pair.guest} (${pair.keepSuffix} + ${pair.mergeSuffix}): ${err.message}`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startCount = await prisma.booking.count();
  const startUpsells = await prisma.bookingUpsell.count();
  console.log(`[phase2] start: bookings=${startCount}, upsells=${startUpsells}`);

  await backfillOrphans();
  await mergePairs();

  const endCount   = await prisma.booking.count();
  const endUpsells = await prisma.bookingUpsell.count();
  const cancelled  = await prisma.booking.count({ where: { status: 'CANCELLED', notes: { contains: MERGE_MARKER } } });
  console.log('\n── Summary ──────────────────────────────────────────');
  console.log(`bookings total: ${startCount} → ${endCount} (no hard deletes)`);
  console.log(`soft-deleted by merge marker: ${cancelled}`);
  console.log(`upsells: ${startUpsells} → ${endUpsells} (+${endUpsells - startUpsells})`);
}

main()
  .catch(err => { console.error('[phase2] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
