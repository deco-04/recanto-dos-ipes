import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createRequire } from 'node:module';

// Gap #9 — cancel-flow reconciliation.
// When admin PATCHes a post out of AGENDADO:
//   - If GHL says the post is already PUBLISHED → 409 + reconcile local stage.
//   - Otherwise → normal cancel path.
//   - GHL unreachable → fail-open (don't block the admin's rollback).
//
// We stub ../lib/db and ../lib/ghl-social via require.cache so the real
// routes/content.js consumes our mocks.

const require_ = createRequire(import.meta.url);

function startApp(router, staff = { id: 'staff-1', role: 'ADMIN' }) {
  const app = express();
  app.use(express.json());
  // Bypass staff auth — routes/content.js protects each route with
  // requireStaff, but we inject a fake req.staff via a parent middleware
  // and short-circuit the auth middleware entirely.
  app.use((req, _res, next) => { req.staff = staff; next(); });
  app.use('/api/staff/conteudo', router);
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function patchJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method:  'PATCH',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
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

describe('PATCH /conteudo/:id — AGENDADO rollback reconciliation (Gap #9)', () => {
  let harness, prismaMock, ghlSocialMock;

  beforeEach(async () => {
    // Fresh mocks per case — no shared state.
    prismaMock = {
      contentPost: {
        findUnique: vi.fn(),
        findFirst:  vi.fn(),
        findMany:   vi.fn(),
        update:     vi.fn(),
        updateMany: vi.fn(),
        count:      vi.fn(),
      },
      property:          { findFirst: vi.fn() },
      brandContentConfig:{ findFirst: vi.fn() },
    };
    ghlSocialMock = {
      schedulePost:         vi.fn(),
      cancelScheduledPost:  vi.fn().mockResolvedValue(undefined),
      getPostStatus:        vi.fn(),
      pickNextScheduledSlot: vi.fn(),
    };

    // Stub the dep modules BEFORE loading the route so `require()` in
    // routes/content.js resolves to our test doubles. We also stub the
    // auth middleware to a pass-through since the test app already
    // injects req.staff.
    const resolveAndInject = (spec, mod) => {
      const resolved = require_.resolve(spec);
      require_.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: mod };
    };
    resolveAndInject('../lib/db', prismaMock);
    resolveAndInject('../lib/ghl-social', ghlSocialMock);
    resolveAndInject('../lib/staff-auth-middleware', {
      requireStaff: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
    });
    // conteudo-agent pulls the real Anthropic SDK transitively — stub it out.
    resolveAndInject('../lib/conteudo-agent', {
      createWeeklyPackage:       vi.fn(),
      regeneratePost:            vi.fn(),
      createImprovedAlternative: vi.fn(),
      createRdiBlogPost:         vi.fn(),
    });
    resolveAndInject('../lib/push', {
      sendPushToRole: vi.fn().mockResolvedValue(0),
      sendPushToUser: vi.fn().mockResolvedValue(0),
      sendPushToStaff: vi.fn().mockResolvedValue(0),
    });
    resolveAndInject('../lib/sync-rds', {
      pushBlogPostToRds: vi.fn().mockResolvedValue({ ok: true }),
    });

    // Drop any stale cached copy of the router so our stubs take effect.
    const routerPath = require_.resolve('../routes/content.js');
    delete require_.cache[routerPath];
    const router = require_('../routes/content.js');

    harness = await startApp(router);
  });

  afterEach(() => {
    harness?.server?.close();
    // Clean the injected stubs so other test files don't see them.
    for (const spec of [
      '../lib/db',
      '../lib/ghl-social',
      '../lib/staff-auth-middleware',
      '../lib/conteudo-agent',
      '../lib/push',
      '../lib/sync-rds',
      '../routes/content.js',
    ]) {
      try { delete require_.cache[require_.resolve(spec)]; } catch {}
    }
    vi.restoreAllMocks();
  });

  it('returns 409 and reconciles local stage when GHL reports the post is PUBLISHED', async () => {
    prismaMock.contentPost.findUnique.mockResolvedValue({
      id: 'p-1', stage: 'AGENDADO', ghlPostId: 'ghl-xyz', publishedAt: null, brand: 'RDI', contentType: 'INSTAGRAM_FEED',
    });
    ghlSocialMock.getPostStatus.mockResolvedValue({
      status: 'PUBLISHED',
      publishedAt: new Date('2026-04-20T12:00:00Z'),
      raw: {},
    });
    prismaMock.contentPost.update.mockResolvedValue({
      id: 'p-1', stage: 'PUBLICADO',
      publishedAt: new Date('2026-04-20T12:00:00Z'),
      brand: 'RDI', contentType: 'INSTAGRAM_FEED',
      ghlPostId: 'ghl-xyz',
      comments: [],
    });

    const r = await patchJson(harness.port, '/api/staff/conteudo/p-1', { stage: 'EM_REVISAO' });

    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/já foi publicado em GHL/);
    expect(r.body.post.stage).toBe('PUBLICADO');

    // Must reconcile — NOT cancel
    expect(ghlSocialMock.cancelScheduledPost).not.toHaveBeenCalled();
    expect(prismaMock.contentPost.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'p-1' },
      data:  expect.objectContaining({
        stage:       'PUBLICADO',
        publishedAt: new Date('2026-04-20T12:00:00Z'),
      }),
    }));
  });

  it('proceeds with cancel when GHL reports SCHEDULED (post not yet live)', async () => {
    prismaMock.contentPost.findUnique.mockResolvedValue({
      id: 'p-2', stage: 'AGENDADO', ghlPostId: 'ghl-abc', publishedAt: null, brand: 'RDI', contentType: 'INSTAGRAM_FEED',
    });
    ghlSocialMock.getPostStatus.mockResolvedValue({
      status: 'SCHEDULED', publishedAt: null, raw: {},
    });
    prismaMock.contentPost.update.mockResolvedValue({
      id: 'p-2', stage: 'EM_REVISAO', ghlPostId: null, brand: 'RDI', contentType: 'INSTAGRAM_FEED',
      comments: [],
    });

    const r = await patchJson(harness.port, '/api/staff/conteudo/p-2', { stage: 'EM_REVISAO' });

    expect(r.status).toBe(200);
    expect(ghlSocialMock.cancelScheduledPost).toHaveBeenCalledWith('ghl-abc');
    expect(prismaMock.contentPost.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'p-2' },
      data:  expect.objectContaining({ stage: 'EM_REVISAO', ghlPostId: null }),
    }));
  });

  it('fails open when GHL is unreachable — still cancels (admin rollback not blocked)', async () => {
    prismaMock.contentPost.findUnique.mockResolvedValue({
      id: 'p-3', stage: 'AGENDADO', ghlPostId: 'ghl-timeout', publishedAt: null, brand: 'RDI', contentType: 'INSTAGRAM_FEED',
    });
    ghlSocialMock.getPostStatus.mockRejectedValue(new Error('ECONNRESET'));
    prismaMock.contentPost.update.mockResolvedValue({
      id: 'p-3', stage: 'EM_REVISAO', ghlPostId: null, brand: 'RDI', contentType: 'INSTAGRAM_FEED',
      comments: [],
    });

    const r = await patchJson(harness.port, '/api/staff/conteudo/p-3', { stage: 'EM_REVISAO' });

    expect(r.status).toBe(200);
    expect(ghlSocialMock.cancelScheduledPost).toHaveBeenCalledWith('ghl-timeout');
  });

  it('skips GHL reconciliation entirely for posts without a ghlPostId', async () => {
    prismaMock.contentPost.findUnique.mockResolvedValue({
      id: 'p-4', stage: 'AGENDADO', ghlPostId: null, publishedAt: null, brand: 'RDI', contentType: 'INSTAGRAM_FEED',
    });
    prismaMock.contentPost.update.mockResolvedValue({
      id: 'p-4', stage: 'APROVADO', brand: 'RDI', contentType: 'INSTAGRAM_FEED', comments: [],
    });

    const r = await patchJson(harness.port, '/api/staff/conteudo/p-4', { stage: 'EM_REVISAO' });

    expect(r.status).toBe(200);
    expect(ghlSocialMock.getPostStatus).not.toHaveBeenCalled();
    expect(ghlSocialMock.cancelScheduledPost).not.toHaveBeenCalled();
  });
});
