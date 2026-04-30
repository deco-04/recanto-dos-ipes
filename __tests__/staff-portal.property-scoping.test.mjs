// Integration test for the property-scoping wire-in shipped 2026-04-30 to
// staff-portal.js casa/* + piscina/* endpoints. The audit found that a
// GOVERNANTA-RDS could see RDI/CDS bookings via these endpoints because the
// route only filtered `where.propertyId` when ?propertyId= was passed, and
// the staff app calls them WITHOUT the param. After applyPropertyScope():
//
//   ADMIN                       → sees all properties (default)
//   GOVERNANTA-RDS, no param   → sees only RDS bookings
//   GOVERNANTA-RDS, ?propertyId=RDS_ID → sees RDS bookings
//   GOVERNANTA-RDS, ?propertyId=RDI_ID → 403 PROPERTY_NOT_ASSIGNED
//   GOVERNANTA with no assignments → 200 [] (empty list, no leak)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const SECRET   = 'test-secret-property-scoping';
process.env.STAFF_JWT_SECRET = SECRET;

const STAFF_GOVERNANTA = 'gov_test_1';
const STAFF_ADMIN      = 'adm_test_1';
const TOKEN_GOV   = jwt.sign({ sub: STAFF_GOVERNANTA }, SECRET);
const TOKEN_ADMIN = jwt.sign({ sub: STAFF_ADMIN },      SECRET);

const RDS_ID = 'prop_rds';
const RDI_ID = 'prop_rdi';
const CDS_ID = 'prop_cds';

const stubs = {
  staffMemberFindUnique:               vi.fn(),
  staffPropertyAssignmentFindMany:     vi.fn(),
  bookingFindMany:                     vi.fn(),
};

const __filename      = fileURLToPath(import.meta.url);
const __dirname       = path.dirname(__filename);
const projectRoot     = path.resolve(__dirname, '..');
const requireFromHere = createRequire(import.meta.url);
const ModuleCtor      = requireFromHere('module');

function injectFakeCjsModule(absolutePath, fakeExports) {
  const resolved = requireFromHere.resolve(absolutePath);
  const fakeMod  = new ModuleCtor(resolved);
  fakeMod.filename = resolved;
  fakeMod.loaded   = true;
  fakeMod.exports  = fakeExports;
  ModuleCtor._cache[resolved] = fakeMod;
}

const fakePrisma = {
  staffMember:              { findUnique: (...a) => stubs.staffMemberFindUnique(...a) },
  staffPropertyAssignment:  {
    findMany:  (...a) => stubs.staffPropertyAssignmentFindMany(...a),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert:    vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  booking: {
    findMany:    (...a) => stubs.bookingFindMany(...a),
    findFirst:   vi.fn(),
    findUnique:  vi.fn(),
    update:      vi.fn(),
    create:      vi.fn(),
    aggregate:   vi.fn(),
    count:       vi.fn(),
    groupBy:     vi.fn(),
  },
  property:        { findUnique: vi.fn(), findMany: vi.fn() },
  inspection:      { findMany: vi.fn() },
  inspectionReport: { findMany: vi.fn() },
  maintenanceLog:  { findMany: vi.fn(), create: vi.fn() },
  serviceTicket:   { findMany: vi.fn(), create: vi.fn() },
  staffTask:       { findMany: vi.fn() },
  conversation:    { findMany: vi.fn() },
  expense:         { findMany: vi.fn(), aggregate: vi.fn() },
  whatsAppMessageLog: { findMany: vi.fn() },
};

injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'), fakePrisma);
injectFakeCjsModule(path.join(projectRoot, 'lib/tasks.js'),       { maybeCompleteOtaTask: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-webhook.js'), { sendPorteiroMessage: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/push.js'),        { sendPushToRole: vi.fn(), sendPushToStaff: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/phone.js'),       { toE164: x => x });
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-client.js'),  {});
injectFakeCjsModule(path.join(projectRoot, 'lib/occupancy.js'),   { computeOccupancy: vi.fn(() => ({ percent: 0 })) });
injectFakeCjsModule(path.join(projectRoot, 'lib/contacts.js'),    { upsertContactFromBooking: vi.fn() });

let server;
let port;

async function startApp() {
  const imported = requireFromHere(path.join(projectRoot, 'routes/staff-portal.js'));
  const router   = imported.default || imported;
  const app = express();
  app.use(express.json());
  app.use('/api/staff', router);
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function getJson(urlPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('staff-portal property scoping — applyPropertyScope wire-in', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    if (!server) await startApp();
  });

  describe('ADMIN role — bypass (sees all properties)', () => {
    beforeEach(() => {
      stubs.staffMemberFindUnique.mockResolvedValue({
        id: STAFF_ADMIN, role: 'ADMIN', active: true, name: 'Admin', email: 'a@x.com',
      });
      stubs.bookingFindMany.mockResolvedValue([]);
    });

    it('GET /casa/proximas without propertyId → where.propertyId = { not: null } (all)', async () => {
      const r = await getJson('/api/staff/casa/proximas', TOKEN_ADMIN);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toEqual({ not: null });
      // Critical: admin should NOT trigger a StaffPropertyAssignment lookup
      expect(stubs.staffPropertyAssignmentFindMany).not.toHaveBeenCalled();
    });

    it('GET /casa/em-curso?propertyId=RDS_ID → where.propertyId = RDS_ID (specific)', async () => {
      const r = await getJson(`/api/staff/casa/em-curso?propertyId=${RDS_ID}`, TOKEN_ADMIN);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toBe(RDS_ID);
    });
  });

  describe('GOVERNANTA-RDS — limited to assigned property', () => {
    beforeEach(() => {
      stubs.staffMemberFindUnique.mockResolvedValue({
        id: STAFF_GOVERNANTA, role: 'GOVERNANTA', active: true, name: 'Gov RDS', email: 'g@x.com',
      });
      stubs.staffPropertyAssignmentFindMany.mockResolvedValue([{ propertyId: RDS_ID }]);
      stubs.bookingFindMany.mockResolvedValue([]);
    });

    it('GET /casa/proximas without propertyId → where.propertyId = { in: [RDS_ID] } (the actual fix)', async () => {
      // This is the regression-blocker. Pre-fix, the route filtered nothing
      // when propertyId was missing, so the GOVERNANTA saw RDI+CDS+SRI rows.
      const r = await getJson('/api/staff/casa/proximas', TOKEN_GOV);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toEqual({ in: [RDS_ID] });
    });

    it('GET /casa/em-curso?propertyId=RDS_ID → 200 with where.propertyId = RDS_ID', async () => {
      const r = await getJson(`/api/staff/casa/em-curso?propertyId=${RDS_ID}`, TOKEN_GOV);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toBe(RDS_ID);
    });

    it('GET /casa/em-curso?propertyId=RDI_ID → 403 PROPERTY_NOT_ASSIGNED', async () => {
      // The cookie-spoofing attack vector: GOVERNANTA-RDS sets ?propertyId=RDI.
      // Pre-fix this returned RDI's data; post-fix it's a 403.
      const r = await getJson(`/api/staff/casa/em-curso?propertyId=${RDI_ID}`, TOKEN_GOV);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('PROPERTY_NOT_ASSIGNED');
      expect(stubs.bookingFindMany).not.toHaveBeenCalled();
    });

    it('GET /casa/proximas-saidas?propertyId=ALL → limited to assigned (does NOT mean all properties)', async () => {
      // Critical: a non-admin passing ?propertyId=ALL should NOT bypass
      // scoping — they get their assigned properties only, never the full
      // multi-property dataset.
      const r = await getJson('/api/staff/casa/proximas-saidas?propertyId=ALL', TOKEN_GOV);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toEqual({ in: [RDS_ID] });
    });

    it('GET /piscina/proximas without propertyId → scoped to assigned (same wire-in)', async () => {
      const r = await getJson('/api/staff/piscina/proximas', TOKEN_GOV);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toEqual({ in: [RDS_ID] });
    });

    it('GET /casa/calendario without propertyId → scoped (calendar sweep included)', async () => {
      const r = await getJson('/api/staff/casa/calendario', TOKEN_GOV);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toEqual({ in: [RDS_ID] });
    });
  });

  describe('GOVERNANTA with no assignments — empty result, no leak', () => {
    beforeEach(() => {
      stubs.staffMemberFindUnique.mockResolvedValue({
        id: STAFF_GOVERNANTA, role: 'GOVERNANTA', active: true, name: 'Gov Orphan', email: 'o@x.com',
      });
      stubs.staffPropertyAssignmentFindMany.mockResolvedValue([]);  // no assignments
      stubs.bookingFindMany.mockResolvedValue([]);
    });

    it('GET /casa/proximas → 200 with [] (does NOT short-circuit to "see all")', async () => {
      // Defensive: even if the route's where clause was somehow wrong,
      // applyPropertyScope returns 200 [] before any DB query.
      const r = await getJson('/api/staff/casa/proximas', TOKEN_GOV);
      expect(r.status).toBe(200);
      expect(r.body).toEqual([]);
      expect(stubs.bookingFindMany).not.toHaveBeenCalled();
    });
  });

  describe('GOVERNANTA assigned to multiple properties', () => {
    beforeEach(() => {
      stubs.staffMemberFindUnique.mockResolvedValue({
        id: STAFF_GOVERNANTA, role: 'GOVERNANTA', active: true, name: 'Gov Multi', email: 'm@x.com',
      });
      // E.g., Sthefane manages both RDS and CDS
      stubs.staffPropertyAssignmentFindMany.mockResolvedValue([
        { propertyId: RDS_ID }, { propertyId: CDS_ID },
      ]);
      stubs.bookingFindMany.mockResolvedValue([]);
    });

    it('GET /casa/proximas without param → IN clause covers both assigned properties', async () => {
      const r = await getJson('/api/staff/casa/proximas', TOKEN_GOV);
      expect(r.status).toBe(200);
      const findArgs = stubs.bookingFindMany.mock.calls[0][0];
      expect(findArgs.where.propertyId).toEqual({ in: [RDS_ID, CDS_ID] });
    });

    it('GET /casa/proximas?propertyId=RDI_ID → 403 even when staff has multi-property access (just not RDI)', async () => {
      const r = await getJson(`/api/staff/casa/proximas?propertyId=${RDI_ID}`, TOKEN_GOV);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('PROPERTY_NOT_ASSIGNED');
    });
  });
});
