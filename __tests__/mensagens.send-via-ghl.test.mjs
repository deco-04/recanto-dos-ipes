import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

// Pin the contract (2026-04-29):
//
//   POST /api/staff/conversas/:id/mensagens
//
//   When GHL_API_KEY is configured, the route prefers the GHL Conversations
//   hub: searchConversations() to find the matching ghlConvId by phone tail,
//   then sendMessage() to deliver via GHL's channel routing. The created
//   InboxMessage carries the returned ghlMessageId so the 2-min poll won't
//   re-mirror it as a duplicate.
//
//   Fallback rules (use the legacy direct path):
//     - GHL_API_KEY unset
//     - GHL search returns 401 (PIT missing scopes)
//     - GHL search returns no matching conversation by phone
//     - GHL sendMessage fails after a successful search
//
// Approach: routes/mensagens.js + lib/staff-auth-middleware.js are CJS files
// loaded via require(). vitest's `vi.mock` doesn't reliably intercept CJS
// require() calls in transitive deps. We patch Node's CJS module cache
// directly with fake module objects.

const STAFF_ID = 'staff_test_1';
const SECRET   = 'test-secret-mensagens';
process.env.STAFF_JWT_SECRET = SECRET;
const TOKEN    = jwt.sign({ sub: STAFF_ID }, SECRET);

const stubs = {
  staffMemberFindUnique:  vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate:     vi.fn(async () => ({})),
  inboxMessageCreate:     vi.fn(),
  whatsappSendText:       vi.fn(async () => ({ ok: true })),
  ghlSearch:              vi.fn(),
  ghlSend:                vi.fn(),
};

const __filename       = fileURLToPath(import.meta.url);
const __dirname        = path.dirname(__filename);
const projectRoot      = path.resolve(__dirname, '..');
const requireFromHere  = createRequire(import.meta.url);
const ModuleCtor       = requireFromHere('module');

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
    findUnique: (...a) => stubs.conversationFindUnique(...a),
    update:     (...a) => stubs.conversationUpdate(...a),
  },
  inboxMessage: { create: (...a) => stubs.inboxMessageCreate(...a) },
};
const fakeGhlConv = {
  searchConversations: (...a) => stubs.ghlSearch(...a),
  sendMessage:         (...a) => stubs.ghlSend(...a),
};
const fakeWhatsapp = {
  sendText:           (...a) => stubs.whatsappSendText(...a),
  sendTemplate:       vi.fn(async () => ({ ok: true })),
  sendCheckinWelcome: vi.fn(),
};
const fakeGhlWebhook = {
  sendInstagramDM:       vi.fn(),
  sendGuestListReminder: vi.fn(),
  sendWhatsAppMessage:   vi.fn(),
};
const fakeMailer = {
  sendInboxEmail: vi.fn(async () => true),
};

injectFakeCjsModule(path.join(projectRoot, 'lib/db.js'),                fakePrisma);
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-conversations.js'), fakeGhlConv);
injectFakeCjsModule(path.join(projectRoot, 'lib/whatsapp.js'),          fakeWhatsapp);
injectFakeCjsModule(path.join(projectRoot, 'lib/ghl-webhook.js'),       fakeGhlWebhook);
injectFakeCjsModule(path.join(projectRoot, 'lib/mailer.js'),            fakeMailer);

let server;
let port;
let mensagensRouter;

async function startApp() {
  const imported = requireFromHere(path.join(projectRoot, 'routes/mensagens.js'));
  mensagensRouter = imported.default || imported;

  const app = express();
  app.use(express.json());
  app.use('/api/staff/conversas', mensagensRouter);

  return new Promise(resolve => {
    server = app.listen(0, () => {
      port = server.address().port;
      resolve();
    });
  });
}

function postJson(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization:    `Bearer ${TOKEN}`,
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

describe('POST /api/staff/conversas/:id/mensagens — GHL hub routing', () => {
  beforeEach(async () => {
    Object.values(stubs).forEach(fn => fn.mockReset());
    // Tests in this suite exercise the direct WhatsApp fallback path.
    // The route now refuses to fall through if WHATSAPP_PHONE_NUMBER_ID
    // is unset (returns 502 with a clear message instead of stack-tracing
    // on the missing env var). For the legacy direct-path scenarios to
    // remain testable, set a fake phone-number-id here.
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test_wa_phone_id';

    stubs.staffMemberFindUnique.mockImplementation(async ({ select }) => {
      if (select?.role) {
        return { id: STAFF_ID, name: 'Tester', email: 't@x.com', role: 'ADMIN', active: true };
      }
      return { id: STAFF_ID, name: 'Tester', emailSignature: null };
    });
    stubs.conversationFindUnique.mockResolvedValue({
      id: 'conv_1',
      contactPhone: '+5531991234567',
      contactEmail: null,
      contactInstagram: null,
    });
    stubs.conversationUpdate.mockResolvedValue({});
    stubs.inboxMessageCreate.mockImplementation(async ({ data }) => ({
      id: 'msg_new',
      ...data,
      staff: { name: 'Tester' },
    }));

    if (!server) await startApp();
  });

  afterEach(() => {
    delete process.env.GHL_API_KEY;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  });

  it('GHL_API_KEY unset → falls through to direct WhatsApp path (no GHL search)', async () => {
    delete process.env.GHL_API_KEY;

    const r = await postJson('/api/staff/conversas/conv_1/mensagens', {
      channel: 'WHATSAPP',
      body:    'oi',
    });
    expect(r.status).toBe(200);
    expect(stubs.ghlSearch).not.toHaveBeenCalled();
    expect(stubs.whatsappSendText).toHaveBeenCalledWith('+5531991234567', 'oi');
    const createArgs = stubs.inboxMessageCreate.mock.calls[0][0].data;
    expect(createArgs.ghlMessageId).toBeUndefined();
    expect(createArgs.direction).toBe('OUTBOUND');
  });

  it('GHL_API_KEY set + search 200 + send 200 → InboxMessage created with ghlMessageId, direct WA NOT called', async () => {
    process.env.GHL_API_KEY = 'pit_test';
    stubs.ghlSearch.mockResolvedValue({
      ok: true,
      conversations: [
        { id: 'ghl_conv_x', phone: '+55 (31) 99123-4567', contactId: 'contact_1' },
      ],
    });
    stubs.ghlSend.mockResolvedValue({ ok: true, messageId: 'ghl_msg_999' });

    const r = await postJson('/api/staff/conversas/conv_1/mensagens', {
      channel: 'WHATSAPP',
      body:    'enviado via GHL',
    });
    expect(r.status).toBe(200);
    expect(stubs.ghlSearch).toHaveBeenCalled();
    expect(stubs.ghlSend).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'ghl_conv_x',
      type:           'WhatsApp',
      body:           'enviado via GHL',
    }));
    expect(stubs.whatsappSendText).not.toHaveBeenCalled();
    const createArgs = stubs.inboxMessageCreate.mock.calls[0][0].data;
    expect(createArgs.ghlMessageId).toBe('ghl_msg_999');
    expect(createArgs.channel).toBe('WHATSAPP');
  });

  it('GHL_API_KEY set + search 401 → falls back to direct path with warning', async () => {
    process.env.GHL_API_KEY = 'pit_test';
    stubs.ghlSearch.mockResolvedValue({
      ok: false, status: 401, error: 'unauthorized', conversations: [],
    });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await postJson('/api/staff/conversas/conv_1/mensagens', {
      channel: 'WHATSAPP',
      body:    'fallback',
    });
    expect(r.status).toBe(200);
    expect(stubs.ghlSend).not.toHaveBeenCalled();
    expect(stubs.whatsappSendText).toHaveBeenCalledWith('+5531991234567', 'fallback');
    const createArgs = stubs.inboxMessageCreate.mock.calls[0][0].data;
    expect(createArgs.ghlMessageId).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('PIT missing scopes')
    );
  });

  it('GHL search OK but no matching phone → falls back to direct', async () => {
    process.env.GHL_API_KEY = 'pit_test';
    stubs.ghlSearch.mockResolvedValue({
      ok: true,
      conversations: [{ id: 'ghl_other', phone: '+5511555555555' }],
    });

    const r = await postJson('/api/staff/conversas/conv_1/mensagens', {
      channel: 'WHATSAPP',
      body:    'no match',
    });
    expect(r.status).toBe(200);
    expect(stubs.ghlSend).not.toHaveBeenCalled();
    expect(stubs.whatsappSendText).toHaveBeenCalled();
  });

  it('GHL miss + WHATSAPP_PHONE_NUMBER_ID unset → 502 with useful error (no stack-trace toast)', async () => {
    // RDI's deployment migrated WhatsApp to GHL and unset the direct-Meta
    // env var. Before this guard, the GHL miss would fall through to
    // sendText() which throws "WHATSAPP_PHONE_NUMBER_ID not configured"
    // and surfaces a stack trace toast in the staff app. Now we 502 with
    // a Portuguese message the staff can act on.
    process.env.GHL_API_KEY = 'pit_test';
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    stubs.ghlSearch.mockResolvedValue({
      ok: true,
      conversations: [{ id: 'ghl_other', phone: '+5511555555555' }],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await postJson('/api/staff/conversas/conv_1/mensagens', {
      channel: 'WHATSAPP',
      body:    'no match no fallback',
    });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('GHL_LOOKUP_FAILED_NO_DIRECT_FALLBACK');
    expect(stubs.whatsappSendText).not.toHaveBeenCalled();
  });
});
