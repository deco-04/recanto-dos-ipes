import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-28):
//
//   AI smart-reply / FAQ bot for inbound guest WhatsApp messages.
//
//   When a guest WA message lands in the inbox, lib/smart-reply::maybeAutoReply
//   either auto-responds with a clearly-factual FAQ answer (WiFi, check-in time,
//   emergency, rules, pet) OR escalates to staff. Default OFF — opt-in per
//   property via Property.smartReplyEnabled.
//
//   Guard rails:
//     - 5-min cooldown after each AI reply (no bot-loop)
//     - confidence > 0.85 + category != 'ESCALATE' required to reply
//     - Claude returning malformed JSON → log + skip silently
//     - sendText errors → log + skip
//
//   The real lib/whatsapp::sendText does NOT mirror an InboxMessage row, so
//   maybeAutoReply writes the OUTBOUND InboxMessage itself (isAiAgent=true).

const require_ = createRequire(import.meta.url);
const { maybeAutoReply } = require_('../lib/smart-reply.js');

function makeAnthropicResponse(json) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(json) }],
      })),
    },
  };
}

function makeMalformedAnthropic(rawText) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: rawText }],
      })),
    },
  };
}

function makePrismaStub({ lastMessage = null, booking = null } = {}) {
  return {
    inboxMessage: {
      findFirst: vi.fn(async () => lastMessage),
      create:    vi.fn(async ({ data }) => ({ id: 'inbox_new', ...data })),
    },
    booking: {
      findFirst: vi.fn(async () => booking),
    },
  };
}

const baseProperty = {
  id:                 'prop_rdi',
  name:               'Sítio Recanto dos Ipês',
  smartReplyEnabled:  true,
  accessInfo: {
    wifi:    { ssid: 'RecantoIpes', password: 'verde2026' },
    checkin: { instructions: 'Chave no cofre', emergency: '+55 31 2391-6688', emergencyLabel: 'Caseiro Zé' },
    houseRules: ['Sem festas', 'Pet mediante taxa'],
  },
};

const baseConversation = {
  id:           'conv_1',
  contactPhone: '+5531991234567',
  contactName:  'João Silva',
};

const baseSendText = vi.fn(async () => ({ metaMessageId: 'wamid.123' }));

describe('lib/smart-reply · maybeAutoReply', () => {
  let sendText;

  beforeEach(() => {
    sendText = vi.fn(async () => ({ metaMessageId: 'wamid.X' }));
  });

  it('1. smartReplyEnabled=false → skipped with reason "disabled"', async () => {
    const property = { ...baseProperty, smartReplyEnabled: false };
    const anthropic = makeAnthropicResponse({ shouldReply: true, replyText: 'x', confidence: 0.99, category: 'WIFI' });
    const prismaClient = makePrismaStub();

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'qual a senha do wifi?', channel: 'WHATSAPP' },
      property,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result.replied).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('2. WiFi question + AI shouldReply=true → calls sendText, writes OUTBOUND InboxMessage, returns replied=true', async () => {
    const anthropic = makeAnthropicResponse({
      shouldReply: true,
      replyText:   'Olá! Nossa rede WiFi é "RecantoIpes" e a senha é "verde2026". Qualquer dúvida estamos por aqui!',
      confidence:  0.95,
      category:    'WIFI',
    });
    const prismaClient = makePrismaStub({
      booking: {
        id:        'bk_1',
        guestName: 'João Silva',
        checkIn:   new Date('2026-05-01'),
        nights:    3,
      },
    });

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'qual a senha do wifi?', channel: 'WHATSAPP' },
      property:       baseProperty,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result).toMatchObject({ replied: true, category: 'WIFI' });
    expect(result.replyText).toContain('RecantoIpes');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      '+5531991234567',
      expect.stringContaining('RecantoIpes'),
      'bk_1',
    );
    // Mirrors the OUTBOUND message into the conversation thread (isAiAgent:true).
    expect(prismaClient.inboxMessage.create).toHaveBeenCalledTimes(1);
    const createArg = prismaClient.inboxMessage.create.mock.calls[0][0];
    expect(createArg.data.direction).toBe('OUTBOUND');
    expect(createArg.data.isAiAgent).toBe(true);
    expect(createArg.data.conversationId).toBe('conv_1');
    expect(createArg.data.channel).toBe('WHATSAPP');
  });

  it('3. AI returns category=ESCALATE → no sendText, replied=false, reason=escalated', async () => {
    const anthropic = makeAnthropicResponse({
      shouldReply: false,
      replyText:   null,
      confidence:  0.4,
      category:    'ESCALATE',
    });
    const prismaClient = makePrismaStub();

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'quero modificar minha reserva', channel: 'WHATSAPP' },
      property:       baseProperty,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result.replied).toBe(false);
    expect(result.reason).toBe('escalated');
    expect(sendText).not.toHaveBeenCalled();
    expect(prismaClient.inboxMessage.create).not.toHaveBeenCalled();
  });

  it('4. Last InboxMessage is AI < 5min ago → cooldown (no Claude, no send)', async () => {
    const recent = new Date(Date.now() - 60_000); // 60s ago
    const anthropic = makeAnthropicResponse({ shouldReply: true, replyText: 'x', confidence: 0.99, category: 'WIFI' });
    const prismaClient = makePrismaStub({
      lastMessage: { id: 'm', isAiAgent: true, sentAt: recent, direction: 'OUTBOUND' },
    });

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'qual a senha do wifi?', channel: 'WHATSAPP' },
      property:       baseProperty,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result.replied).toBe(false);
    expect(result.reason).toBe('cooldown');
    expect(anthropic.messages.create).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('5. Claude returns malformed JSON → replied=false, reason=parse-error, no throw', async () => {
    const anthropic = makeMalformedAnthropic('this is not json {{{');
    const prismaClient = makePrismaStub();

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'qual a senha do wifi?', channel: 'WHATSAPP' },
      property:       baseProperty,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result.replied).toBe(false);
    expect(result.reason).toBe('parse-error');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('6. confidence < 0.85 → skipped with reason=low-confidence even if shouldReply=true', async () => {
    const anthropic = makeAnthropicResponse({
      shouldReply: true,
      replyText:   'algo',
      confidence:  0.7,
      category:    'OTHER',
    });
    const prismaClient = makePrismaStub();

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'tem piscina aquecida?', channel: 'WHATSAPP' },
      property:       baseProperty,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result.replied).toBe(false);
    expect(result.reason).toBe('low-confidence');
    expect(sendText).not.toHaveBeenCalled();
  });

  it('7. No matching booking → still proceeds, prompt has fewer fields, replies if confident', async () => {
    const anthropic = makeAnthropicResponse({
      shouldReply: true,
      replyText:   'WiFi: RecantoIpes / verde2026',
      confidence:  0.95,
      category:    'WIFI',
    });
    const prismaClient = makePrismaStub({ booking: null });

    const result = await maybeAutoReply({
      conversation:   baseConversation,
      inboundMessage: { body: 'wifi?', channel: 'WHATSAPP' },
      property:       baseProperty,
      prismaClient,
      anthropic,
      sendText,
    });

    expect(result.replied).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    // bookingId is null when no booking matched
    expect(sendText).toHaveBeenCalledWith('+5531991234567', expect.any(String), null);

    // Prompt does NOT include "Reserva atual" line
    const promptArg = anthropic.messages.create.mock.calls[0][0];
    const userText = promptArg.messages.find(m => m.role === 'user').content;
    expect(userText).not.toContain('Reserva atual');
  });
});
