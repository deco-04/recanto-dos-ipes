// Tests for scripts/import-airbnb-financial-csv.js — pure helper functions.
//
// What these pin:
//   - CSV parser handles RFC-4180 quirks (quoted fields w/ commas, escaped quotes)
//   - Money parser tolerates currency symbols, blanks, malformed input
//   - Date parser maps Airbnb's MM/DD/YYYY format to a real Date
//   - externalIdCandidates returns BOTH "HMxxx" and "HMxxx@airbnb.com" so
//     the DB lookup works regardless of which UID format iCal stamped
//   - looksLikePlaceholder detects every real-world OTA placeholder we've
//     seen (Reservada, Reservation, ABNB-XX9YZ, bare HM codes) but does
//     NOT mistake a real guest name for one
//
// The DB-touching half of the importer is exercised end-to-end via the
// production --dry-run mode (no test DB needed for that).

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const __filename      = fileURLToPath(import.meta.url);
const __dirname       = path.dirname(__filename);
const projectRoot     = path.resolve(__dirname, '..');
const requireFromHere = createRequire(import.meta.url);

// Stub Prisma so requiring the script doesn't try to connect.
const ModuleCtor = requireFromHere('module');
function injectFakeCjsModule(absolutePath, fakeExports) {
  const resolved = requireFromHere.resolve(absolutePath);
  const fakeMod  = new ModuleCtor(resolved);
  fakeMod.filename = resolved;
  fakeMod.loaded   = true;
  fakeMod.exports  = fakeExports;
  ModuleCtor._cache[resolved] = fakeMod;
}
injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'), {
  booking: { findFirst: () => null, update: () => {} },
  $disconnect: async () => {},
});

const {
  parseCsvLine, parseCsv, toMoney, toMMDDYYYY,
  externalIdCandidates, looksLikePlaceholder,
} = requireFromHere(path.join(projectRoot, 'scripts/import-airbnb-financial-csv.js'));

describe('parseCsvLine — RFC-4180 quirks', () => {
  it('splits a simple unquoted line', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  it('preserves quoted fields with commas inside', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });
  it('handles escaped double quotes (\"\" → \")', () => {
    expect(parseCsvLine('a,"he said ""hi""",b')).toEqual(['a', 'he said "hi"', 'b']);
  });
  it('keeps trailing empty fields', () => {
    expect(parseCsvLine('a,b,')).toEqual(['a', 'b', '']);
  });
  it('handles a real Airbnb payout row (quoted Details with comma)', () => {
    // Verbatim shape from airbnb-completed-all.csv line 4:
    const line = '04/02/2026,04/09/2026,Payout,,,,,,,,"Transfer to STHEFANE LOURDES DE SOUZA, Ch 0391 (BRL)",ABC,BRL,,3980.13,,,,,,,';
    const fields = parseCsvLine(line);
    expect(fields[0]).toBe('04/02/2026');
    expect(fields[2]).toBe('Payout');
    expect(fields[10]).toBe('Transfer to STHEFANE LOURDES DE SOUZA, Ch 0391 (BRL)');
    expect(fields[14]).toBe('3980.13');
  });
});

describe('parseCsv — full table parse', () => {
  it('returns an array of objects keyed by header', () => {
    const csv = 'name,age\nAlice,30\nBob,40\n';
    expect(parseCsv(csv)).toEqual([
      { name: 'Alice', age: '30' },
      { name: 'Bob',   age: '40' },
    ]);
  });
  it('skips empty trailing lines', () => {
    const csv = 'a,b\n1,2\n\n\n';
    expect(parseCsv(csv)).toHaveLength(1);
  });
  it('handles the real Airbnb header (22 columns)', () => {
    const csv = [
      'Date,Arriving by date,Type,Confirmation code,Booking date,Start date,End date,Nights,Guest,Listing,Details,Reference code,Currency,Amount,Paid out,Service fee,Fast pay fee,Cleaning fee,Pet fee,Gross earnings,Airbnb remitted tax,Earnings year',
      '04/02/2026,,Reservation,HMDA8Z99PP,01/11/2026,04/01/2026,04/05/2026,4,Karine Brugger,Sítio com lazer completo e piscina aquecida,,,BRL,3980.13,,189.87,,270.00,0.00,4146.93,0.00,2026',
    ].join('\n');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Confirmation code']).toBe('HMDA8Z99PP');
    expect(rows[0]['Cleaning fee']).toBe('270.00');
    expect(rows[0]['Service fee']).toBe('189.87');
    expect(rows[0]['Guest']).toBe('Karine Brugger');
  });
});

describe('toMoney', () => {
  it('parses plain decimals', () => {
    expect(toMoney('270.00')).toBe(270);
    expect(toMoney('3980.13')).toBe(3980.13);
  });
  it('strips currency symbols and whitespace', () => {
    expect(toMoney('R$ 270,00'.replace(',', '.'))).toBe(270); // BR-style would need pre-normalize
    expect(toMoney('  -150  ')).toBe(-150);
  });
  it('returns null for blank / undefined / null', () => {
    expect(toMoney('')).toBeNull();
    expect(toMoney(null)).toBeNull();
    expect(toMoney(undefined)).toBeNull();
  });
  it('returns null for unparseable strings', () => {
    expect(toMoney('not a number')).toBeNull();
  });
});

describe('toMMDDYYYY — Airbnb date format', () => {
  it('parses 04/02/2026 as 2026-04-02', () => {
    const d = toMMDDYYYY('04/02/2026');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString().startsWith('2026-04-02')).toBe(true);
  });
  it('returns null for blank / malformed input', () => {
    expect(toMMDDYYYY('')).toBeNull();
    expect(toMMDDYYYY('2026-04-02')).toBeNull();    // ISO format not Airbnb's
    expect(toMMDDYYYY('4/2/2026')).toBeNull();      // missing zero-padding
  });
});

describe('externalIdCandidates — match either iCal UID format', () => {
  it('returns both bare and @airbnb.com forms', () => {
    expect(externalIdCandidates('HMDA8Z99PP')).toEqual(['HMDA8Z99PP', 'HMDA8Z99PP@airbnb.com']);
  });
  it('trims surrounding whitespace', () => {
    expect(externalIdCandidates('  HMABCDEF  ')).toEqual(['HMABCDEF', 'HMABCDEF@airbnb.com']);
  });
  it('returns empty array for blank input', () => {
    expect(externalIdCandidates('')).toEqual([]);
    expect(externalIdCandidates(null)).toEqual([]);
  });
});

describe('looksLikePlaceholder — protect admin-edited names', () => {
  it('treats null/empty/whitespace as placeholder', () => {
    expect(looksLikePlaceholder(null)).toBe(true);
    expect(looksLikePlaceholder('')).toBe(true);
    expect(looksLikePlaceholder('   ')).toBe(true);
  });
  it('detects Brazilian iCal placeholders', () => {
    expect(looksLikePlaceholder('Reservada')).toBe(true);
    expect(looksLikePlaceholder('Reservado')).toBe(true);
    expect(looksLikePlaceholder('reservado por')).toBe(true);
  });
  it('detects Airbnb confirmation-code-as-name patterns', () => {
    expect(looksLikePlaceholder('ABNB-XX9YZ')).toBe(true);
    expect(looksLikePlaceholder('HMDA8Z99PP')).toBe(true);
    expect(looksLikePlaceholder('Reservation')).toBe(true);
  });
  it('does NOT mistake real Brazilian guest names for placeholders', () => {
    // Real guests from the actual CSV — these must be preserved verbatim.
    expect(looksLikePlaceholder('Karine Brugger')).toBe(false);
    expect(looksLikePlaceholder('Roberta Magalhães')).toBe(false);
    expect(looksLikePlaceholder('Andre De Souza')).toBe(false);
    expect(looksLikePlaceholder('Francisco Enrico Regino Regino')).toBe(false);
    // Single Brazilian first name should still pass through (admin may
    // have entered just the first name)
    expect(looksLikePlaceholder('Maria')).toBe(false);
  });
});
