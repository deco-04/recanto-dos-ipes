'use strict';

/**
 * Imports the Airbnb host "completed bookings" CSV as ground-truth for
 * per-booking financials. Source file: download from Airbnb host dashboard
 * → Earnings → Export CSV → "All transactions completed".
 *
 * Why this script exists:
 *   - Our iCal feed only carries dates + UID + (sometimes) guest name.
 *   - Cleaning fees, host service fees, real guest names, and actual
 *     payout amounts are NOT in the iCal — they only appear in the CSV.
 *   - Pre-2026-04-30 the SRI database used heuristic numbers from
 *     Property.pricingConfig (cleaning fee R$240ish hardcoded). The user
 *     reported the financial dashboard was inaccurate; this script is
 *     the data half of the fix.
 *
 * Idempotent: matches each CSV row to a Booking by Confirmation code
 * (Airbnb's HMxxxxxx) ↔ Booking.externalId. Re-running with a fresh CSV
 * just refreshes the financial fields with the latest numbers.
 *
 * Usage:
 *   node scripts/import-airbnb-financial-csv.js <path-to-csv>             # dry run
 *   node scripts/import-airbnb-financial-csv.js <path-to-csv> --commit    # write
 *
 * Examples:
 *   node scripts/import-airbnb-financial-csv.js "uploads/Finanças RDI/Relatórios do Recanto dos Ipes/airbnb-completed-all.csv"
 *   node scripts/import-airbnb-financial-csv.js path/to.csv --commit
 *
 * Exit codes:
 *   0 — success (dry-run or committed)
 *   1 — file not found / parse error / DB error
 */

const fs     = require('node:fs');
const path   = require('node:path');
const prisma = require('../lib/db');

// ── CSV parsing ───────────────────────────────────────────────────────────────
// Minimal RFC-4180 parser: handles quoted fields with embedded commas and
// escaped double quotes ("" → "). Sufficient for Airbnb's host CSV export
// which has no multi-line quoted fields. Avoids adding a runtime dep.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++; // skip the escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i] ?? ''; });
    return row;
  });
}

// ── Field coercion ────────────────────────────────────────────────────────────
function toMoney(s) {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(String(s).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toMMDDYYYY(s) {
  // Airbnb exports US date format: 04/02/2026 = 2026-04-02
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00.000Z`);
}

/**
 * Airbnb confirmation codes appear as either:
 *   "HMDA8Z99PP"           in the CSV
 *   "HMDA8Z99PP@airbnb.com" in iCal UIDs (sometimes)
 *
 * Build a list of candidate externalId values for the DB lookup so we
 * match either format.
 */
function externalIdCandidates(confirmationCode) {
  const c = String(confirmationCode || '').trim();
  if (!c) return [];
  return [c, `${c}@airbnb.com`];
}

/**
 * Decide whether to overwrite the DB's current guestName with the CSV's
 * Guest column. We only replace placeholders — never overwrite an admin's
 * manually-corrected name. Airbnb's iCal feed delivers names like
 * "Reservada", "ABNB-XX9YZ", or "Reservado por", which match below.
 */
function looksLikePlaceholder(name) {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (n === '') return true;
  if (/^reservad[oa]/.test(n))  return true;
  if (/^abnb[\s-]/.test(n))     return true;
  if (/^reservation\b/.test(n)) return true;
  if (/^h[a-z0-9]{6,12}$/i.test(n)) return true;  // bare confirmation code as name
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',  chunk => { data += chunk; });
    process.stdin.on('end',   ()    => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args     = process.argv.slice(2);
  const csvPath  = args.find(a => !a.startsWith('--'));
  const commit   = args.includes('--commit');

  if (!csvPath) {
    console.error('Usage:');
    console.error('  node scripts/import-airbnb-financial-csv.js <path-to-csv> [--commit]');
    console.error('  node scripts/import-airbnb-financial-csv.js - [--commit]   # read from stdin');
    process.exit(1);
  }

  // The "-" sentinel reads the CSV from stdin so the importer can run
  // INSIDE a Railway container (where postgres.railway.internal resolves)
  // while the CSV file lives only on the operator's local machine. Pipe:
  //   cat path/to.csv | railway ssh -s recanto-dos-ipes node scripts/import-airbnb-financial-csv.js -
  let text;
  if (csvPath === '-') {
    console.log('[import-airbnb] Reading CSV from stdin…');
    text = await readStdin();
    if (!text) {
      console.error('[import-airbnb] stdin was empty — pipe the CSV file in');
      process.exit(1);
    }
  } else {
    const absCsv = path.resolve(csvPath);
    if (!fs.existsSync(absCsv)) {
      console.error(`[import-airbnb] CSV not found: ${absCsv}`);
      process.exit(1);
    }
    console.log(`[import-airbnb] Reading: ${absCsv}`);
    text = fs.readFileSync(absCsv, 'utf8');
  }
  const rows = parseCsv(text);
  const reservations = rows.filter(r => r.Type === 'Reservation');

  console.log(`[import-airbnb] Parsed ${rows.length} rows · ${reservations.length} are reservations`);
  console.log(`[import-airbnb] Mode: ${commit ? 'COMMIT' : 'DRY RUN — no DB writes'}`);

  let matched = 0;
  let unmatched = 0;
  let updated = 0;
  let nameFixed = 0;
  const unmatchedSample = [];

  for (const r of reservations) {
    const code     = r['Confirmation code'];
    const guestCsv = r['Guest'] || '';
    const cleaning = toMoney(r['Cleaning fee']);
    const hostFee  = toMoney(r['Service fee']);
    const amount   = toMoney(r['Amount']);
    const gross    = toMoney(r['Gross earnings']);

    const candidates = externalIdCandidates(code);
    const booking = await prisma.booking.findFirst({
      where:  { externalId: { in: candidates } },
      select: {
        id: true, externalId: true, guestName: true,
        actualCleaningFee: true, airbnbHostFee: true, actualPayout: true,
      },
    });

    if (!booking) {
      unmatched++;
      if (unmatchedSample.length < 5) {
        unmatchedSample.push({ code, guestCsv, startDate: r['Start date'] });
      }
      continue;
    }
    matched++;

    const updatePayload = {
      actualCleaningFee: cleaning,
      airbnbHostFee:     hostFee,
      actualPayout:      amount,
      // Airbnb's CSV doesn't break out the guest service fee directly, but
      // we can derive it as a residual when needed: guestFee = gross −
      // (amount + hostFee). Many rows will have this be 0 because Airbnb
      // collected the guest fee on top and paid us only host-side numbers.
      // Leave airbnbGuestFee null for now — derivable later from gross
      // when needed for a guest-paid total.
      airbnbReportedAt:  new Date(),
    };

    // Only overwrite guestName when it currently looks like a placeholder.
    // Admin-edited names (real Brazilian guest names) are preserved.
    if (guestCsv && looksLikePlaceholder(booking.guestName)) {
      updatePayload.guestName = guestCsv;
      nameFixed++;
    }

    if (commit) {
      await prisma.booking.update({
        where: { id: booking.id },
        data:  updatePayload,
      });
    }
    updated++;
  }

  console.log('');
  console.log(`[import-airbnb] === Summary ===`);
  console.log(`[import-airbnb]   Reservations in CSV:        ${reservations.length}`);
  console.log(`[import-airbnb]   Matched to DB booking:      ${matched}`);
  console.log(`[import-airbnb]   Updated (or would update):  ${updated}`);
  console.log(`[import-airbnb]   Guest name fixed:           ${nameFixed}`);
  console.log(`[import-airbnb]   Unmatched (no DB row):      ${unmatched}`);
  if (unmatchedSample.length > 0) {
    console.log(`[import-airbnb]   Sample unmatched:`);
    unmatchedSample.forEach(u => {
      console.log(`[import-airbnb]     · ${u.code} · ${u.guestCsv || '(no name)'} · start ${u.startDate}`);
    });
  }
  console.log('');
  if (!commit) {
    console.log(`[import-airbnb] Dry run complete. Re-run with --commit to apply changes.`);
  } else {
    console.log(`[import-airbnb] Done.`);
  }
}

// Run main() only when invoked as a CLI; when imported by tests, expose
// the pure helpers without auto-executing.
if (require.main === module) {
  main()
    .catch(err => {
      console.error('[import-airbnb] FATAL:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  parseCsvLine,
  parseCsv,
  toMoney,
  toMMDDYYYY,
  externalIdCandidates,
  looksLikePlaceholder,
};
