'use strict';

/**
 * READ-ONLY thorough audit — builds every plausible duplicate/upsell pair
 * in the Booking table, regardless of whether the legacy `upsell-` tag was
 * applied. Uses several signal families and rates each candidate pair
 * with a 0–100 confidence score so the admin can review before merging.
 *
 * Reports:
 *   1) Orphans — NULL or inactive propertyId
 *   2) RDI legacy — stuck on inactive 'sitio' slug
 *   3) Duplicate candidates — grouped HIGH / MEDIUM / LOW confidence
 *   4) Triplets+ — any guest-cluster of 3+ overlapping bookings for same stay
 *
 * Detection signals (each adds points to the confidence score):
 *   +30  phone match (E.164 normalized)
 *   +25  email match (lowercased)
 *   +20  exact checkIn + checkOut date match
 *   +15  date ranges overlap ≥ 1 night
 *   +15  first-4 chars of normalized name match (handles "Lina" vs "Lina Silva")
 *   +10  Levenshtein ≤ 3 on accent-stripped full name
 *   +10  externalId starts with "upsell-"
 *   +10  source pattern OTA + DIRECT
 *   -30  different source category AND no guest-identity signal matched
 *   -20  non-overlapping nights (probably a repeat guest, not a duplicate)
 *
 * Threshold: ≥ 60 = HIGH (safe to auto-merge), 40–59 = MEDIUM (admin review),
 *            25–39 = LOW (informational), < 25 = filtered out.
 *
 * NEVER mutates the DB.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../lib/db');

const OUT_DIR = '/tmp';

// ── Text helpers ─────────────────────────────────────────────────────────────
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeName(s) {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function normalizePhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (!d) return '';
  // Ignore country code differences — last 10 digits is our canonical key.
  return d.slice(-10);
}
function normalizeEmail(e) {
  return String(e || '').toLowerCase().trim();
}
function editDistance(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1), curr = new Array(b.length + 1);
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
function nightsOverlap(a, b) {
  const aIn = new Date(a.checkIn).getTime();
  const aOut = new Date(a.checkOut).getTime();
  const bIn = new Date(b.checkIn).getTime();
  const bOut = new Date(b.checkOut).getTime();
  const start = Math.max(aIn, bIn);
  const end = Math.min(aOut, bOut);
  return Math.max(0, Math.floor((end - start) / (24 * 60 * 60 * 1000)));
}
function ymd(d) { return d?.toISOString?.().slice(0, 10); }

// ── Pair scoring ─────────────────────────────────────────────────────────────
function scorePair(a, b) {
  const reasons = [];
  let score = 0;

  // identity signals
  const phoneA = normalizePhone(a.guestPhone);
  const phoneB = normalizePhone(b.guestPhone);
  const phoneMatch = phoneA && phoneB && phoneA === phoneB;
  if (phoneMatch) { score += 30; reasons.push('phone match'); }

  const emailA = normalizeEmail(a.guestEmail);
  const emailB = normalizeEmail(b.guestEmail);
  const emailMatch = emailA && emailB && emailA === emailB;
  if (emailMatch) { score += 25; reasons.push('email match'); }

  // date signals
  const sameDates = ymd(a.checkIn) === ymd(b.checkIn) && ymd(a.checkOut) === ymd(b.checkOut);
  if (sameDates) { score += 20; reasons.push('exact same dates'); }
  const overlapN = nightsOverlap(a, b);
  if (overlapN >= 1 && !sameDates) { score += 15; reasons.push(`${overlapN} nights overlap`); }
  if (overlapN === 0) { score -= 20; reasons.push('no overlap — probably repeat guest'); }

  // name signals
  const nameA = normalizeName(a.guestName);
  const nameB = normalizeName(b.guestName);
  if (nameA && nameB) {
    const first4A = nameA.slice(0, 4);
    const first4B = nameB.slice(0, 4);
    if (first4A === first4B) { score += 15; reasons.push(`name first-4 match (${first4A})`); }
    const dist = editDistance(nameA, nameB);
    if (dist <= 3 && first4A !== first4B) { score += 10; reasons.push(`name fuzzy (edit=${dist})`); }
  }

  // channel pattern
  const aIsOTA = a.source === 'AIRBNB' || a.source === 'BOOKING_COM';
  const bIsOTA = b.source === 'AIRBNB' || b.source === 'BOOKING_COM';
  const aIsDirect = a.source === 'DIRECT';
  const bIsDirect = b.source === 'DIRECT';
  const isOtaDirect = (aIsOTA && bIsDirect) || (aIsDirect && bIsOTA);
  if (isOtaDirect) { score += 10; reasons.push('OTA+DIRECT'); }
  // cross-OTA duplicate (Airbnb + Booking.com for the same stay)
  if (aIsOTA && bIsOTA && a.source !== b.source) { score += 5; reasons.push('cross-OTA'); }

  // upsell legacy tag
  const aUpsell = typeof a.externalId === 'string' && a.externalId.startsWith('upsell-');
  const bUpsell = typeof b.externalId === 'string' && b.externalId.startsWith('upsell-');
  if (aUpsell || bUpsell) { score += 10; reasons.push('externalId upsell- tag'); }

  // penalty: different source categories AND no identity match → probably unrelated
  if (a.source !== b.source && !phoneMatch && !emailMatch && !sameDates && overlapN < 1) {
    score -= 30;
    reasons.push('different sources, no identity signal');
  }

  return { score, reasons };
}

async function main() {
  const [properties, bookings] = await Promise.all([
    prisma.property.findMany({ select: { id: true, slug: true, name: true, active: true } }),
    prisma.booking.findMany({
      select: {
        id: true, propertyId: true, guestName: true, guestPhone: true, guestEmail: true,
        checkIn: true, checkOut: true, nights: true, source: true, status: true,
        totalAmount: true, externalId: true, notes: true, createdAt: true,
        isInvoiceAggregate: true,
      },
      orderBy: { checkIn: 'asc' },
    }),
  ]);

  const propertyMap = new Map(properties.map(p => [p.id, p]));
  const rdiProperty = properties.find(p => p.slug === 'recanto-dos-ipes' && p.active);
  const cdsProperty = properties.find(p => p.slug === 'cabanas-da-serra' && p.active);

  // ── 1) Orphans + RDI legacy ────────────────────────────────────────────────
  const orphans = [];
  const rdiLegacy = [];
  for (const b of bookings) {
    if (!b.propertyId) { orphans.push({ ...b, reason: 'propertyId NULL' }); continue; }
    const prop = propertyMap.get(b.propertyId);
    if (!prop) { orphans.push({ ...b, reason: `propertyId ${b.propertyId} not in Property table` }); continue; }
    if (prop.slug === 'sitio' && !prop.active) { rdiLegacy.push({ ...b, slug: prop.slug }); continue; }
    if (!prop.active) orphans.push({ ...b, reason: `property ${prop.slug} inactive` });
  }

  // ── 2) All-pairs scoring ──────────────────────────────────────────────────
  const nonAggregate = bookings.filter(b => !b.isInvoiceAggregate);
  const candidates = [];
  for (let i = 0; i < nonAggregate.length; i++) {
    for (let j = i + 1; j < nonAggregate.length; j++) {
      const a = nonAggregate[i];
      const b = nonAggregate[j];
      const { score, reasons } = scorePair(a, b);
      if (score < 25) continue;

      // Pick canonical "keep" = OTA if exactly one is OTA, otherwise older
      // booking by createdAt (the OTA usually came first in practice).
      const aIsOTA = a.source === 'AIRBNB' || a.source === 'BOOKING_COM';
      const bIsOTA = b.source === 'AIRBNB' || b.source === 'BOOKING_COM';
      let keep, merge;
      if (aIsOTA && !bIsOTA) { keep = a; merge = b; }
      else if (bIsOTA && !aIsOTA) { keep = b; merge = a; }
      else if (a.createdAt <= b.createdAt) { keep = a; merge = b; }
      else { keep = b; merge = a; }

      candidates.push({
        score,
        confidence: score >= 60 ? 'HIGH' : (score >= 40 ? 'MEDIUM' : 'LOW'),
        reasons,
        keep_id: keep.id,
        keep_source: keep.source,
        keep_guest: keep.guestName,
        keep_phone: keep.guestPhone,
        keep_email: keep.guestEmail,
        keep_dates: `${ymd(keep.checkIn)} → ${ymd(keep.checkOut)}`,
        keep_amount: keep.totalAmount?.toString?.(),
        merge_id: merge.id,
        merge_source: merge.source,
        merge_guest: merge.guestName,
        merge_phone: merge.guestPhone,
        merge_email: merge.guestEmail,
        merge_dates: `${ymd(merge.checkIn)} → ${ymd(merge.checkOut)}`,
        merge_amount: merge.totalAmount?.toString?.(),
        propertyId: a.propertyId,
        propertySlug: propertyMap.get(a.propertyId)?.slug || null,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  // ── 3) Guest clusters of 3+ (potential triples) ───────────────────────────
  // Group by normalized-name OR phone, find clusters with ≥3 members whose
  // date windows overlap each other.
  const groups = new Map();
  for (const b of nonAggregate) {
    const keys = new Set();
    const name = normalizeName(b.guestName);
    if (name.length >= 4) keys.add('n:' + name.slice(0, 6));
    const phone = normalizePhone(b.guestPhone);
    if (phone) keys.add('p:' + phone);
    const email = normalizeEmail(b.guestEmail);
    if (email) keys.add('e:' + email);
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
  }
  const triples = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    // keep only if any pair inside overlaps
    let anyOverlap = false;
    for (let i = 0; i < list.length && !anyOverlap; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (nightsOverlap(list[i], list[j]) >= 1) { anyOverlap = true; break; }
      }
    }
    if (!anyOverlap) continue;
    triples.push({
      groupKey: key,
      rows: list.map(b => ({
        id: b.id, source: b.source, guestName: b.guestName,
        checkIn: ymd(b.checkIn), checkOut: ymd(b.checkOut),
        totalAmount: b.totalAmount?.toString?.(),
      })),
    });
  }

  // ── Write reports ─────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(OUT_DIR, 'audit-orphans.json'),     JSON.stringify(orphans,    null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'audit-rdi-legacy.json'),  JSON.stringify(rdiLegacy,  null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'audit-candidates.json'),  JSON.stringify(candidates, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'audit-triples.json'),     JSON.stringify(triples,    null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('# Booking data audit (thorough) — 2026-04-20');
  console.log();
  console.log(`Bookings: **${bookings.length}** total, ${nonAggregate.length} non-aggregate pair-scored`);
  console.log(`Properties: ${properties.map(p => `${p.slug}(${p.active ? 'active' : 'inactive'})`).join(', ')}`);
  console.log();

  console.log(`## 1) Orphans — ${orphans.length}`);
  if (orphans.length === 0) { console.log('_None._'); }
  else {
    console.log('| id | guest | checkIn | source | reason |');
    console.log('|---|---|---|---|---|');
    for (const o of orphans) console.log(`| ${o.id.slice(-6)} | ${o.guestName} | ${ymd(o.checkIn)} | ${o.source} | ${o.reason} |`);
  }
  console.log();

  console.log(`## 2) RDI legacy — ${rdiLegacy.length}`);
  if (rdiLegacy.length === 0) { console.log('_None._'); }
  else {
    console.log('| id | guest | checkIn | source |');
    console.log('|---|---|---|---|');
    for (const r of rdiLegacy) console.log(`| ${r.id.slice(-6)} | ${r.guestName} | ${ymd(r.checkIn)} | ${r.source} |`);
  }
  console.log();

  const high   = candidates.filter(c => c.confidence === 'HIGH');
  const medium = candidates.filter(c => c.confidence === 'MEDIUM');
  const low    = candidates.filter(c => c.confidence === 'LOW');

  console.log(`## 3) Duplicate candidates — ${candidates.length} pairs`);
  console.log(`HIGH=${high.length} · MEDIUM=${medium.length} · LOW=${low.length}`);
  console.log();

  console.log(`### HIGH confidence (score ≥ 60) — safe auto-merge`);
  if (!high.length) console.log('_None._');
  else {
    console.log('| # | score | keep | merge | guest | dates | R$ keep | R$ merge | signals |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    high.forEach((c, i) => console.log(
      `| ${i+1} | ${c.score} | \`${c.keep_id.slice(-6)}\` ${c.keep_source} | \`${c.merge_id.slice(-6)}\` ${c.merge_source} | ${c.keep_guest || c.merge_guest} | ${c.keep_dates} / ${c.merge_dates} | ${c.keep_amount} | ${c.merge_amount} | ${c.reasons.join('; ')} |`
    ));
  }
  console.log();

  console.log(`### MEDIUM confidence (40–59) — needs admin review`);
  if (!medium.length) console.log('_None._');
  else {
    console.log('| # | score | keep | merge | guest (keep/merge) | dates | signals |');
    console.log('|---|---|---|---|---|---|---|');
    medium.forEach((c, i) => console.log(
      `| ${i+1} | ${c.score} | \`${c.keep_id.slice(-6)}\` ${c.keep_source} | \`${c.merge_id.slice(-6)}\` ${c.merge_source} | ${c.keep_guest} / ${c.merge_guest} | ${c.keep_dates} / ${c.merge_dates} | ${c.reasons.join('; ')} |`
    ));
  }
  console.log();

  console.log(`### LOW confidence (25–39) — informational only`);
  if (!low.length) console.log('_None._');
  else {
    console.log('| # | score | keep | merge | guest (keep/merge) | dates | signals |');
    console.log('|---|---|---|---|---|---|---|');
    low.forEach((c, i) => console.log(
      `| ${i+1} | ${c.score} | \`${c.keep_id.slice(-6)}\` ${c.keep_source} | \`${c.merge_id.slice(-6)}\` ${c.merge_source} | ${c.keep_guest} / ${c.merge_guest} | ${c.keep_dates} / ${c.merge_dates} | ${c.reasons.join('; ')} |`
    ));
  }
  console.log();

  console.log(`## 4) Guest clusters of 3+ — ${triples.length}`);
  if (!triples.length) console.log('_None — no guest has 3+ overlapping bookings._');
  else {
    for (const t of triples) {
      console.log(`**Cluster \`${t.groupKey}\`:**`);
      for (const r of t.rows) console.log(`  - \`${r.id.slice(-6)}\` ${r.source} · ${r.guestName} · ${r.checkIn} → ${r.checkOut} · R$${r.totalAmount}`);
      console.log();
    }
  }

  console.log(`## Canonical property IDs`);
  console.log(`- RDI: \`${rdiProperty?.id}\` slug=\`${rdiProperty?.slug}\``);
  console.log(`- CDS: \`${cdsProperty?.id}\` slug=\`${cdsProperty?.slug}\``);
  console.log();
  console.log(`JSON reports: ${OUT_DIR}/audit-*.json`);
}

main()
  .catch(err => { console.error('[audit] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
