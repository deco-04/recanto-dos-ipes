import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-29):
//
//   GHL Conversations 2-min poll — pollActiveGhlConversations.
//
//   Walks Conversation rows where:
//     - lastMessageAt within last 24h
//     - has at least one InboxMessage with ghlMessageId (linked to GHL)
//
//   For each: searchConversations() to find ghlConvId by phone tail match,
//   then getConversationMessages() and mirrorGhlMessage() per message.
//
//   Cases:
//     1. No active conversations → { polled: 0, mirrored: 0 }
//     2. 401 from search → logs scope warning, returns { authError: true }
//        and stops the loop (no further GHL calls)
//     3. Search returns matching conversation, getConversationMessages
//        returns 2 outbound messages → both mirrored (count = 2)
//     4. Re-running with same data → InboxMessage.findUnique sees existing
//        ghlMessageId → skipped (idempotent)

const require_ = createRequire(import.meta.url);
const { pollActiveGhlConversations } = require_('../lib/cron.js');

function makeStubs({
  activeConvs = [],
  searchResult,
  messagesResult,
  existingByGhlId = new Set(),
} = {}) {
  return {
    ghlConv: {
      searchConversations:    vi.fn(async () => searchResult),
      getConversationMessages: vi.fn(async () => messagesResult),
    },
    prismaClient: {
      conversation: {
        findMany: vi.fn(async () => activeConvs),
      },
      inboxMessage: {
        findUnique: vi.fn(async ({ where }) =>
          existingByGhlId.has(where.ghlMessageId) ? { id: 'inbox_existing' } : null
        ),
        create: vi.fn(async ({ data }) => ({ id: 'inbox_new', ...data })),
      },
    },
  };
}

describe('cron · pollActiveGhlConversations', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('returns { polled: 0, mirrored: 0 } when no active conversations', async () => {
    const stubs = makeStubs({ activeConvs: [] });
    const result = await pollActiveGhlConversations(stubs);
    expect(result).toEqual({ polled: 0, mirrored: 0 });
    expect(stubs.ghlConv.searchConversations).not.toHaveBeenCalled();
  });

  it('401 from search → logs scope warning and stops the loop', async () => {
    const stubs = makeStubs({
      activeConvs: [
        { id: 'conv_1', contactPhone: '+5531991234567', messages: [] },
        { id: 'conv_2', contactPhone: '+5531998765432', messages: [] },
      ],
      searchResult: { ok: false, status: 401, error: 'unauthorized', conversations: [] },
    });
    const result = await pollActiveGhlConversations(stubs);
    expect(result.authError).toBe(true);
    expect(result.mirrored).toBe(0);
    // Only one search call — break after first auth error
    expect(stubs.ghlConv.searchConversations).toHaveBeenCalledTimes(1);
    expect(stubs.ghlConv.getConversationMessages).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('PIT missing scopes')
    );
  });

  it('mirrors 2 outbound messages when search + messages succeed', async () => {
    const stubs = makeStubs({
      activeConvs: [
        { id: 'conv_1', contactPhone: '+5531991234567', messages: [] },
      ],
      searchResult: {
        ok: true,
        conversations: [
          { id: 'ghl_conv_1', phone: '+55 (31) 99123-4567', contactId: 'contact_1' },
        ],
      },
      messagesResult: {
        ok: true,
        messages: [
          {
            id:          'ghl_msg_1',
            body:        'Olá!',
            direction:   'outbound',
            messageType: 'WhatsApp',
            userId:      null,
            dateAdded:   '2026-04-29T12:00:00Z',
          },
          {
            id:          'ghl_msg_2',
            body:        'Confira aqui',
            direction:   'outbound',
            messageType: 'WhatsApp',
            userId:      'user_42',
            dateAdded:   '2026-04-29T12:05:00Z',
          },
        ],
      },
    });

    const result = await pollActiveGhlConversations(stubs);
    expect(result.polled).toBe(1);
    expect(result.mirrored).toBe(2);
    expect(stubs.prismaClient.inboxMessage.create).toHaveBeenCalledTimes(2);

    const firstCreate = stubs.prismaClient.inboxMessage.create.mock.calls[0][0].data;
    expect(firstCreate.ghlMessageId).toBe('ghl_msg_1');
    expect(firstCreate.isAiAgent).toBe(true);  // null userId

    const secondCreate = stubs.prismaClient.inboxMessage.create.mock.calls[1][0].data;
    expect(secondCreate.ghlMessageId).toBe('ghl_msg_2');
    expect(secondCreate.isAiAgent).toBe(false); // human userId
  });

  it('idempotent: re-running with same ghlMessageId already stored → 0 mirrors', async () => {
    const stubs = makeStubs({
      activeConvs: [
        { id: 'conv_1', contactPhone: '+5531991234567', messages: [] },
      ],
      searchResult: {
        ok: true,
        conversations: [{ id: 'ghl_conv_1', phone: '+5531991234567' }],
      },
      messagesResult: {
        ok: true,
        messages: [
          {
            id:          'ghl_msg_already',
            body:        'já vi',
            direction:   'outbound',
            messageType: 'WhatsApp',
            userId:      null,
            dateAdded:   '2026-04-29T12:00:00Z',
          },
        ],
      },
      existingByGhlId: new Set(['ghl_msg_already']),
    });

    const result = await pollActiveGhlConversations(stubs);
    expect(result.polled).toBe(1);
    expect(result.mirrored).toBe(0);
    expect(stubs.prismaClient.inboxMessage.create).not.toHaveBeenCalled();
  });

  it('skips conversations with no contactPhone', async () => {
    const stubs = makeStubs({
      activeConvs: [
        { id: 'conv_no_phone', contactPhone: null, messages: [] },
      ],
      searchResult: { ok: true, conversations: [] },
      messagesResult: { ok: true, messages: [] },
    });
    const result = await pollActiveGhlConversations(stubs);
    expect(result.polled).toBe(1);
    expect(result.mirrored).toBe(0);
    expect(stubs.ghlConv.searchConversations).not.toHaveBeenCalled();
  });

  it('skips when no GHL conversation matches local phone', async () => {
    const stubs = makeStubs({
      activeConvs: [
        { id: 'conv_1', contactPhone: '+5531991234567', messages: [] },
      ],
      searchResult: {
        ok: true,
        conversations: [{ id: 'ghl_other', phone: '+5511999999999' }],
      },
      messagesResult: { ok: true, messages: [] },
    });
    const result = await pollActiveGhlConversations(stubs);
    expect(result.mirrored).toBe(0);
    expect(stubs.ghlConv.getConversationMessages).not.toHaveBeenCalled();
  });
});
