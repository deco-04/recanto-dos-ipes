// Tests for the Nova Conversa flow shipped 2026-04-30:
//
//   POST /api/staff/conversas
//     channel=WHATSAPP + GHL_API_KEY set →
//       1. ghlConv.upsertContact({ phone, firstName, lastName })
//       2. ghlConv.sendMessage({ type: 'WhatsApp', body, contactId })
//       3. InboxMessage.create with ghlMessageId stamped (so the 2-min poll
//          doesn't re-mirror our own message)
//
//   Failure paths:
//     - upsertContact returns { ok: false } → 502 GHL_UPSERT_FAILED
//     - sendMessage returns { ok: false }   → 502 GHL_SEND_FAILED
//     - GHL_API_KEY unset + WHATSAPP_PHONE_NUMBER_ID unset → 502 NO_WA_BACKEND
//
// These pin the contract per the I3 roadmap item: a regression here would
// either (a) silently route through the broken legacy Meta path, throwing
// "WHATSAPP_PHONE_NUMBER_ID not configured" as a stack-trace toast, or
// (b) skip the ghlMessageId stamp and trigger a duplicate when the cron polls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const STAFF_ID = 'staff_test_nova_1';
const SECRET   = 'test-secret-nova';
process.env.STAFF_JWT_SECRET = SECRET;
const TOKEN    = jwt.sign({ sub: STAFF_ID }, SECRET);

const stubs = {
  staffMemberFindUnique:   vi.fn(),
  propertyFindFirst:       vi.fn(),
  conversationFindFirst:   vi.fn(),
  conversationCreate:      vi.fn(),
  conversationUpdate:      vi.fn(async () => ({})),
  inboxMessageCreate:      vi.fn(),
  ghlUpsertContact:        vi.fn(),
  ghlSendMessage:          vi.fn(),
  whatsappSendText:        vi.fn(async () => ({ ok: true })),
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
  property:     { findFirst:  (...a) => stubs.propertyFindFirst(...a) },
  conversation: {
    findFirst: (...a) => stubs.conversationFindFirst(...a),
    create:    (...a) => stubs.conversationCreate(...a),
    update:    (...a) => stubs.conversationUpdate(...a),
  },
  inboxMessage: { create: (...a) => stubs.inboxMessageCreate(...a) },
};
injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'), fakePrisma);
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-conversations.js'), {
  upsertContact:           (...a) => stubs.ghlUpsertContact(...a),
  sendMessage:             (...a) => stubs.ghlSendMessage(...a),
  searchConversations:     vi.fn(),
  getConversationMessages: vi.fn(),
});
injectFakeCjsModule(path.join(projectRoot, 'lib/whatsapp.js'), {
  sendText:     (...a) => stubs.whatsappSendText(...a),
  sendTemplate: vi.fn(),
});
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-webhook.js'), { sendInstagramDM: vi.fn() });
injectFakeCjsModule(path.join(projectRoot, 'lib/mailer.js'),      { sendInboxEmail: vi.fn() });

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

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization:    `Bearer ${TOKEN}`,
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

describe('POST /api/staff/conversas — Nova Conversa via GHL hub', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset && fn.mockReset());
    stubs.staffMemberFindUnique.mockImplementation(async ({ select }) => {
      if (select?.role) return { id: STAFF_ID, role: 'ADMIN', active: true, name: 'Tester', email: 't@x.com' };
      return { id: STAFF_ID, name: 'Tester', emailSignature: null };
    });
    stubs.propertyFindFirst.mockResolvedValue({ id: 'prop_1', name: 'Sítio Recanto dos Ipês' });
    stubs.conversationFindFirst.mockResolvedValue(null); // brand new contact
    stubs.conversationCreate.mockImplementation(async ({ data }) => ({ id: 'conv_new', ...data, messages: [] }));
    stubs.conversationUpdate.mockResolvedValue({});
    stubs.inboxMessageCreate.mockImplementation(async ({ data }) => ({
      id: 'msg_new', ...data, staff: { name: 'Tester' },
    }));

    process.env.GHL_API_KEY = 'pit_test';
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!server) await startApp();
  });

  it('201 happy path — upsertContact → sendMessage → InboxMessage carries ghlMessageId', async () => {
    stubs.ghlUpsertContact.mockResolvedValue({ ok: true, contactId: 'ghl_c_1', isNew: true });
    stubs.ghlSendMessage.mockResolvedValue({ ok: true, messageId: 'ghl_msg_1' });

    const r = await postJson('/api/staff/conversas', {
      contactName:  'Maria Silva',
      contactPhone: '+5531999990000',
      channel:      'WHATSAPP',
      body:         'Olá Maria! 👋',
    });

    expect(r.status).toBe(201);
    expect(stubs.ghlUpsertContact).toHaveBeenCalledWith(expect.objectContaining({
      phone:     '+5531999990000',
      firstName: 'Maria',
      lastName:  'Silva',
    }));
    expect(stubs.ghlSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type:      'WhatsApp',
      body:      'Olá Maria! 👋',
      contactId: 'ghl_c_1',
    }));
    expect(stubs.whatsappSendText).not.toHaveBeenCalled();
    // Critical: ghlMessageId must be stamped on the InboxMessage row so the
    // 2-min OUTBOUND mirror cron can dedup against it.
    const createArgs = stubs.inboxMessageCreate.mock.calls[0][0].data;
    expect(createArgs.ghlMessageId).toBe('ghl_msg_1');
    expect(createArgs.direction).toBe('OUTBOUND');
    expect(createArgs.channel).toBe('WHATSAPP');
  });

  it('502 GHL_UPSERT_FAILED when contact upsert fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubs.ghlUpsertContact.mockResolvedValue({ ok: false, status: 401, error: 'unauthorized' });

    const r = await postJson('/api/staff/conversas', {
      contactName: 'Test', contactPhone: '+5531999990000', channel: 'WHATSAPP', body: 'oi',
    });

    expect(r.status).toBe(502);
    expect(r.body.code).toBe('GHL_UPSERT_FAILED');
    expect(stubs.ghlSendMessage).not.toHaveBeenCalled();
    expect(stubs.inboxMessageCreate).not.toHaveBeenCalled();
  });

  it('502 GHL_SEND_FAILED when contact upsert succeeds but send fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubs.ghlUpsertContact.mockResolvedValue({ ok: true, contactId: 'ghl_c_2' });
    stubs.ghlSendMessage.mockResolvedValue({ ok: false, status: 422, error: 'invalid' });

    const r = await postJson('/api/staff/conversas', {
      contactName: 'Test', contactPhone: '+5531999990000', channel: 'WHATSAPP', body: 'oi',
    });

    expect(r.status).toBe(502);
    expect(r.body.code).toBe('GHL_SEND_FAILED');
    expect(r.body.ghlError).toBe('invalid');
    expect(stubs.inboxMessageCreate).not.toHaveBeenCalled();
  });

  it('502 NO_WA_BACKEND when neither GHL nor Meta direct path is configured', async () => {
    delete process.env.GHL_API_KEY;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;

    const r = await postJson('/api/staff/conversas', {
      contactName: 'Test', contactPhone: '+5531999990000', channel: 'WHATSAPP', body: 'oi',
    });

    expect(r.status).toBe(502);
    expect(r.body.code).toBe('NO_WA_BACKEND');
    expect(stubs.ghlUpsertContact).not.toHaveBeenCalled();
    expect(stubs.whatsappSendText).not.toHaveBeenCalled();
  });

  it('legacy direct path: GHL_API_KEY unset + WHATSAPP_PHONE_NUMBER_ID set → calls Meta direct sendText', async () => {
    delete process.env.GHL_API_KEY;
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'meta_phone_id_test';

    const r = await postJson('/api/staff/conversas', {
      contactName: 'Test', contactPhone: '+5531999990000', channel: 'WHATSAPP', body: 'oi',
    });

    expect(r.status).toBe(201);
    expect(stubs.whatsappSendText).toHaveBeenCalledWith('+5531999990000', 'oi');
    expect(stubs.ghlUpsertContact).not.toHaveBeenCalled();
    // No GHL message id available on this path → row should NOT have ghlMessageId set
    const createArgs = stubs.inboxMessageCreate.mock.calls[0][0].data;
    expect(createArgs.ghlMessageId).toBeUndefined();
  });

  it('reuses existing conversation when one already exists for the phone', async () => {
    // Idempotency: hitting POST /api/staff/conversas with a phone that
    // already has a thread should NOT create a duplicate Conversation row.
    stubs.conversationFindFirst.mockResolvedValue({
      id: 'conv_existing', contactName: 'Maria', contactPhone: '+5531999990000',
    });
    stubs.ghlUpsertContact.mockResolvedValue({ ok: true, contactId: 'ghl_c_dup' });
    stubs.ghlSendMessage.mockResolvedValue({ ok: true, messageId: 'ghl_msg_dup' });

    const r = await postJson('/api/staff/conversas', {
      contactName: 'Maria', contactPhone: '+5531999990000', channel: 'WHATSAPP', body: 'follow-up',
    });

    expect(r.status).toBe(201);
    expect(stubs.conversationCreate).not.toHaveBeenCalled();
    expect(stubs.inboxMessageCreate.mock.calls[0][0].data.conversationId).toBe('conv_existing');
  });
});
