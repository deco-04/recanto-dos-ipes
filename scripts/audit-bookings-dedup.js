'use strict';

/**
 * READ-ONLY audit of the Booking table to find data-integrity issues before
 * Sprint Q Phase 2 attempts any merges. Produces three reports:
 *
 *   1) ORPHANS — bookings whose propertyId is NULL or points to an inactive
 *      (legacy) property row. These are the "disappeared from RDI" rows.
 *
 *   2) UPSELL_DUPES — pairs of bookings that look like the same reservation
 *      across channels (e.g. one on Airbnb + one direct "upsell"). Detection:
 *        - same propertyId (or both orphan — matched later post-backfill)
 *        - overlapping night range (≥ 1 night of intersection)
 *        - similar guest name (first token + edit distance ≤ 2)
 *        - one source ∈ {AIRBNB, BOOKING_COM}, the other = DIRECT
 *        - OR the DIRECT row's externalId starts with "upsell-" (legacy tag)
 *
 *   3) CDS_LEAK — any booking surfaced via the "CDS proximas" filter whose
 *      propertyId is NOT the canonical CDS property. Tells us why Vinicius
 *      Dalmo appears on the CDS dashboard even though he's RDI.
 *
 * Writes each report as JSON + a markdown summary under /tmp/. Caller can
 * scp / copy them out or cat them in the terminal.
 *
 * Usage (Railway one-off):
 *   railway ssh --service recanto-dos-ipes \
 *     "node scripts/audit-bookings-dedup.js > /tmp/audit-summary.md 2>&1 && cat /tmp/audit-summary.md"
 *
 * NEVER writes to the DB. Safe to re-run.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../lib/db');

const OUT_DIR = '/tmp';

// ── Utility: Levenshtein distance for fuzzy name matching ────────────────────
function editDistance(a, b) {
  a = String(a || '').toLowerCase();
  b = String(b || '').toLowerCase();
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function firstTwoTokens(name) {
  return String(name || '').toLowerCase().trim().split(/\s+/).slice(0, 2).join(' ');
}

function nightsOverlap(a, b) {
  const aIn  = new Date(a.checkIn).getTime();
  const aOut = new Date(a.checkOut).getTime();
  const bIn  = new Date(b.checkIn).getTime();
  const bOut = new Date(b.checkOut).getTime();
  const start = Math.max(aIn, bIn);
  const end   = Math.min(aOut, bOut);
  return Math.max(0, Math.floor((end - start) / (24 * 60 * 60 * 1000)));
}

async function main() {
  const [properties, bookings] = await Promise.all([
    prisma.property.findMany({
      select: { id: true, slug: true, name: true, active: true },
    }),
    prisma.booking.findMany({
      select: {
        id: true,
        propertyId: true,
        guestName: true,
        guestPhone: true,
        guestEmail: true,
        checkIn: true,
        checkOut: true,
        nights: true,
        source: true,
        status: true,
        totalAmount: true,
        externalId: true,
        notes: true,
        createdAt: true,
        isInvoiceAggregate: true,
      },
      orderBy: { checkIn: 'asc' },
    }),
  ]);

  const propertyMap = new Map(properties.map(p => [p.id, p]));
  const cdsProperty = properties.find(p => p.slug === 'cabanas-da-serra' && p.active)
                    || properties.find(p => p.slug === 'cabanas' && p.active);
  const rdiProperty = properties.find(p => p.slug === 'recanto-dos-ipes' && p.active);

  // ── 1) ORPHANS ─────────────────────────────────────────────────────────────
  const orphans = [];
  for (const b of bookings) {
    if (!b.propertyId) {
      orphans.push({ ...b, reason: 'propertyId is NULL' });
      continue;
    }
    const prop = propertyMap.get(b.propertyId);
    if (!prop) {
      orphans.push({ ...b, reason: `propertyId ${b.propertyId} not found in Property table` });
      continue;
    }
    if (!prop.active) {
      orphans.push({ ...b, reason: `property ${prop.slug} is inactive (legacy row)` });
    }
  }

  // ── 2) UPSELL_DUPES ────────────────────────────────────────────────────────
  const dupes = [];
  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i];
      const b = bookings[j];

      // Skip aggregate invoice placeholders
      if (a.isInvoiceAggregate || b.isInvoiceAggregate) continue;

      // Source pattern: one OTA + one DIRECT
      const aIsOTA    = a.source === 'AIRBNB' || a.source === 'BOOKING_COM';
      const bIsOTA    = b.source === 'AIRBNB' || b.source === 'BOOKING_COM';
      const aIsDirect = a.source === 'DIRECT';
      const bIsDirect = b.source === 'DIRECT';
      const isPairPattern = (aIsOTA && bIsDirect) || (aIsDirect && bIsOTA);

      // Legacy convention: upsell-only bookings have externalId like 'upsell-<...>'
      const aUpsellTag = typeof a.externalId === 'string' && a.externalId.startsWith('upsell-');
      const bUpsellTag = typeof b.externalId === 'string' && b.externalId.startsWith('upsell-');

      if (!isPairPattern && !aUpsellTag && !bUpsellTag) continue;

      // Same property (both null counts as "same" for post-backfill grouping)
      if (a.propertyId !== b.propertyId) continue;

      // Overlapping nights
      if (nightsOverlap(a, b) < 1) continue;

      // Fuzzy name match — first two tokens, edit distance ≤ 2
      const nameDist = editDistance(firstTwoTokens(a.guestName), firstTwoTokens(b.guestName));
      if (nameDist > 2) continue;

      const ota    = aIsOTA ? a : (bIsOTA ? b : null);
      const direct = aIsDirect ? a : (bIsDirect ? b : null);
      dupes.push({
        keep_id:       ota ? ota.id : a.id,   // keep the OTA row as the canonical booking
        merge_id:      direct ? direct.id : b.id,
        keep_source:   ota ? ota.source : a.source,
        merge_source:  direct ? direct.source : b.source,
        guestName:     a.guestName,
        checkIn:       a.checkIn?.toISOString?.().slice(0, 10),
        checkOut:      a.checkOut?.toISOString?.().slice(0, 10),
        propertyId:    a.propertyId,
        propertySlug:  propertyMap.get(a.propertyId)?.slug || null,
        keep_amount:   ota?.totalAmount?.toString?.(),
        merge_amount:  direct?.totalAmount?.toString?.(),
        nameDistance:  nameDist,
        reason:        aUpsellTag || bUpsellTag
          ? 'externalId tagged upsell-'
          : 'OTA+DIRECT pattern, overlapping nights, similar name',
      });
    }
  }

  // ── 3) CDS_LEAK ────────────────────────────────────────────────────────────
  // Bookings with propertyId NOT belonging to an active CDS row but whose
  // guestName or notes suggest they'd land on the CDS dashboard. Since
  // there's no channel that hardcodes a CDS-vs-RDI filter in the reservas
  // feed, the canonical check is: which bookings currently have a propertyId
  // that resolves to an inactive "cabanas" row? Those are false CDS reservas.
  const cdsLeak = bookings
    .filter(b => {
      const prop = propertyMap.get(b.propertyId);
      // Leak = booking attributed to an INACTIVE 'cabanas' legacy row, OR
      // propertyId points to something that isn't the canonical CDS but is
      // showing up because of the active:true filter being too loose.
      return prop && prop.slug === 'cabanas' && !prop.active;
    })
    .map(b => ({
      id: b.id,
      guestName: b.guestName,
      checkIn: b.checkIn?.toISOString?.().slice(0, 10),
      source: b.source,
      propertyId: b.propertyId,
      propertySlug: propertyMap.get(b.propertyId)?.slug,
    }));

  // Also flag: any booking assigned to RDI's legacy inactive 'sitio' row.
  const rdiLegacy = bookings
    .filter(b => {
      const prop = propertyMap.get(b.propertyId);
      return prop && prop.slug === 'sitio' && !prop.active;
    })
    .map(b => ({
      id: b.id,
      guestName: b.guestName,
      checkIn: b.checkIn?.toISOString?.().slice(0, 10),
      source: b.source,
      propertyId: b.propertyId,
      propertySlug: propertyMap.get(b.propertyId)?.slug,
    }));

  // ── Write reports ──────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(OUT_DIR, 'audit-orphans.json'),       JSON.stringify(orphans,   null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'audit-upsell-dupes.json'),  JSON.stringify(dupes,     null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'audit-cds-leak.json'),      JSON.stringify(cdsLeak,   null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'audit-rdi-legacy.json'),    JSON.stringify(rdiLegacy, null, 2));

  // Markdown summary (goes to stdout so caller sees it)
  console.log('# Booking data audit — 2026-04-20');
  console.log();
  console.log(`Total bookings: **${bookings.length}**`);
  console.log(`Properties:`);
  for (const p of properties) {
    console.log(`  - ${p.slug} (${p.id}) active=${p.active}`);
  }
  console.log();

  console.log(`## 1) Orphans — ${orphans.length} rows`);
  console.log(`Bookings with NULL propertyId or pointing to an inactive property.`);
  console.log();
  if (orphans.length === 0) {
    console.log('_None._');
  } else {
    console.log('| id | guest | checkIn | source | reason |');
    console.log('|---|---|---|---|---|');
    for (const o of orphans.slice(0, 40)) {
      console.log(`| ${o.id.slice(-6)} | ${o.guestName} | ${o.checkIn?.toISOString?.().slice(0, 10) ?? '?'} | ${o.source} | ${o.reason} |`);
    }
    if (orphans.length > 40) console.log(`| … | _+${orphans.length - 40} more_ | | | |`);
  }
  console.log();

  console.log(`## 2) Upsell-duplicate candidates — ${dupes.length} pairs`);
  console.log(`These pairs look like the same reservation across channels.`);
  console.log(`Recommendation: keep the OTA row, merge DIRECT into it as a BookingUpsell.`);
  console.log();
  if (dupes.length === 0) {
    console.log('_None detected._');
  } else {
    console.log('| keep (OTA) | merge (direct) | guest | dates | keep R$ | merge R$ | reason |');
    console.log('|---|---|---|---|---|---|---|');
    for (const d of dupes) {
      console.log(`| \`${d.keep_id.slice(-6)}\` (${d.keep_source}) | \`${d.merge_id.slice(-6)}\` (${d.merge_source}) | ${d.guestName} | ${d.checkIn} → ${d.checkOut} | ${d.keep_amount} | ${d.merge_amount} | ${d.reason} |`);
    }
  }
  console.log();

  console.log(`## 3) CDS leak — ${cdsLeak.length} bookings`);
  console.log(`Bookings attributed to the inactive legacy 'cabanas' row that still`);
  console.log(`show on the CDS dashboard.`);
  console.log();
  if (cdsLeak.length === 0) {
    console.log('_None — Vinicius Dalmo must be showing for a different reason. Check /financeiro/cds endpoint filter or the dashboard\\'s proximas fetch._');
  } else {
    console.log('| id | guest | checkIn | source |');
    console.log('|---|---|---|---|');
    for (const c of cdsLeak) {
      console.log(`| ${c.id.slice(-6)} | ${c.guestName} | ${c.checkIn} | ${c.source} |`);
    }
  }
  console.log();

  console.log(`## 4) RDI legacy attribution — ${rdiLegacy.length} bookings`);
  console.log(`Bookings stuck on the inactive 'sitio' row instead of the active 'recanto-dos-ipes'.`);
  console.log();
  if (rdiLegacy.length === 0) {
    console.log('_None._');
  } else {
    console.log('| id | guest | checkIn | source |');
    console.log('|---|---|---|---|');
    for (const r of rdiLegacy.slice(0, 30)) {
      console.log(`| ${r.id.slice(-6)} | ${r.guestName} | ${r.checkIn} | ${r.source} |`);
    }
    if (rdiLegacy.length > 30) console.log(`| … | _+${rdiLegacy.length - 30} more_ | | |`);
  }
  console.log();

  console.log(`## Canonical property IDs`);
  console.log(`- RDI (active): \`${rdiProperty?.id}\` slug=\`${rdiProperty?.slug}\``);
  console.log(`- CDS (active): \`${cdsProperty?.id}\` slug=\`${cdsProperty?.slug}\``);
  console.log();
  console.log(`Full JSON reports written to: ${OUT_DIR}/audit-*.json`);
}

main()
  .catch(err => { console.error('[audit] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
