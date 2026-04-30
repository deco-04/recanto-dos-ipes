// Tests for the soft-delete inbox flow shipped 2026-04-30:
//
//   DELETE  /api/staff/conversas/:id        → status = DELETED
//   GET     /api/staff/conversas            → filters out DELETED
//   GET     /api/staff/conversas?status=ALL → still filters DELETED
//   GET     /api/staff/conversas/unread-count → excludes DELETED from aggregate
//
// Pinning these now (per the holistic-roadmap I3 item) so a future refactor
// can't silently let deleted conversations resurface in the inbox or inflate
// the unread badge — both regressions would erode trust in the delete action.
//
// Same CJS-cache injection pattern as mensagens.send-via-ghl.test.mjs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const STAFF_ID = 'staff_test_delete_1';
const SECRET   = 'test-secret-delete';
process.env.STAFF_JWT_SECRET = SECRET;
const TOKEN    = jwt.sign({ sub: STAFF_ID }, SECRET);

const stubs = {
  staffMemberFindUnique:  vi.fn(),
  conversationUpdate:     vi.fn(),
  conversationFindMany:   vi.fn(),
  conversationCount:      vi.fn(),
  conversationAggregate:  vi.fn(),
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
  conversation: {
    update:     (...a) => stubs.conversationUpdate(...a),
    findMany:   (...a) => stubs.conversationFindMany(...a),
    count:      (...a) => stubs.conversationCount(...a),
    aggregate:  (...a) => stubs.conversationAggregate(...a),
  },
};
// Other libs not exercised by these routes — stub minimally.
injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'),                fakePrisma);
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-conversations.js'), {
  searchConversations: vi.fn(), sendMessage: vi.fn(), upsertContact: vi.fn(), getConversationMessages: vi.fn(),
});
injectFakeCjsModule(path.join(projectRoot, 'lib/whatsapp.js'),          { sendText: vi.fn(), sendTemplate: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-webhook.js'),       { sendInstagramDM: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/mailer.js'),            { sendInboxEmail: vi.fn() });

let server;
let port;

async function startApp() {
  const imported = requireFromHere(path.join(projectRoot, 'routes/mensagens.js'));
  const router   = imported.default || imported;
  const app = express();
  app.use(express.json());
  app.use('/api/staff/conversas', router);
  return new Promise(resolve => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bearer ${TOKEN}`,
      ...(payload ? {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      } : {}),
    };
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Inbox soft-delete — DELETE /api/staff/conversas/:id', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    stubs.staffMemberFindUnique.mockImplementation(async ({ select }) => {
      if (select?.role) return { id: STAFF_ID, role: 'ADMIN', active: true, name: 'Tester', email: 't@x.com' };
      return { id: STAFF_ID, name: 'Tester', emailSignature: null };
    });
    if (!server) await startApp();
  });

  it('200 happy path → flips status to DELETED', async () => {
    stubs.conversationUpdate.mockResolvedValue({ id: 'conv_1', status: 'DELETED' });
    const r = await request('DELETE', '/api/staff/conversas/conv_1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id: 'conv_1', status: 'DELETED' });
    // Verify the update payload — must set status to the DELETED enum value,
    // not a string approximation, so the Postgres enum constraint is satisfied.
    expect(stubs.conversationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conv_1' },
      data:  { status: 'DELETED' },
    }));
  });

  it('404 when conversation does not exist (Prisma P2025)', async () => {
    const err = new Error('Record to update not found.');
    err.code = 'P2025';
    stubs.conversationUpdate.mockRejectedValue(err);
    const r = await request('DELETE', '/api/staff/conversas/conv_missing');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/não encontrada/i);
  });

  it('500 with generic error message on unexpected DB failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubs.conversationUpdate.mockRejectedValue(new Error('connection lost'));
    const r = await request('DELETE', '/api/staff/conversas/conv_1');
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/erro ao excluir/i);
  });
});

describe('Inbox listing — DELETED filter', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    stubs.staffMemberFindUnique.mockImplementation(async ({ select }) => {
      if (select?.role) return { id: STAFF_ID, role: 'ADMIN', active: true, name: 'Tester', email: 't@x.com' };
      return { id: STAFF_ID, name: 'Tester', emailSignature: null };
    });
    stubs.conversationFindMany.mockResolvedValue([]);
    stubs.conversationCount.mockResolvedValue(0);
    if (!server) await startApp();
  });

  it('default (no status param) → where.status = OPEN — already excludes DELETED', async () => {
    await request('GET', '/api/staff/conversas');
    const findArgs = stubs.conversationFindMany.mock.calls[0][0];
    expect(findArgs.where.status).toBe('OPEN');
  });

  it('?status=ALL → where.status = { not: DELETED } so soft-deleted threads are hidden', async () => {
    // Real-world failure mode this guards against: an admin opening an "all
    // conversations" view and seeing the threads they just deleted reappear.
    await request('GET', '/api/staff/conversas?status=ALL');
    const findArgs = stubs.conversationFindMany.mock.calls[0][0];
    expect(findArgs.where.status).toEqual({ not: 'DELETED' });
  });

  it('?status=DELETED → where.status = DELETED for explicit recovery view', async () => {
    // This is intentional — an admin "trash bin" view (planned in I2) needs
    // to be able to ask explicitly for deleted threads.
    await request('GET', '/api/staff/conversas?status=DELETED');
    const findArgs = stubs.conversationFindMany.mock.calls[0][0];
    expect(findArgs.where.status).toBe('DELETED');
  });
});

describe('Inbox unread-count — DELETED exclusion', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    stubs.staffMemberFindUnique.mockImplementation(async ({ select }) => {
      if (select?.role) return { id: STAFF_ID, role: 'ADMIN', active: true, name: 'Tester', email: 't@x.com' };
      return { id: STAFF_ID, name: 'Tester', emailSignature: null };
    });
    stubs.conversationAggregate.mockResolvedValue({ _sum: { unreadCount: 7 } });
    if (!server) await startApp();
  });

  it('aggregate where clause excludes DELETED so badge does not include hidden threads', async () => {
    // Without this, staff could "delete" unread conversations to clear the
    // badge — defeating the purpose of the unread counter.
    const r = await request('GET', '/api/staff/conversas/unread-count');
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(7);
    const aggArgs = stubs.conversationAggregate.mock.calls[0][0];
    expect(aggArgs.where).toEqual({ status: { not: 'DELETED' } });
  });

  it('null aggregate result returns count: 0 (Prisma returns null when zero rows match)', async () => {
    stubs.conversationAggregate.mockResolvedValue({ _sum: { unreadCount: null } });
    const r = await request('GET', '/api/staff/conversas/unread-count');
    expect(r.body.count).toBe(0);
  });
});
