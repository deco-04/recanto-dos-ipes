// Tests for the dedicated cleaning-fee endpoint shipped 2026-04-30.
//
// Pinning the contract:
//   PATCH /api/admin/staff/properties/:id/pricing/cleaning-fee
//     body: { cleaningFee: number }   # 1..2000
//   - happy path: only cleaningFee changes, other config fields preserved
//   - 400 below R$ 1 (rejects "0" typos that would zero out the fee)
//   - 400 above R$ 2000 (rejects extreme typos that would inflate guest totals)
//   - 404 when property doesn't exist
//   - requireAdmin enforcement (router.use(requireAdmin) at file head)
//
// Why a dedicated endpoint vs reusing PATCH /:id/pricing:
//   The admin precos UI cares only about cleaningFee. With the full-config
//   PATCH, a stale local view could clobber tiers/baseGuests on save. This
//   endpoint reads existing config, merges only the cleaningFee, writes
//   back — same idempotency benefit as a PostgreSQL UPSERT.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const STAFF_ID = 'staff_admin_cf';
const SECRET   = 'test-secret-cleaning-fee';
process.env.STAFF_JWT_SECRET = SECRET;
const TOKEN_ADMIN = jwt.sign({ sub: STAFF_ID }, SECRET);

const stubs = {
  staffMemberFindUnique: vi.fn(),
  propertyFindUnique:    vi.fn(),
  propertyUpdate:        vi.fn(),
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
  staffMember: { findUnique: (...a) => stubs.staffMemberFindUnique(...a) },
  property: {
    findUnique: (...a) => stubs.propertyFindUnique(...a),
    update:     (...a) => stubs.propertyUpdate(...a),
  },
  // Other models the route module imports but we don't exercise here:
  staffPropertyAssignment: { createMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  invoiceCounter: { upsert: vi.fn() },
  expense:        { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  booking:        { findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
  pricingTier:    { findMany: vi.fn(), update: vi.fn() },
};

injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'),     fakePrisma);
injectFakeCjsModule(path.join(projectRoot, 'lib/sync-rds.js'), { pushPricingToRds: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/mailer.js'), {
  sendStaffInvite: vi.fn(),
  sendPasswordReset: vi.fn(),
});

let server;
let port;

async function startApp() {
  const imported = requireFromHere(path.join(projectRoot, 'routes/admin-staff.js'));
  const router   = imported.default || imported;
  const app = express();
  app.use(express.json());
  app.use('/api/admin/staff', router);
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function patch(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'PATCH',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('PATCH /api/admin/staff/properties/:id/pricing/cleaning-fee', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    stubs.staffMemberFindUnique.mockResolvedValue({
      id: STAFF_ID, role: 'ADMIN', active: true, name: 'Admin', email: 'a@x.com',
    });
    if (!server) await startApp();
  });

  describe('happy path', () => {
    it('updates cleaningFee while preserving other pricingConfig fields', async () => {
      stubs.propertyFindUnique.mockResolvedValue({
        id: 'rdi',
        pricingConfig: {
          tiers: { LOW: 720, MID: 850, HIGH_MID: 1050, PEAK: 1300 },
          extraGuestPerNight: 50,
          cleaningFee: 240,            // OLD
          baseGuests: 11,
        },
      });
      stubs.propertyUpdate.mockImplementation(async ({ data }) => ({
        id: 'rdi', name: 'Sítio Recanto dos Ipês', pricingConfig: data.pricingConfig,
      }));

      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: 270 }, TOKEN_ADMIN);

      expect(r.status).toBe(200);
      expect(r.body.pricing.cleaningFee).toBe(270);
      // Critical: other fields must survive untouched (no clobber)
      expect(r.body.pricing.tiers).toEqual({ LOW: 720, MID: 850, HIGH_MID: 1050, PEAK: 1300 });
      expect(r.body.pricing.extraGuestPerNight).toBe(50);
      expect(r.body.pricing.baseGuests).toBe(11);
    });

    it('handles property whose pricingConfig was previously null (first cleaning-fee write)', async () => {
      stubs.propertyFindUnique.mockResolvedValue({ id: 'cds', pricingConfig: null });
      stubs.propertyUpdate.mockImplementation(async ({ data }) => ({
        id: 'cds', name: 'Cabanas', pricingConfig: data.pricingConfig,
      }));

      const r = await patch('/api/admin/staff/properties/cds/pricing/cleaning-fee',
        { cleaningFee: 300 }, TOKEN_ADMIN);
      expect(r.status).toBe(200);
      expect(r.body.pricing).toEqual({ cleaningFee: 300 });
    });
  });

  describe('validation', () => {
    it('rejects R$ 0 — typical accidental "clear field" typo', async () => {
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: 0 }, TOKEN_ADMIN);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/inválida/i);
      expect(stubs.propertyUpdate).not.toHaveBeenCalled();
    });

    it('rejects negative values', async () => {
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: -50 }, TOKEN_ADMIN);
      expect(r.status).toBe(400);
      expect(stubs.propertyUpdate).not.toHaveBeenCalled();
    });

    it('rejects values above R$ 2000 — typo guard against e.g. "27000" instead of "270"', async () => {
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: 27000 }, TOKEN_ADMIN);
      expect(r.status).toBe(400);
      expect(stubs.propertyUpdate).not.toHaveBeenCalled();
    });

    it('rejects non-numeric body', async () => {
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: 'two seventy' }, TOKEN_ADMIN);
      expect(r.status).toBe(400);
    });

    it('rejects missing body', async () => {
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        {}, TOKEN_ADMIN);
      expect(r.status).toBe(400);
    });
  });

  describe('not found', () => {
    it('404 when property does not exist', async () => {
      stubs.propertyFindUnique.mockResolvedValue(null);
      const r = await patch('/api/admin/staff/properties/missing/pricing/cleaning-fee',
        { cleaningFee: 270 }, TOKEN_ADMIN);
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/não encontrada/i);
      expect(stubs.propertyUpdate).not.toHaveBeenCalled();
    });
  });

  describe('auth', () => {
    it('401 without bearer token', async () => {
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: 270 }, null);
      expect(r.status).toBe(401);
    });

    it('403 when staff is not ADMIN', async () => {
      stubs.staffMemberFindUnique.mockResolvedValue({
        id: STAFF_ID, role: 'GOVERNANTA', active: true, name: 'Cleaning lead', email: 'g@x.com',
      });
      const r = await patch('/api/admin/staff/properties/rdi/pricing/cleaning-fee',
        { cleaningFee: 270 }, TOKEN_ADMIN);
      expect(r.status).toBe(403);
    });
  });
});
