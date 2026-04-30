// Tests for the multi-property scoping helpers added 2026-04-30:
//
//   hasPropertyAccess(staff, propertyId)        → boolean predicate
//   requirePropertyAccess(getPropertyId)        → Express middleware factory
//
// Why this exists (per the holistic-roadmap S1 item):
//   The audit found that a CASA staff member from RDS could read RDI
//   bookings by changing the rds_property cookie or passing ?propertyId=...
//   The backend never validated the requesting staff's StaffPropertyAssignment
//   against the requested property. ADMINs are intentionally exempt — they
//   see all properties by design.
//
// These tests are unit-level: we stub Prisma's staffPropertyAssignment
// lookup and confirm the helper returns the right answer for each role/
// assignment combination. A separate integration test exercises the full
// HTTP path through requireStaff → requirePropertyAccess.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const __filename      = fileURLToPath(import.meta.url);
const __dirname       = path.dirname(__filename);
const projectRoot     = path.resolve(__dirname, '..');
const requireFromHere = createRequire(import.meta.url);
const ModuleCtor      = requireFromHere('module');

// Stub Prisma BEFORE requiring the middleware so it picks up the fake.
const stubs = {
  staffPropertyAssignmentFindUnique: vi.fn(),
};
const fakePrisma = {
  staffPropertyAssignment: {
    findUnique: (...a) => stubs.staffPropertyAssignmentFindUnique(...a),
  },
};
function injectFakeCjsModule(absolutePath, fakeExports) {
  const resolved = requireFromHere.resolve(absolutePath);
  const fakeMod  = new ModuleCtor(resolved);
  fakeMod.filename = resolved;
  fakeMod.loaded   = true;
  fakeMod.exports  = fakeExports;
  ModuleCtor._cache[resolved] = fakeMod;
}
injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'), fakePrisma);

const { hasPropertyAccess, requirePropertyAccess } =
  requireFromHere(path.join(projectRoot, 'lib/staff-auth-middleware.js'));

beforeEach(() => {
  stubs.staffPropertyAssignmentFindUnique.mockReset();
});

describe('hasPropertyAccess(staff, propertyId)', () => {
  it('ADMIN role → always true (no DB call)', async () => {
    const ok = await hasPropertyAccess({ id: 's1', role: 'ADMIN' }, 'prop_anything');
    expect(ok).toBe(true);
    expect(stubs.staffPropertyAssignmentFindUnique).not.toHaveBeenCalled();
  });

  it('GOVERNANTA with matching assignment → true', async () => {
    stubs.staffPropertyAssignmentFindUnique.mockResolvedValue({ id: 'asg_1' });
    const ok = await hasPropertyAccess({ id: 's_gov', role: 'GOVERNANTA' }, 'prop_rds');
    expect(ok).toBe(true);
    expect(stubs.staffPropertyAssignmentFindUnique).toHaveBeenCalledWith({
      where:  { staffId_propertyId: { staffId: 's_gov', propertyId: 'prop_rds' } },
      select: { id: true },
    });
  });

  it('GOVERNANTA with NO matching assignment → false (the cookie-spoofing case)', async () => {
    // Real attack pattern this guards against: a CASA-RDS staff edits the
    // rds_property cookie to RDI's id, hits an endpoint that previously
    // trusted the cookie blindly. With this predicate, the route can refuse.
    stubs.staffPropertyAssignmentFindUnique.mockResolvedValue(null);
    const ok = await hasPropertyAccess({ id: 's_gov', role: 'GOVERNANTA' }, 'prop_rdi');
    expect(ok).toBe(false);
  });

  it('null/undefined staff → false (defensive)', async () => {
    expect(await hasPropertyAccess(null, 'prop_x')).toBe(false);
    expect(await hasPropertyAccess(undefined, 'prop_x')).toBe(false);
    expect(await hasPropertyAccess({}, 'prop_x')).toBe(false);
  });

  it('null/undefined propertyId for non-admin → false (no DB call)', async () => {
    expect(await hasPropertyAccess({ id: 's1', role: 'GOVERNANTA' }, null)).toBe(false);
    expect(await hasPropertyAccess({ id: 's1', role: 'GOVERNANTA' }, undefined)).toBe(false);
    expect(stubs.staffPropertyAssignmentFindUnique).not.toHaveBeenCalled();
  });
});

describe('requirePropertyAccess() middleware factory', () => {
  function mockRes() {
    const res = {};
    res.status = vi.fn(code => { res._status = code; return res; });
    res.json   = vi.fn(body => { res._body = body; return res; });
    return res;
  }

  it('ADMIN bypasses unconditionally — calls next() without DB lookup', async () => {
    const req = { staff: { id: 's_admin', role: 'ADMIN' }, query: {} };
    const res = mockRes();
    const next = vi.fn();
    const mw = requirePropertyAccess(r => r.query.propertyId);

    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(stubs.staffPropertyAssignmentFindUnique).not.toHaveBeenCalled();
  });

  it('non-admin without propertyId on request → 400 PROPERTY_ID_REQUIRED', async () => {
    // Forces non-admin staff to be explicit about which property they're
    // accessing — they can't sneak past scoping by omitting the param.
    const req = { staff: { id: 's_gov', role: 'GOVERNANTA' }, query: {} };
    const res = mockRes();
    const next = vi.fn();
    const mw = requirePropertyAccess(r => r.query.propertyId);

    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._body).toEqual(expect.objectContaining({ code: 'PROPERTY_ID_REQUIRED' }));
  });

  it('non-admin with unauthorized propertyId → 403 PROPERTY_NOT_ASSIGNED', async () => {
    stubs.staffPropertyAssignmentFindUnique.mockResolvedValue(null);
    const req = { staff: { id: 's_gov', role: 'GOVERNANTA' }, query: { propertyId: 'prop_other' } };
    const res = mockRes();
    const next = vi.fn();
    const mw = requirePropertyAccess(r => r.query.propertyId);

    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(res._body).toEqual(expect.objectContaining({ code: 'PROPERTY_NOT_ASSIGNED' }));
  });

  it('non-admin with authorized propertyId → next()', async () => {
    stubs.staffPropertyAssignmentFindUnique.mockResolvedValue({ id: 'asg_1' });
    const req = { staff: { id: 's_gov', role: 'GOVERNANTA' }, query: { propertyId: 'prop_rds' } };
    const res = mockRes();
    const next = vi.fn();
    const mw = requirePropertyAccess(r => r.query.propertyId);

    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('default extractor checks params → query → body in order', async () => {
    stubs.staffPropertyAssignmentFindUnique.mockResolvedValue({ id: 'asg_1' });
    const req = {
      staff:  { id: 's_gov', role: 'GOVERNANTA' },
      params: { propertyId: 'prop_from_params' },
      query:  { propertyId: 'prop_from_query' },
      body:   { propertyId: 'prop_from_body' },
    };
    const res = mockRes();
    const next = vi.fn();
    const mw = requirePropertyAccess();   // no extractor → use defaults

    await mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    // Should have looked up the params version, not query/body
    expect(stubs.staffPropertyAssignmentFindUnique).toHaveBeenCalledWith({
      where:  { staffId_propertyId: { staffId: 's_gov', propertyId: 'prop_from_params' } },
      select: { id: true },
    });
  });

  it('default extractor falls back to query when params is empty', async () => {
    stubs.staffPropertyAssignmentFindUnique.mockResolvedValue({ id: 'asg_1' });
    const req = {
      staff:  { id: 's_gov', role: 'GOVERNANTA' },
      params: {},
      query:  { propertyId: 'prop_from_query' },
    };
    const res = mockRes();
    const next = vi.fn();
    const mw = requirePropertyAccess();

    await mw(req, res, next);
    expect(stubs.staffPropertyAssignmentFindUnique).toHaveBeenCalledWith({
      where:  { staffId_propertyId: { staffId: 's_gov', propertyId: 'prop_from_query' } },
      select: { id: true },
    });
  });
});
