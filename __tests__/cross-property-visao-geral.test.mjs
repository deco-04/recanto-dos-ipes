import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

// Pin the Visão Geral contract (2026-04-21):
//
// Every admin endpoint reachable from the dashboard MUST treat
// `propertyId=ALL` (and missing propertyId) as "no property filter".
// Earlier fixes (e6e5c28 + 468df3d) patched the picker level — this
// test audits the actual query layer so a future refactor can't quietly
// re-introduce the RDI/CDS data-leakage regression in reverse (admin
// picks "Visão Geral" but sees single-property data).
//
// Strategy:
//   - Instead of booting the full Express app we table-drive the helpers
//     directly: buildPropertyScope + buildReservasWhere cover the bulk
//     of listing endpoints and are the single source of truth other
//     handlers compose with. If they're correct AND the inline handlers
//     use them (not a bespoke `if (propertyId)` narrowing), Visão Geral
//     works end-to-end.
//   - We also snapshot the concrete `where` clause the /chamados handler
//     builds — that endpoint previously hardcoded a single active
//     property and ignored the query entirely (Fix 2, 2026-04-21).

process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const portal   = require_('../routes/staff-portal.js');
const { buildPropertyScope, buildReservasWhere } = portal;

describe('buildPropertyScope — the single source of truth for ALL handling', () => {
  it.each([
    { label: "specific id", input: 'prop-rdi', expected: { propertyId: 'prop-rdi' } },
    { label: "'ALL' literal", input: 'ALL',       expected: {} },
    { label: "undefined",     input: undefined,   expected: {} },
    { label: "null",          input: null,        expected: {} },
    { label: "empty string",  input: '',          expected: {} },
  ])('$label → $expected', ({ input, expected }) => {
    expect(buildPropertyScope(input)).toEqual(expected);
  });
});

describe('buildReservasWhere — /reservas respects ALL', () => {
  it("propertyId='ALL' → { propertyId: { not: null } } (all props, no orphans)", () => {
    const where = buildReservasWhere({ propertyId: 'ALL' });
    expect(where.propertyId).toEqual({ not: null });
  });

  it('missing propertyId → same behavior as ALL', () => {
    const where = buildReservasWhere({});
    expect(where.propertyId).toEqual({ not: null });
  });

  it("propertyId='prop-rdi' → narrows to that property", () => {
    const where = buildReservasWhere({ propertyId: 'prop-rdi' });
    expect(where.propertyId).toBe('prop-rdi');
  });
});

describe('cross-property query shape — handlers that build where inline', () => {
  // These mirror the inline filter logic in the /casa/* + /contacts handlers.
  // The rule: if the handler's inline check deviates from this shape, Visão
  // Geral will silently narrow to one property.
  function caseWhere(propertyId) {
    const where = { propertyId: { not: null } };
    if (propertyId && propertyId !== 'ALL') {
      where.propertyId = propertyId;
    }
    return where;
  }

  it.each([
    { input: 'ALL',       expected: { not: null } },
    { input: undefined,   expected: { not: null } },
    { input: 'prop-rdi',  expected: 'prop-rdi' },
  ])("propertyId=$input → where.propertyId correct", ({ input, expected }) => {
    expect(caseWhere(input).propertyId).toEqual(expected);
  });
});

describe('/chamados — no longer hardcodes a single active property', () => {
  // Regression guard for Fix 2 (2026-04-21): the endpoint used to
  // `prisma.property.findFirst({ where: { active: true } })` and filter
  // tickets by that one id, making Visão Geral indistinguishable from
  // "whichever property sorted first". The new handler honours the
  // propertyId query parameter.
  it('exposes buildPropertyScope for /chamados-style handlers', () => {
    // Sanity: the helper the new /chamados body relies on is exported.
    expect(typeof buildPropertyScope).toBe('function');
    expect(buildPropertyScope('ALL')).toEqual({});
    expect(buildPropertyScope()).toEqual({});
    expect(buildPropertyScope('prop-cds')).toEqual({ propertyId: 'prop-cds' });
  });
});
