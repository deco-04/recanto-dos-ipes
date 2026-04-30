// Tests for the /api/health endpoint shipped 2026-04-30 as part of the
// observability foundation (Sprint 2, O2 in the holistic-roadmap plan).
//
// Pin the contract:
//   - response shape: { status, timestamp, uptimeSeconds, services: {...} }
//   - rollup: any 'error' → 'error'; any 'degraded' → 'degraded'; else 'ok'
//   - HTTP code: 503 only on rollup='error'; 200 otherwise (degraded
//     services should NOT trigger Railway restart loops)
//   - per-service: not-configured ≠ degraded ≠ error (intentional missing
//     config doesn't bring the rollup down)
//   - DB ping uses $queryRaw — must work against the unsafe template literal
//   - iCal freshness derives from latest Booking row dateAdded

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const stubs = {
  queryRaw:         vi.fn(),
  bookingFindFirst: vi.fn(),
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
  $queryRaw: (...a) => stubs.queryRaw(...a),
  booking:   { findFirst: (...a) => stubs.bookingFindFirst(...a) },
};
injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'), fakePrisma);

let server;
let port;

async function startApp() {
  const imported = requireFromHere(path.join(projectRoot, 'routes/health.js'));
  const router   = imported.default || imported;
  const app = express();
  app.use('/api/health', router);
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, res => {
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

const ALL_ENV = [
  'GHL_API_KEY', 'GHL_COMPANY_ID', 'GHL_LOCATION_ID',
  'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN',
  'ANTHROPIC_API_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
];

function clearEnv() {
  for (const k of ALL_ENV) delete process.env[k];
}

describe('GET /api/health — operational health check', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    clearEnv();
    if (!server) await startApp();
  });

  describe('response shape', () => {
    it('always includes status, timestamp, uptimeSeconds, services', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);

      const r = await get('/api/health');
      expect(r.body).toMatchObject({
        status:        expect.any(String),
        timestamp:     expect.any(String),
        uptimeSeconds: expect.any(Number),
        services:      expect.any(Object),
      });
      expect(Object.keys(r.body.services)).toEqual(
        expect.arrayContaining(['database', 'ghl', 'whatsapp', 'gmail', 'anthropic', 'push', 'ical'])
      );
    });
  });

  describe('rollup status logic', () => {
    it('all configured + DB up + recent iCal sync → ok / 200', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30min ago
        source:    'AIRBNB',
      });
      process.env.GHL_API_KEY        = 'pit_x';
      process.env.GHL_COMPANY_ID     = 'loc_x';
      process.env.GMAIL_CLIENT_ID    = 'g_id';
      process.env.GMAIL_CLIENT_SECRET = 'g_sec';
      process.env.GMAIL_REFRESH_TOKEN = 'g_ref';
      process.env.ANTHROPIC_API_KEY  = 'sk_x';
      process.env.VAPID_PUBLIC_KEY   = 'pub';
      process.env.VAPID_PRIVATE_KEY  = 'priv';

      const r = await get('/api/health');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
      expect(r.body.services.database.status).toBe('ok');
      expect(r.body.services.ghl.status).toBe('ok');
      expect(r.body.services.ical.status).toBe('ok');
    });

    it('iCal stale 12h → degraded / 200 (degraded must NOT 503)', async () => {
      // Critical: degraded should not trigger Railway restart loops or
      // page on-call. Only true 'error' rolls up to 503.
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        source:    'AIRBNB',
      });
      process.env.GHL_API_KEY    = 'pit_x';
      process.env.GHL_COMPANY_ID = 'loc_x';

      const r = await get('/api/health');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('degraded');
      expect(r.body.services.ical.status).toBe('degraded');
      expect(r.body.services.ical.details).toMatch(/last imported booking/i);
    });

    it('iCal stale 30h → error / 503', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        source:    'BOOKING_COM',
      });

      const r = await get('/api/health');
      expect(r.status).toBe(503);
      expect(r.body.status).toBe('error');
      expect(r.body.services.ical.status).toBe('error');
    });

    it('database down → error / 503 (catastrophic)', async () => {
      stubs.queryRaw.mockRejectedValue(new Error('connection refused'));
      stubs.bookingFindFirst.mockResolvedValue(null);

      const r = await get('/api/health');
      expect(r.status).toBe(503);
      expect(r.body.status).toBe('error');
      expect(r.body.services.database.status).toBe('error');
      expect(r.body.services.database.error).toMatch(/connection refused/i);
    });

    it('not-configured services do NOT bring rollup down', async () => {
      // RDI's reality: WhatsApp Cloud API direct path is intentionally not
      // configured (uses GHL hosted). Must not be flagged as a problem.
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue({
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
        source:    'AIRBNB',
      });
      // Only set GHL — leave WA, Gmail, Anthropic, push unset on purpose.
      process.env.GHL_API_KEY    = 'pit_x';
      process.env.GHL_COMPANY_ID = 'loc_x';

      const r = await get('/api/health');
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('ok');
      expect(r.body.services.whatsapp.status).toBe('not-configured');
      expect(r.body.services.gmail.status).toBe('not-configured');
      expect(r.body.services.anthropic.status).toBe('not-configured');
      expect(r.body.services.push.status).toBe('not-configured');
    });
  });

  describe('per-service edge cases', () => {
    it('GHL: only API_KEY without locationId → not-configured with helpful detail', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);
      process.env.GHL_API_KEY = 'pit_x';
      // locationId vars deliberately unset

      const r = await get('/api/health');
      expect(r.body.services.ghl.status).toBe('not-configured');
      expect(r.body.services.ghl.details).toMatch(/LOCATION_ID|locationId/i);
    });

    it('WhatsApp: PHONE_NUMBER_ID set but ACCESS_TOKEN missing → degraded (partial)', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone_123';
      // ACCESS_TOKEN deliberately unset

      const r = await get('/api/health');
      expect(r.body.services.whatsapp.status).toBe('degraded');
      expect(r.body.services.whatsapp.details).toMatch(/partial/i);
    });

    it('Gmail: OAuth client set but refresh token missing → degraded', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);
      process.env.GMAIL_CLIENT_ID     = 'g_id';
      process.env.GMAIL_CLIENT_SECRET = 'g_sec';
      // GMAIL_REFRESH_TOKEN deliberately unset

      const r = await get('/api/health');
      expect(r.body.services.gmail.status).toBe('degraded');
      expect(r.body.services.gmail.details).toMatch(/refresh-gmail-oauth/i);
    });

    it('iCal: no bookings ever imported → unknown (not error — fresh deployment)', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);

      const r = await get('/api/health');
      expect(r.body.services.ical.status).toBe('unknown');
    });
  });

  describe('endpoint contract', () => {
    it('does not require auth — public endpoint by design', async () => {
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);
      const r = await get('/api/health');
      expect(r.status).not.toBe(401);
    });

    it('does not leak secrets — no raw env values in response', async () => {
      // Defense-in-depth: even if a future dev does process.env.GHL_API_KEY
      // by mistake in a status detail, the test catches it.
      stubs.queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      stubs.bookingFindFirst.mockResolvedValue(null);
      process.env.GHL_API_KEY    = 'pit-secret-do-not-leak';
      process.env.GHL_COMPANY_ID = 'loc_secret';

      const r = await get('/api/health');
      const body = JSON.stringify(r.body);
      expect(body).not.toContain('pit-secret-do-not-leak');
      expect(body).not.toContain('loc_secret');
    });
  });
});
