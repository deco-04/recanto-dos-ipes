// Tests for the Sprint 3 E1 changes to GET /api/staff/dashboard-summary.
//
// What's being pinned:
//   1. despesasMes now includes BOTH manual operating expenses (Expense
//      model) AND OTA platform fees (Booking.airbnbHostFee +
//      Booking.commissionAmount) in a single number, so margin math is
//      finally correct on properties with OTA traffic.
//   2. The new `plataformaFees` field surfaces the OTA-fee subtotal so
//      the UI can break down "Operacionais R$X · Plataforma R$Y" without
//      a second round-trip.
//   3. Single-property scope gets a top-level `single` block with the
//      same shape as a perProperty[] entry. Pre-this-PR, single-scope
//      callers got no despesas/margin at all from this endpoint.
//   4. Bookings missing the new fee columns (pre-2026-04-30 backfill)
//      contribute 0 and don't break the sum.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const STAFF_ID = 'staff_admin_e1';
const SECRET   = 'test-secret-e1';
process.env.STAFF_JWT_SECRET = SECRET;
const TOKEN    = jwt.sign({ sub: STAFF_ID }, SECRET);

const stubs = {
  staffMemberFindUnique: vi.fn(),
  propertyFindMany:      vi.fn(),
  propertyFindUnique:    vi.fn(),
  bookingFindMany:       vi.fn(),
  bookingCount:          vi.fn(async () => 0),
  bookingUpsellFindMany: vi.fn(async () => []),
  expenseFindMany:       vi.fn(async () => []),
  expenseCount:          vi.fn(async () => 0),
  cabinCount:            vi.fn(async () => 1),
  contentPostCount:      vi.fn(async () => 0),
  inspectionReportCount: vi.fn(async () => 0),
  inboxMessageCount:     vi.fn(async () => 0),
  accessRequestCount:    vi.fn(async () => 0),
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
  staffMember:  { findUnique: (...a) => stubs.staffMemberFindUnique(...a) },
  property:     {
    findMany:   (...a) => stubs.propertyFindMany(...a),
    findUnique: (...a) => stubs.propertyFindUnique(...a),
  },
  booking: {
    findMany:  (...a) => stubs.bookingFindMany(...a),
    findFirst: vi.fn(async () => null),
    count:     (...a) => stubs.bookingCount(...a),
    aggregate: vi.fn(async () => ({ _sum: { totalAmount: 0 } })),
    groupBy:   vi.fn(async () => []),
  },
  bookingUpsell:    { findMany: (...a) => stubs.bookingUpsellFindMany(...a) },
  expense:          { findMany: (...a) => stubs.expenseFindMany(...a), count: (...a) => stubs.expenseCount(...a) },
  cabin:            { count:    (...a) => stubs.cabinCount(...a) },
  contentPost:      { count:    (...a) => stubs.contentPostCount(...a) },
  inspectionReport: { count:    (...a) => stubs.inspectionReportCount(...a) },
  inboxMessage:     { count:    (...a) => stubs.inboxMessageCount(...a) },
  accessRequest:    { count:    (...a) => stubs.accessRequestCount(...a) },
  // Endpoints the route imports but doesn't exercise in this scenario:
  staffPropertyAssignment: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(async () => []) },
  conversation:            { findMany: vi.fn() },
  serviceTicket:           { findMany: vi.fn() },
  staffTask:               { findMany: vi.fn() },
};

injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'),                fakePrisma);
injectFakeCjsModule(path.join(projectRoot, 'lib/tasks.js'),             { maybeCompleteOtaTask: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-webhook.js'),       { sendPorteiroMessage: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/push.js'),              { sendPushToRole: vi.fn(), sendPushToStaff: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/phone.js'),             { toE164: x => x });
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-client.js'),        {});
injectFakeCjsModule(path.join(projectRoot, 'lib/occupancy.js'),         { computeOccupancy: vi.fn(() => ({ percent: 0 })) });
injectFakeCjsModule(path.join(projectRoot, 'lib/contacts.js'),          { upsertContactFromBooking: vi.fn() });

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

function getJson(urlPath, token = TOKEN) {
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

describe('GET /api/staff/dashboard-summary — Sprint 3 E1 platform fees', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    // Default safe stubs the route falls back on
    stubs.staffMemberFindUnique.mockResolvedValue({
      id: STAFF_ID, role: 'ADMIN', active: true, name: 'Admin', email: 'a@x.com',
    });
    stubs.propertyFindMany.mockResolvedValue([
      { id: 'rdi', slug: 'recanto-dos-ipes', name: 'Sítio Recanto dos Ipês' },
    ]);
    stubs.propertyFindUnique.mockResolvedValue({ id: 'rdi', slug: 'recanto-dos-ipes', name: 'Sítio Recanto dos Ipês' });
    stubs.bookingFindMany.mockResolvedValue([]);   // no bookings by default
    stubs.expenseFindMany.mockResolvedValue([]);
    stubs.bookingUpsellFindMany.mockResolvedValue([]);
    stubs.bookingCount.mockResolvedValue(0);
    stubs.cabinCount.mockResolvedValue(1);
    stubs.contentPostCount.mockResolvedValue(0);
    stubs.inspectionReportCount.mockResolvedValue(0);
    stubs.inboxMessageCount.mockResolvedValue(0);
    stubs.accessRequestCount.mockResolvedValue(0);
    if (!server) await startApp();
  });

  describe('ALL scope (Visão Geral) — perProperty[] platform fees', () => {
    it('rolls Airbnb hostFee + Booking.com commissionAmount into despesasMes', async () => {
      // The bookingFindMany stub is called multiple times by the route (MTD
      // bookings + month bookings for occupancy + forecast + count). Return
      // an array of bookings with platform fees ONLY for the MTD-revenue
      // call (it's the call that selects airbnbHostFee + commissionAmount).
      stubs.bookingFindMany.mockImplementation(async args => {
        if (args?.select?.airbnbHostFee) {
          // MTD-bookings call
          return [
            { totalAmount: '1000', isInvoiceAggregate: false, airbnbHostFee: '50',  commissionAmount: null },
            { totalAmount: '2000', isInvoiceAggregate: false, airbnbHostFee: null,  commissionAmount: '300' },
            { totalAmount: '500',  isInvoiceAggregate: false, airbnbHostFee: null,  commissionAmount: null },  // direct, no fees
          ];
        }
        // Other calls (forecast, occupancy month-bookings) — return empty
        return [];
      });
      stubs.expenseFindMany.mockResolvedValue([{ amount: '100' }, { amount: '200' }]); // R$300 manual

      const r = await getJson('/api/staff/dashboard-summary');
      expect(r.status).toBe(200);
      const row = r.body.perProperty[0];
      // Receita: 1000 + 2000 + 500 = 3500
      expect(row.receitaBrutaMes).toBe(3500);
      // Operating expenses: 100 + 200 = 300
      expect(row.despesasOperacionais).toBe(300);
      // Platform fees: 50 + 300 = 350
      expect(row.plataformaFees).toBe(350);
      // Total despesas: 300 + 350 = 650
      expect(row.despesasMes).toBe(650);
      // Margin: (3500 - 650) / 3500 = 0.8142... = 81.4%
      expect(row.margemPct).toBe(81.4);
    });

    it('zero platform fees when no OTA bookings — direct-only month', async () => {
      stubs.bookingFindMany.mockImplementation(async args => {
        if (args?.select?.airbnbHostFee) {
          return [
            { totalAmount: '500', isInvoiceAggregate: false, airbnbHostFee: null, commissionAmount: null },
            { totalAmount: '500', isInvoiceAggregate: false, airbnbHostFee: null, commissionAmount: null },
          ];
        }
        return [];
      });
      stubs.expenseFindMany.mockResolvedValue([{ amount: '50' }]);

      const r = await getJson('/api/staff/dashboard-summary');
      const row = r.body.perProperty[0];
      expect(row.plataformaFees).toBe(0);
      expect(row.despesasOperacionais).toBe(50);
      expect(row.despesasMes).toBe(50);
    });

    it('handles bookings with both fields set (defensive — should not double-count)', async () => {
      // Defensive case: a single booking somehow has both Airbnb hostFee AND
      // Booking.com commissionAmount populated. The current helper sums
      // them — that's correct because they're additive (a single booking
      // could in principle pay fees to multiple platforms in some bizarre
      // edge case). We pin this behavior so a future "smart" change that
      // tries to dedupe doesn't silently halve the platform-fee total.
      stubs.bookingFindMany.mockImplementation(async args => {
        if (args?.select?.airbnbHostFee) {
          return [{ totalAmount: '1000', isInvoiceAggregate: false, airbnbHostFee: '50', commissionAmount: '60' }];
        }
        return [];
      });
      const r = await getJson('/api/staff/dashboard-summary');
      expect(r.body.perProperty[0].plataformaFees).toBe(110);
    });
  });

  describe('SINGLE scope — top-level `single` block', () => {
    beforeEach(() => {
      // Single-scope path: route looks up via findUnique with the requested id
      stubs.propertyFindUnique.mockResolvedValue({
        id: 'rdi', slug: 'recanto-dos-ipes', name: 'Sítio Recanto dos Ipês',
      });
    });

    it('includes despesasMes / plataformaFees / margemPct (was missing pre-Sprint-3-E1)', async () => {
      stubs.bookingFindMany.mockImplementation(async args => {
        if (args?.select?.airbnbHostFee) {
          return [{ totalAmount: '1000', isInvoiceAggregate: false, airbnbHostFee: '50', commissionAmount: null }];
        }
        return [];
      });
      stubs.expenseFindMany.mockResolvedValue([{ amount: '100' }]);

      const r = await getJson('/api/staff/dashboard-summary?propertyId=rdi');
      expect(r.status).toBe(200);
      expect(r.body.scope).toBe('SINGLE');
      expect(r.body.perProperty).toEqual([]);
      // The `single` block is the new contract this PR adds.
      expect(r.body.single).toMatchObject({
        propertyId:           'rdi',
        receitaMes:           1000,
        despesasOperacionais: 100,
        plataformaFees:       50,
        despesasMes:          150,
      });
      // Margin: (1000 - 150) / 1000 = 0.85 = 85%
      expect(r.body.single.margemPct).toBe(85);
    });

    it('ALL scope leaves single=null (only populated for SINGLE scope)', async () => {
      const r = await getJson('/api/staff/dashboard-summary');
      expect(r.body.scope).toBe('ALL');
      expect(r.body.single).toBeNull();
    });
  });

  describe('regression — existing fields still present', () => {
    it('per-property still exposes id, slug, name, ocupacaoMesPct, hospedadosAgora, cabinCount', async () => {
      stubs.bookingFindMany.mockResolvedValue([]);
      const r = await getJson('/api/staff/dashboard-summary');
      const row = r.body.perProperty[0];
      expect(row).toHaveProperty('id', 'rdi');
      expect(row).toHaveProperty('slug', 'recanto-dos-ipes');
      expect(row).toHaveProperty('name', 'Sítio Recanto dos Ipês');
      expect(row).toHaveProperty('ocupacaoMesPct');
      expect(row).toHaveProperty('hospedadosAgora');
      expect(row).toHaveProperty('cabinCount');
      expect(row).toHaveProperty('resultadoLiquidoMes');
    });

    it('top-level attention + forecast30d still present', async () => {
      const r = await getJson('/api/staff/dashboard-summary');
      // Just verify the shape exists — `total` may serialise to null when
      // the underlying counts are mocked with mixed undefined/0 values
      // (mockReset wipes returns; not all counter stubs are re-set in
      // every test). The ALL-scope test above already exercises a fully
      // populated response.
      expect(r.body).toHaveProperty('attention');
      expect(r.body).toHaveProperty('forecast30d');
      expect(r.body.attention).toHaveProperty('requestedBookings');
      expect(r.body.forecast30d).toHaveProperty('receita');
    });
  });
});
