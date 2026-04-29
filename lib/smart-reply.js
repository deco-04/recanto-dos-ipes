'use strict';

/**
 * Smart Reply / FAQ bot for inbound guest WhatsApp messages.
 *
 * When a guest sends a WA message to a property with smartReplyEnabled=true,
 * Claude reads the property's accessInfo (WiFi, check-in instructions,
 * emergency contacts, house rules) and either auto-responds to clearly-factual
 * questions or escalates to staff.
 *
 * Pure-ish: dependencies (Prisma client, Anthropic client, sendText) are
 * injected so the module is unit-testable. The default factory binds to the
 * real production singletons.
 *
 * Hooked from routes/mensagens.js right after the InboxMessage.create on the
 * inbound webhook path. Wrapped in .catch on the caller side — errors here
 * MUST never break the webhook ack.
 */

const Anthropic   = require('@anthropic-ai/sdk');
const prisma      = require('./db');
const whatsapp    = require('./whatsapp');

const COOLDOWN_MS         = 5 * 60 * 1000;        // 5 minutes
const CONFIDENCE_THRESHOLD = 0.85;
const MAX_TOKENS          = 200;
const MODEL               = 'claude-sonnet-4-6';

let _defaultClient = null;
function defaultAnthropicClient() {
  if (_defaultClient) return _defaultClient;
  _defaultClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _defaultClient;
}

function safeParseJSON(raw) {
  try {
    const cleaned = String(raw)
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function buildPrompt({ property, inboundMessage, booking }) {
  const accessInfo = property.accessInfo || {};
  const wifi       = accessInfo.wifi    || {};
  const checkin    = accessInfo.checkin || {};
  const houseRules = Array.isArray(accessInfo.houseRules) ? accessInfo.houseRules : [];

  const system = `Você é um assistente FAQ do ${property.name}. Responda APENAS perguntas claramente factuais com base nos dados fornecidos. Português brasileiro, curto (≤200 chars), educado. Se não souber ou for complexo, deixe staff humano responder.`;

  const lines = [];
  lines.push('Dados da propriedade:');
  lines.push(`- WiFi: SSID="${wifi.ssid || 'não cadastrado'}" senha="${wifi.password || 'não cadastrada'}"`);
  lines.push(`- Check-in: ${checkin.instructions || 'não cadastrado'}`);
  lines.push(`- Emergência: ${checkin.emergency || 'não cadastrado'}${checkin.emergencyLabel ? ` (${checkin.emergencyLabel})` : ''}`);
  lines.push(`- Regras da casa: ${houseRules.length ? houseRules.join('; ') : 'não cadastradas'}`);
  lines.push('- Pet permitido (mediante taxa): SIM');
  lines.push('');

  if (booking) {
    const checkInStr = booking.checkIn instanceof Date
      ? booking.checkIn.toLocaleDateString('pt-BR')
      : new Date(booking.checkIn).toLocaleDateString('pt-BR');
    lines.push('Reserva atual:');
    lines.push(`- Hóspede: ${booking.guestName}`);
    lines.push(`- Check-in: ${checkInStr}`);
    lines.push(`- Noites: ${booking.nights}`);
    lines.push('');
  }

  lines.push(`User message: "${inboundMessage.body}"`);
  lines.push('');
  lines.push('Responda APENAS em JSON válido neste formato:');
  lines.push('{');
  lines.push('  "shouldReply": boolean,');
  lines.push('  "replyText": string|null,');
  lines.push('  "confidence": number 0-1,');
  lines.push('  "category": "WIFI" | "CHECKIN_TIME" | "EMERGENCY" | "RULES" | "PET" | "OTHER" | "ESCALATE"');
  lines.push('}');
  lines.push('');
  lines.push('Regras estritas:');
  lines.push('- shouldReply=true APENAS se confidence > 0.85 E categoria != "ESCALATE"');
  lines.push('- NUNCA invente informação; se não tem dado claro, escalate');
  lines.push('- Para perguntas que envolvem disponibilidade futura, preço de reserva nova, ou modificação de reserva, sempre escalate');
  lines.push('- Para reclamações/feedback, sempre escalate');

  return { system, user: lines.join('\n') };
}

/**
 * Decide whether to auto-reply to an inbound guest WA message + send if so.
 *
 * @returns {Promise<{ replied: boolean, reason: string, replyText?: string, category?: string }>}
 */
async function maybeAutoReply({
  conversation,
  inboundMessage,
  property,
  prismaClient = prisma,
  anthropic    = null,
  sendText     = whatsapp.sendText,
}) {
  // 1. Opt-in gate
  if (!property || property.smartReplyEnabled !== true) {
    return { replied: false, reason: 'disabled' };
  }

  // 2. Cooldown — last InboxMessage was AI < 5 min ago
  try {
    const last = await prismaClient.inboxMessage.findFirst({
      where:   { conversationId: conversation.id, isAiAgent: true },
      orderBy: { sentAt: 'desc' },
    });
    if (last?.sentAt && Date.now() - new Date(last.sentAt).getTime() < COOLDOWN_MS) {
      console.log('[smart-reply] cooldown — last AI msg', conversation.id);
      return { replied: false, reason: 'cooldown' };
    }
  } catch (e) {
    console.error('[smart-reply] cooldown check error:', e.message);
    return { replied: false, reason: 'cooldown-check-error' };
  }

  // 3. Booking context — best-effort
  let booking = null;
  if (conversation.contactPhone) {
    try {
      const phoneDigits = conversation.contactPhone.replace(/\D/g, '').slice(-11);
      booking = await prismaClient.booking.findFirst({
        where: {
          status:     { in: ['CONFIRMED', 'COMPLETED'] },
          guestPhone: { contains: phoneDigits },
        },
        orderBy: { checkIn: 'desc' },
        select:  { id: true, guestName: true, checkIn: true, nights: true },
      });
    } catch (e) {
      console.error('[smart-reply] booking lookup error:', e.message);
      // Non-fatal — continue with no booking context.
    }
  }

  // 4. Build + 5. Call Claude
  const { system, user } = buildPrompt({ property, inboundMessage, booking });

  const client = anthropic || defaultAnthropicClient();
  let parsed;
  try {
    const resp = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages:   [{ role: 'user', content: user }],
    });
    const text = resp?.content?.[0]?.text || '';
    parsed = safeParseJSON(text);
  } catch (e) {
    console.error('[smart-reply] Claude API error:', e.message);
    return { replied: false, reason: 'api-error' };
  }

  if (!parsed || typeof parsed !== 'object') {
    console.error('[smart-reply] parse-error — Claude did not return valid JSON');
    return { replied: false, reason: 'parse-error' };
  }

  const { shouldReply, replyText, confidence, category } = parsed;

  // 6. Reply gate
  if (category === 'ESCALATE') {
    console.log('[smart-reply] escalated', conversation.id);
    return { replied: false, reason: 'escalated', category };
  }
  if (!shouldReply || !replyText) {
    return { replied: false, reason: 'should-not-reply', category };
  }
  if (typeof confidence !== 'number' || confidence < CONFIDENCE_THRESHOLD) {
    return { replied: false, reason: 'low-confidence', category };
  }

  // 7. Send + 8. Mirror as OUTBOUND InboxMessage (sendText doesn't do this for free text)
  try {
    await sendText(conversation.contactPhone, replyText, booking?.id ?? null);
  } catch (e) {
    console.error('[smart-reply] sendText error:', e.message);
    return { replied: false, reason: 'send-error', category };
  }

  try {
    await prismaClient.inboxMessage.create({
      data: {
        conversationId: conversation.id,
        direction:      'OUTBOUND',
        channel:        inboundMessage.channel || 'WHATSAPP',
        body:           replyText,
        isAiAgent:      true,
        sentAt:         new Date(),
      },
    });
  } catch (e) {
    // The message was already sent over WA — log and continue. Worst case: the
    // outbound row is missing from the inbox UI but the guest got a real reply.
    console.error('[smart-reply] InboxMessage mirror error:', e.message);
  }

  console.log(`[smart-reply] replied conv=${conversation.id} category=${category} confidence=${confidence}`);
  return { replied: true, reason: 'sent', replyText, category };
}

module.exports = {
  maybeAutoReply,
  // Exported for tests
  buildPrompt,
  safeParseJSON,
  COOLDOWN_MS,
  CONFIDENCE_THRESHOLD,
};
