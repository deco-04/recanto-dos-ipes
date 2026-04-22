import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createGhlSocialWebhookRouter } from '../routes/ghl-social-webhook.js';

// In-process Express test driver — no supertest dep needed; we just hit the
// router with a tiny `request()` that POSTs through Node's http server.
import http from 'node:http';

function startApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks/ghl-social', router);
  return new Promise(resolve => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function postJson(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
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

describe('POST /api/webhooks/ghl-social — publish callback (Gap #4)', () => {
  const SECRET = 'test-secret-abc';
  let prisma, harness;

  beforeEach(async () => {
    process.env.GHL_WEBHOOK_SECRET = SECRET;

    prisma = {
      contentPost: {
        findFirst: vi.fn(),
        update:    vi.fn(),
      },
    };

    const router = createGhlSocialWebhookRouter({
      prisma,
      now: () => new Date('2026-04-21T15:00:00Z'),
    });
    harness = await startApp(router);
  });

  // Tear-down — close the ephemeral server after each case so port doesn't leak.
  afterEach(() => harness?.server?.close());

  it('rejects with 401 when the secret is missing or wrong', async () => {
    const r = await postJson(harness.port, '/api/webhooks/ghl-social', {
      postId: 'ghl-1', status: 'PUBLISHED',
    });
    expect(r.status).toBe(401);
    expect(prisma.contentPost.findFirst).not.toHaveBeenCalled();

    const r2 = await postJson(
      harness.port,
      '/api/webhooks/ghl-social?secret=wrong',
      { postId: 'ghl-1', status: 'PUBLISHED' },
    );
    expect(r2.status).toBe(401);
  });

  it('happy path — flips AGENDADO → PUBLICADO, stamps publishedAt, returns 200', async () => {
    prisma.contentPost.findFirst.mockResolvedValue({
      id: 'post-42', ghlPostId: 'ghl-1', stage: 'AGENDADO', publishedAt: null,
    });
    prisma.contentPost.update.mockResolvedValue({
      id: 'post-42', stage: 'PUBLICADO',
    });

    const r = await postJson(
      harness.port,
      `/api/webhooks/ghl-social?secret=${SECRET}`,
      { postId: 'ghl-1', status: 'PUBLISHED' },
    );

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.stage).toBe('PUBLICADO');

    expect(prisma.contentPost.update).toHaveBeenCalledWith({
      where: { id: 'post-42' },
      data:  {
        stage:       'PUBLICADO',
        publishedAt: new Date('2026-04-21T15:00:00Z'),
      },
    });
  });

  it('uses publishedAt from the body when GHL provides one', async () => {
    prisma.contentPost.findFirst.mockResolvedValue({
      id: 'p', ghlPostId: 'ghl-1', stage: 'AGENDADO', publishedAt: null,
    });
    prisma.contentPost.update.mockResolvedValue({ id: 'p', stage: 'PUBLICADO' });

    await postJson(
      harness.port,
      `/api/webhooks/ghl-social?secret=${SECRET}`,
      { postId: 'ghl-1', status: 'PUBLISHED', publishedAt: '2026-04-22T08:30:00Z' },
    );

    expect(prisma.contentPost.update).toHaveBeenCalledWith({
      where: { id: 'p' },
      data:  expect.objectContaining({
        publishedAt: new Date('2026-04-22T08:30:00Z'),
      }),
    });
  });

  it('skips when GHL reports a non-publish status (e.g. SCHEDULED, FAILED)', async () => {
    const r = await postJson(
      harness.port,
      `/api/webhooks/ghl-social?secret=${SECRET}`,
      { postId: 'ghl-1', status: 'SCHEDULED' },
    );

    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(true);
    expect(prisma.contentPost.findFirst).not.toHaveBeenCalled();
    expect(prisma.contentPost.update).not.toHaveBeenCalled();
  });

  it('idempotent — re-firing for an already-PUBLICADO post does not double-update', async () => {
    prisma.contentPost.findFirst.mockResolvedValue({
      id: 'post-42', ghlPostId: 'ghl-1', stage: 'PUBLICADO',
      publishedAt: new Date('2026-04-20T10:00:00Z'),
    });

    const r = await postJson(
      harness.port,
      `/api/webhooks/ghl-social?secret=${SECRET}`,
      { postId: 'ghl-1', status: 'PUBLISHED' },
    );

    expect(r.status).toBe(200);
    expect(r.body.alreadyPublished).toBe(true);
    expect(prisma.contentPost.update).not.toHaveBeenCalled();
  });

  it('returns ok:true even when no ContentPost matches (avoids GHL retries)', async () => {
    prisma.contentPost.findFirst.mockResolvedValue(null);

    const r = await postJson(
      harness.port,
      `/api/webhooks/ghl-social?secret=${SECRET}`,
      { postId: 'unknown-ghl-id', status: 'PUBLISHED' },
    );

    expect(r.status).toBe(200);
    expect(r.body.skipped).toBe(true);
    expect(prisma.contentPost.update).not.toHaveBeenCalled();
  });

  it('400 when postId is absent', async () => {
    const r = await postJson(
      harness.port,
      `/api/webhooks/ghl-social?secret=${SECRET}`,
      { status: 'PUBLISHED' },
    );
    expect(r.status).toBe(400);
  });

  it('accepts the secret via x-webhook-secret header (alternative to query)', async () => {
    prisma.contentPost.findFirst.mockResolvedValue({
      id: 'p', ghlPostId: 'g', stage: 'AGENDADO', publishedAt: null,
    });
    prisma.contentPost.update.mockResolvedValue({ id: 'p', stage: 'PUBLICADO' });

    const r = await postJson(
      harness.port,
      '/api/webhooks/ghl-social',
      { postId: 'g', status: 'PUBLISHED' },
      { 'x-webhook-secret': SECRET },
    );

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

