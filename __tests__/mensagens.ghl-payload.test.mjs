// Tests for the GHL webhook payload extraction helper.
//
// Why this exists: GHL Custom Webhook actions wrap user-defined Custom Data
// fields under a top-level `customData` object — they are NOT spread at the
// top level. The first attempt at the inbound webhook destructured directly
// from req.body and silently rejected real GHL traffic with "body and channel
// required" because everything we needed was nested. This test pins the
// payload shapes we accept so a future refactor can't regress us back into
// that 400.
//
// Real-world receivedKeys captured from a "Customer Replied" trigger fired
// against +17209494907 (returned in the workflow History tab error info):
//   [Traz Pet, Numero de Criancas, Mensagem do Hospede, Faixa de Orcamento,
//    Last Message Channel, Check-in, Hospedes, Ocasiao,
//    Propriedade de Interesse, Numero de Adultos, Valor Total,
//    Como Nos Conheceu, Check-out, Numero da Reserva, contact_id,
//    first_name, last_name, full_name, phone, tags, country, date_created,
//    full_address, contact_type, location, message, workflow, triggerData,
//    contact, attributionSource, customData]
//
// Our 8 fields (body, channel, direction, isAiAgent, contactName,
// contactEmail, phone, sentAt) live INSIDE customData.

import { describe, it, expect } from 'vitest';

const router = (await import('../routes/mensagens.js')).default;
const { extractGhlMessagePayload, normalizeGhlChannel } = router.__test__;

describe('normalizeGhlChannel', () => {
  it('maps GHL display strings to our enum', () => {
    expect(normalizeGhlChannel('WhatsApp')).toBe('WHATSAPP');
    expect(normalizeGhlChannel('whatsapp')).toBe('WHATSAPP');
    expect(normalizeGhlChannel('TYPE_WHATSAPP')).toBe('WHATSAPP');
    expect(normalizeGhlChannel('Instagram')).toBe('INSTAGRAM');
    expect(normalizeGhlChannel('IG')).toBe('INSTAGRAM');
    expect(normalizeGhlChannel('Facebook')).toBe('FACEBOOK');
    expect(normalizeGhlChannel('Facebook Messenger')).toBe('FACEBOOK');
    expect(normalizeGhlChannel('GMB')).toBe('GBP');
    expect(normalizeGhlChannel('Google Business Profile')).toBe('GBP');
  });
  it('returns null for unknown / empty', () => {
    expect(normalizeGhlChannel(null)).toBeNull();
    expect(normalizeGhlChannel('')).toBeNull();
    expect(normalizeGhlChannel('Discord')).toBeNull();
  });
});

describe('extractGhlMessagePayload — GHL nested customData shape', () => {
  // This is the actual shape the GHL Custom Webhook action emits.
  function ghlInboundPayload({ overrides = {} } = {}) {
    return {
      contact_id:    'abc123',
      first_name:    'Andre',
      last_name:     'De Souza',
      full_name:     'Andre De Souza',
      phone:         '+17209494907',
      email:         null,
      tags:          [],
      country:       'BR',
      date_created:  '2026-04-30T05:30:00.000Z',
      full_address:  '',
      contact_type:  'lead',
      location:      { id: 'cI70F9UFzrgto8Mdk48n', name: 'Recantos da Serra' },
      message:       { id: 'msg_xyz', body: 'teste meta→ghl', type: 'TYPE_WHATSAPP', dateAdded: '2026-04-30T05:30:00.000Z', direction: 'inbound' },
      workflow:      { id: 'wf_001', name: 'Inbox → SRI Admin Mirror (INBOUND)' },
      triggerData:   {},
      contact:       { id: 'abc123', full_name: 'Andre De Souza' },
      attributionSource: {},
      // Our user-defined fields under the action's Custom Data section
      customData: {
        channel:      'WhatsApp',
        sentAt:       '2026-04-30T05:30:00.000Z',
        phone:        '+17209494907',
        contactName:  'Andre De Souza',
        contactEmail: '',
        body:         'teste meta→ghl',
        direction:    'INBOUND',
        isAiAgent:    'false',
      },
      ...overrides,
    };
  }

  it('extracts body + channel from customData (canonical happy path)', () => {
    const got = extractGhlMessagePayload(ghlInboundPayload());
    expect(got.body).toBe('teste meta→ghl');
    expect(got.channel).toBe('WHATSAPP');
    expect(got.phone).toBe('+17209494907');
    expect(got.contactName).toBe('Andre De Souza');
    expect(got.direction).toBe('INBOUND');
    expect(got.isAiAgent).toBe(false);
  });

  it('falls back to top-level message.body when customData.body is empty', () => {
    const p = ghlInboundPayload({ overrides: { customData: { channel: 'WhatsApp', body: '' } } });
    const got = extractGhlMessagePayload(p);
    expect(got.body).toBe('teste meta→ghl');
  });

  it('falls back to message.type when customData.channel missing', () => {
    const p = ghlInboundPayload({ overrides: { customData: { body: 'oi' } } });
    const got = extractGhlMessagePayload(p);
    expect(got.channel).toBe('WHATSAPP');
  });

  it('drops invalid sentAt values like "{{right_now.hour}}" output ("2")', () => {
    const p = ghlInboundPayload({ overrides: { customData: { body: 'oi', channel: 'WhatsApp', sentAt: '2' } } });
    const got = extractGhlMessagePayload(p);
    expect(got.sentAt).toBeNull();
  });

  it('keeps a valid sentAt if customData supplies an ISO timestamp', () => {
    const ts = '2026-04-30T05:30:00.000Z';
    const p = ghlInboundPayload({ overrides: { customData: { body: 'oi', channel: 'WhatsApp', sentAt: ts } } });
    const got = extractGhlMessagePayload(p);
    expect(got.sentAt).toBe(ts);
  });

  it('parses isAiAgent="true" string from customData', () => {
    const p = ghlInboundPayload({ overrides: { customData: { body: 'oi', channel: 'WhatsApp', isAiAgent: 'true' } } });
    expect(extractGhlMessagePayload(p).isAiAgent).toBe(true);
  });

  it('builds contactName from first_name+last_name when full_name missing', () => {
    const p = ghlInboundPayload({ overrides: {
      full_name: undefined,
      customData: { body: 'oi', channel: 'WhatsApp', contactName: '' },
    }});
    expect(extractGhlMessagePayload(p).contactName).toBe('Andre De Souza');
  });
});

describe('extractGhlMessagePayload — flat shape (curl/test smoke posts)', () => {
  it('still works for direct flat POSTs (the curl smoke-test path)', () => {
    const flat = {
      phone: '+5531999999999',
      contactName: 'Smoke Test',
      body: 'smoke test from claude',
      channel: 'WHATSAPP',
      direction: 'INBOUND',
      isAiAgent: false,
    };
    const got = extractGhlMessagePayload(flat);
    expect(got.body).toBe('smoke test from claude');
    expect(got.channel).toBe('WHATSAPP');
    expect(got.phone).toBe('+5531999999999');
    expect(got.contactName).toBe('Smoke Test');
    expect(got.direction).toBe('INBOUND');
    expect(got.isAiAgent).toBe(false);
  });
});

describe('extractGhlMessagePayload — failure modes + defaulting', () => {
  it('returns null body when no source has it', () => {
    const got = extractGhlMessagePayload({ customData: { channel: 'WhatsApp' } });
    expect(got.body).toBeNull();
    expect(got.channel).toBe('WHATSAPP');
    expect(got.channelDefaulted).toBe(false);
  });

  it('defaults channel to WHATSAPP when body is present but rawChannel is unparseable (e.g. numeric ID "19" from contact custom field)', () => {
    // Real-world failure mode captured from production: GHL contact's
    // "Last Message Channel" custom field returned numeric "19", which
    // doesn't normalize. Without this default, legitimate inbound WAs
    // got dropped on the floor with "channel required".
    const got = extractGhlMessagePayload({
      'Last Message Channel': '19',
      message: 'Test',
    });
    expect(got.body).toBe('Test');
    expect(got.channel).toBe('WHATSAPP');
    expect(got.channelDefaulted).toBe(true);
    expect(got.rawChannel).toBe('19');
  });

  it('does NOT default channel when body is also missing — both fields stay null', () => {
    const got = extractGhlMessagePayload({});
    expect(got.body).toBeNull();
    expect(got.channel).toBeNull();
    expect(got.channelDefaulted).toBe(false);
  });
});
