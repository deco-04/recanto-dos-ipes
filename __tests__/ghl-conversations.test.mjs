import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-29):
//
//   GHL Conversations Hub mirror helper.
//
//   mapGhlMessageType(type) → 'WHATSAPP' | 'INSTAGRAM' | 'FACEBOOK' | 'GBP' | 'EMAIL' | null
//   mirrorGhlMessage({ ghlMessage, conversation, prismaClient })
//     → idempotent on ghlMessageId @unique
//     → outbound + null userId → isAiAgent=true
//     → outbound + non-null userId → isAiAgent=false (human in GHL UI)
//     → inbound → direction=INBOUND
//     → invalid payload (no id or no body) → skipped
//     → unknown channel → skipped
//
//   Pure function — no env, no fetch, no cron.

const require_ = createRequire(import.meta.url);
const { mapGhlMessageType, mirrorGhlMessage } = require_('../lib/ghl-conversations-mirror.js');

function makePrisma({ existing = null } = {}) {
  return {
    inboxMessage: {
      findUnique: vi.fn(async () => existing),
      create:     vi.fn(async ({ data }) => ({ id: 'inbox_new', ...data })),
    },
  };
}

const baseConv = { id: 'conv_1', contactPhone: '+5531991234567' };

describe('mapGhlMessageType', () => {
  it('maps every supported channel and returns null for unknown', () => {
    expect(mapGhlMessageType('WhatsApp')).toBe('WHATSAPP');
    expect(mapGhlMessageType('TYPE_WHATSAPP')).toBe('WHATSAPP');
    expect(mapGhlMessageType('IG')).toBe('INSTAGRAM');
    expect(mapGhlMessageType('Instagram')).toBe('INSTAGRAM');
    expect(mapGhlMessageType('FB')).toBe('FACEBOOK');
    expect(mapGhlMessageType('Facebook')).toBe('FACEBOOK');
    expect(mapGhlMessageType('GMB')).toBe('GBP');
    expect(mapGhlMessageType('GoogleMyBusiness')).toBe('GBP');
    expect(mapGhlMessageType('Email')).toBe('EMAIL');
    expect(mapGhlMessageType('SMS')).toBeNull();
    expect(mapGhlMessageType('CallTranscript')).toBeNull();
    expect(mapGhlMessageType(null)).toBeNull();
    expect(mapGhlMessageType(undefined)).toBeNull();
    expect(mapGhlMessageType('')).toBeNull();
  });
});

describe('mirrorGhlMessage', () => {
  it('skips with reason=invalid-payload when no id', async () => {
    const prismaClient = makePrisma();
    const result = await mirrorGhlMessage({
      ghlMessage: { body: 'oi' },
      conversation: baseConv,
      prismaClient,
    });
    expect(result).toEqual({ mirrored: false, reason: 'invalid-payload' });
    expect(prismaClient.inboxMessage.create).not.toHaveBeenCalled();
  });

  it('skips with reason=invalid-payload when no body', async () => {
    const prismaClient = makePrisma();
    const result = await mirrorGhlMessage({
      ghlMessage: { id: 'ghl_1', messageType: 'WhatsApp' },
      conversation: baseConv,
      prismaClient,
    });
    expect(result).toEqual({ mirrored: false, reason: 'invalid-payload' });
  });

  it('skips with reason=unknown-channel when messageType is SMS', async () => {
    const prismaClient = makePrisma();
    const result = await mirrorGhlMessage({
      ghlMessage: { id: 'ghl_1', body: 'Olá', messageType: 'SMS' },
      conversation: baseConv,
      prismaClient,
    });
    expect(result).toEqual({ mirrored: false, reason: 'unknown-channel' });
    expect(prismaClient.inboxMessage.create).not.toHaveBeenCalled();
  });

  it('skips with reason=already-mirrored when ghlMessageId exists in DB', async () => {
    const prismaClient = makePrisma({ existing: { id: 'inbox_existing' } });
    const result = await mirrorGhlMessage({
      ghlMessage: { id: 'ghl_dup', body: 'Oi', messageType: 'WhatsApp', direction: 'outbound' },
      conversation: baseConv,
      prismaClient,
    });
    expect(result).toEqual({ mirrored: false, reason: 'already-mirrored' });
    expect(prismaClient.inboxMessage.findUnique).toHaveBeenCalledWith({
      where: { ghlMessageId: 'ghl_dup' },
      select: { id: true },
    });
    expect(prismaClient.inboxMessage.create).not.toHaveBeenCalled();
  });

  it('outbound + null userId → isAiAgent=true, direction=OUTBOUND', async () => {
    const prismaClient = makePrisma();
    const result = await mirrorGhlMessage({
      ghlMessage: {
        id:          'ghl_ai',
        body:        'Olá! Como posso ajudar?',
        direction:   'outbound',
        messageType: 'WhatsApp',
        userId:      null,
        dateAdded:   '2026-04-29T10:00:00Z',
      },
      conversation: baseConv,
      prismaClient,
    });
    expect(result).toEqual({ mirrored: true });
    expect(prismaClient.inboxMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        conversationId: 'conv_1',
        direction:      'OUTBOUND',
        channel:        'WHATSAPP',
        body:           'Olá! Como posso ajudar?',
        isAiAgent:      true,
        ghlMessageId:   'ghl_ai',
      }),
    }));
  });

  it('outbound + non-null userId → isAiAgent=false (human in GHL UI)', async () => {
    const prismaClient = makePrisma();
    await mirrorGhlMessage({
      ghlMessage: {
        id:          'ghl_human',
        body:        'Resposta da equipe',
        direction:   'outbound',
        messageType: 'IG',
        userId:      'user_123',
        dateAdded:   '2026-04-29T10:30:00Z',
      },
      conversation: baseConv,
      prismaClient,
    });
    const callArgs = prismaClient.inboxMessage.create.mock.calls[0][0];
    expect(callArgs.data.direction).toBe('OUTBOUND');
    expect(callArgs.data.isAiAgent).toBe(false);
    expect(callArgs.data.channel).toBe('INSTAGRAM');
  });

  it('inbound → direction=INBOUND, isAiAgent=false regardless of userId', async () => {
    const prismaClient = makePrisma();
    await mirrorGhlMessage({
      ghlMessage: {
        id:          'ghl_in',
        body:        'Oi, vocês têm vaga?',
        direction:   'inbound',
        messageType: 'WhatsApp',
        userId:      null,
      },
      conversation: baseConv,
      prismaClient,
    });
    const callArgs = prismaClient.inboxMessage.create.mock.calls[0][0];
    expect(callArgs.data.direction).toBe('INBOUND');
    expect(callArgs.data.isAiAgent).toBe(false);
  });

  it('falls back to new Date() when dateAdded missing', async () => {
    const prismaClient = makePrisma();
    const before = Date.now();
    await mirrorGhlMessage({
      ghlMessage: {
        id:          'ghl_no_ts',
        body:        'sem timestamp',
        direction:   'outbound',
        messageType: 'WhatsApp',
      },
      conversation: baseConv,
      prismaClient,
    });
    const after = Date.now();
    const sentAt = prismaClient.inboxMessage.create.mock.calls[0][0].data.sentAt;
    expect(sentAt).toBeInstanceOf(Date);
    expect(sentAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(sentAt.getTime()).toBeLessThanOrEqual(after);
  });
});
