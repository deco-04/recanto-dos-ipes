'use strict';

/**
 * Inbox routes — Unified WhatsApp / Instagram / Email inbox for staff.
 *
 * All /api/staff/conversas/* endpoints require a valid Bearer token.
 * The GHL inbound webhook at /api/webhooks/ghl-message is unauthenticated
 * (verified by GHL_WEBHOOK_SECRET HMAC header).
 */

const express  = require('express');
const crypto   = require('crypto');
const prisma   = require('../lib/db');
const { sendInstagramDM } = require('../lib/ghl-webhook');
const { sendText: sendWhatsAppDirect } = require('../lib/whatsapp');
const { sendInboxEmail } = require('../lib/mailer');
const { requireStaff } = require('../lib/staff-auth-middleware');
const ghlConv = require('../lib/ghl-conversations');
// push imported inline in webhook handler (sendPushToStaff)

const router = express.Router();

// ── GHL webhook payload normalization ─────────────────────────────────────────
// GHL "Custom Webhook" actions wrap user-defined Custom Data fields under a
// top-level `customData` object — they are NOT spread at the top level. The
// payload also includes a structured `message` object for message-trigger
// workflows. This helper extracts our 8 fields from either location and
// normalizes the GHL channel display string ("WhatsApp") to our enum
// ("WHATSAPP").
//
// Real-world receivedKeys from "Customer Replied" trigger:
//   [contact_id, first_name, last_name, full_name, phone, email, tags, …
//    message, workflow, triggerData, contact, attributionSource, customData]
// Our 8 keys (body, channel, etc.) live inside `customData`.
function normalizeGhlChannel(raw) {
  const s = String(raw || '').toUpperCase().replace(/[\s_-]/g, '');
  if (['WHATSAPP', 'WA', 'WHATSAPPWEB', 'TYPEWHATSAPP'].includes(s)) return 'WHATSAPP';
  if (['INSTAGRAM', 'IG', 'INSTAGRAMDM', 'TYPEIG'].includes(s)) return 'INSTAGRAM';
  if (['FACEBOOK', 'FB', 'MESSENGER', 'FACEBOOKMESSENGER', 'TYPEFB'].includes(s)) return 'FACEBOOK';
  if (['GBP', 'GMB', 'GOOGLEBUSINESS', 'GOOGLEMYBUSINESS', 'GOOGLEBUSINESSPROFILE'].includes(s)) return 'GBP';
  if (['EMAIL', 'TYPEEMAIL'].includes(s)) return 'EMAIL';
  return null;
}

function extractGhlMessagePayload(reqBody) {
  const top = reqBody || {};
  const cd  = (top.customData && typeof top.customData === 'object') ? top.customData : {};
  const ghlMsg = (top.message && typeof top.message === 'object') ? top.message : null;

  // Body: prefer customData.body (user-mapped {{message.body}}), fall back
  // to top-level structured message.body, top-level message-as-string, then
  // top-level `body` field (flat curl/test posts).
  const body = cd.body
    || ghlMsg?.body
    || (typeof top.message === 'string' ? top.message : null)
    || top.body
    || null;

  // Channel: customData first, then GHL's structured message.type, then any
  // contact-level "last_message_channel" field surfaced at top level, then
  // top-level `channel` (flat curl/test posts).
  const rawChannel = cd.channel
    || ghlMsg?.type
    || top['Last Message Channel']
    || top.last_message_channel
    || top.channel
    || null;

  // Contact identifiers — GHL surfaces these at top level for any contact-
  // bound trigger; customData fallbacks let users override per-workflow.
  const phone        = cd.phone        || top.phone        || top.contact?.phone        || null;
  const contactName  = cd.contactName  || top.contactName  || top.full_name    || top.contact?.full_name
                     || [top.first_name, top.last_name].filter(Boolean).join(' ').trim() || null;
  const contactEmail = cd.contactEmail || top.contactEmail || top.email        || top.contact?.email        || null;
  const avatarUrl    = cd.avatarUrl    || top.avatarUrl    || top.profilePhoto || top.contact?.profilePhoto || null;

  // direction & isAiAgent — accept boolean OR string from customData
  const direction = String(cd.direction || top.direction || 'INBOUND').toUpperCase();
  const isAiAgent = cd.isAiAgent === true
    || String(cd.isAiAgent || '').toLowerCase() === 'true'
    || top.isAiAgent === true;

  // sentAt — must be the message timestamp, NOT the contact creation date.
  // We previously fell back to top.date_created (contact's first-seen date)
  // which is months old and tripped the replay guard for legitimate webhooks.
  // Order: customData.sentAt → GHL's structured message.dateAdded → null.
  // GHL's {{right_now.hour}} returns just "14"; Node happily parses it as
  // year 2014, which would (a) bypass the replay guard since the date is
  // real and (b) silently store a wildly-wrong sentAt. We require the
  // parsed year to be >= 2024 (when this codebase was written) so single-
  // digit garbage is rejected without a regex hack on the raw string.
  let sentAt = cd.sentAt || ghlMsg?.dateAdded || null;
  if (sentAt) {
    const d = new Date(sentAt);
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2024) sentAt = null;
  }

  // Channel default: when we have a real body but cannot normalize the
  // channel string (e.g. GHL contact's "Last Message Channel" field returns
  // a numeric ID like "19", or the workflow was reconfigured to drop
  // customData), default to WHATSAPP — that's the dominant channel for
  // this property and a wrong-default is much less bad than silently
  // dropping legitimate inbound messages on the floor.
  let channel = normalizeGhlChannel(rawChannel);
  let channelDefaulted = false;
  if (!channel && body) {
    channel = 'WHATSAPP';
    channelDefaulted = true;
  }

  return {
    phone, contactName, contactEmail, avatarUrl,
    body,
    channel,
    rawChannel,
    channelDefaulted,
    direction,
    isAiAgent: Boolean(isAiAgent),
    sentAt,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function serializeConversation(c) {
  const last = c.messages?.[0];
  return {
    id:              c.id,
    contactName:     c.contactName,
    contactPhone:    c.contactPhone,
    contactEmail:    c.contactEmail,
    contactInstagram: c.contactInstagram,
    avatarUrl:       c.avatarUrl,
    status:          c.status ?? 'OPEN',
    channel:         last?.channel ?? 'WHATSAPP',
    lastMessage:     last?.body ?? null,
    lastMessageAt:   c.lastMessageAt,
    unreadCount:     c.unreadCount,
    createdAt:       c.createdAt,
  };
}

function serializeMessage(m) {
  return {
    id:        m.id,
    direction: m.direction,
    channel:   m.channel,
    body:      m.body,
    mediaUrl:  m.mediaUrl,
    isAiAgent: m.isAiAgent,
    sentAt:    m.sentAt,
    readAt:    m.readAt,
    staffId:   m.staffId,
    staffName: m.staff?.name ?? null,
  };
}

// ── GET /unread-count — total unread across all conversations ────────
router.get('/unread-count', requireStaff, async (req, res) => {
  try {
    const result = await prisma.conversation.aggregate({
      _sum: { unreadCount: true },
    });
    res.json({ count: result._sum.unreadCount ?? 0 });
  } catch (err) {
    console.error('[mensagens] GET unread-count error:', err);
    res.status(500).json({ error: 'Erro ao buscar contagem' });
  }
});

// ── GET / — list conversations ───────────────────────────────────────────────
router.get('/', requireStaff, async (req, res) => {
  try {
    const { channel, status, q, page = '1', limit = '30' } = req.query;
    const parsedPage  = Math.max(1, parseInt(page) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit) || 30));
    const skip = (parsedPage - 1) * parsedLimit;

    const where = {};
    if (channel && channel !== 'ALL') {
      where.messages = { some: { channel } };
    }
    // status filter: 'OPEN' | 'RESOLVED' — defaults to OPEN when not supplied
    if (status && status !== 'ALL') {
      where.status = status;
    } else if (!status) {
      where.status = 'OPEN';
    }
    if (q && q.trim()) {
      const search = q.trim();
      where.OR = [
        { contactName:  { contains: search, mode: 'insensitive' } },
        { contactPhone: { contains: search } },
        { contactEmail: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip,
        take: parsedLimit,
        include: {
          messages: {
            orderBy: { sentAt: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.conversation.count({ where }),
    ]);

    res.json({
      conversations: conversations.map(serializeConversation),
      total,
      page: parsedPage,
    });
  } catch (err) {
    console.error('[mensagens] GET /conversas error:', err);
    res.status(500).json({ error: 'Erro ao carregar conversas' });
  }
});

// ── GET /by-phone — find conversation by contact phone ───────────────────────
router.get('/by-phone', requireStaff, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    const conversation = await prisma.conversation.findFirst({
      where: { propertyId: property.id, contactPhone: String(phone) },
      include: { messages: { orderBy: { sentAt: 'desc' }, take: 1 } },
    });

    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json(serializeConversation(conversation));
  } catch (err) {
    console.error('[mensagens] GET by-phone error:', err);
    res.status(500).json({ error: 'Erro ao buscar conversa' });
  }
});

// ── POST / — create outbound conversation ─────────────────────────────────────
router.post('/', requireStaff, async (req, res) => {
  const { contactName, contactPhone, contactEmail, contactInstagram, channel, body, subject } = req.body;
  if (!contactName?.trim()) return res.status(400).json({ error: 'contactName é obrigatório' });
  if (!body?.trim() || !channel) return res.status(400).json({ error: 'body e channel são obrigatórios' });

  const validChannels = ['WHATSAPP', 'INSTAGRAM', 'EMAIL'];
  if (!validChannels.includes(channel)) return res.status(400).json({ error: 'Canal inválido' });

  // Normalize contact identifiers to prevent duplicate conversations from whitespace differences
  const normalizedPhone = contactPhone?.trim()    || null;
  const normalizedEmail = contactEmail?.trim()    || null;
  const normalizedInsta = contactInstagram?.trim() || null;

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    // Find or create conversation keyed by phone (preferred) or email
    const contactKey = normalizedPhone || normalizedEmail;
    if (!contactKey) return res.status(400).json({ error: 'contactPhone ou contactEmail obrigatório' });

    let conversation = await prisma.conversation.findFirst({
      where: {
        propertyId: property.id,
        ...(normalizedPhone ? { contactPhone: normalizedPhone } : { contactEmail: normalizedEmail }),
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          propertyId:       property.id,
          contactName:      contactName.trim(),
          contactPhone:     normalizedPhone,
          contactEmail:     normalizedEmail,
          contactInstagram: normalizedInsta,
          lastMessageAt:    new Date(),
          unreadCount:      0,
        },
      });
    }

    const staff = await prisma.staffMember.findUnique({
      where:  { id: req.staff.id },
      select: { name: true, emailSignature: true },
    });

    // Send via the correct channel
    if (channel === 'WHATSAPP') {
      if (!conversation.contactPhone) return res.status(400).json({ error: 'Contato sem telefone WhatsApp' });
      await sendWhatsAppDirect(conversation.contactPhone, body);
    } else if (channel === 'INSTAGRAM') {
      if (!conversation.contactInstagram) return res.status(400).json({ error: 'Contato sem Instagram vinculado' });
      await sendInstagramDM(conversation.contactInstagram, body, conversation.id);
    } else if (channel === 'EMAIL') {
      if (!conversation.contactEmail) return res.status(400).json({ error: 'Contato sem e-mail' });
      const { sendInboxEmail } = require('../lib/mailer');
      await sendInboxEmail({
        to:        conversation.contactEmail,
        fromName:  staff?.name || 'Recantos da Serra',
        subject:   subject || `Mensagem de ${staff?.name || 'Recantos da Serra'}`,
        body,
        signature: staff?.emailSignature,
      });
    }

    const message = await prisma.inboxMessage.create({
      data: {
        conversationId: conversation.id,
        staffId:        req.staff.id,
        direction:      'OUTBOUND',
        channel,
        body,
        sentAt:         new Date(),
        readAt:         new Date(),
      },
      include: { staff: { select: { name: true } } },
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: new Date() },
    });

    res.status(201).json({
      conversation: serializeConversation({ ...conversation, messages: [message] }),
      message:      serializeMessage(message),
    });
  } catch (err) {
    console.error('[mensagens] POST / error:', err);
    res.status(500).json({ error: err.message || 'Erro ao criar conversa' });
  }
});

// ── GET /:id/mensagens — messages for a conversation ─────────────────────────
router.get('/:id/mensagens', requireStaff, async (req, res) => {
  try {
    const { page = '1', limit = '50' } = req.query;
    const parsedPage  = Math.max(1, parseInt(page) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (parsedPage - 1) * parsedLimit;

    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    const messages = await prisma.inboxMessage.findMany({
      where: { conversationId: req.params.id },
      orderBy: { sentAt: 'asc' },
      skip,
      take: parsedLimit,
      include: { staff: { select: { name: true } } },
    });

    res.json({
      conversation: serializeConversation({ ...conversation, messages: [] }),
      messages: messages.map(serializeMessage),
      page: parsedPage,
    });
  } catch (err) {
    console.error('[mensagens] GET mensagens error:', err);
    res.status(500).json({ error: 'Erro ao carregar mensagens' });
  }
});

// ── POST /:id/mensagens — send a message ──────────────────────────────────────
router.post('/:id/mensagens', requireStaff, async (req, res) => {
  const { channel, body, subject } = req.body;
  if (!body?.trim() || !channel) {
    return res.status(400).json({ error: 'body e channel são obrigatórios' });
  }

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    const staff = await prisma.staffMember.findUnique({
      where: { id: req.staff.id },
      select: { name: true, emailSignature: true },
    });

    if (!['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'GBP', 'EMAIL'].includes(channel)) {
      return res.status(400).json({ error: 'Canal inválido' });
    }

    // ── Preferred path: route through GHL Conversations hub ─────────────
    // GHL handles the actual channel delivery (Meta WA, IG, FB, GMB, Email).
    // We only fall through to the direct-channel paths below if:
    //   - GHL_API_KEY is unset
    //   - the conversation can't be found in GHL by phone match
    //   - GHL returns auth/server failure
    // EMAIL stays out of the GHL path for now — Gmail OAuth is the canonical
    // sender for inbox email and GHL email isn't connected.
    if (process.env.GHL_API_KEY && channel !== 'EMAIL' && conversation.contactPhone) {
      // Pass the phone as a query so GHL filters server-side instead of
      // returning the first 20 conversations and hoping ours is in there.
      const search = await ghlConv.searchConversations({ limit: 20, query: conversation.contactPhone });
      if (search.ok) {
        const localTail = String(conversation.contactPhone || '').replace(/\D/g, '').slice(-11);
        const ghlConvObj = (search.conversations || []).find(g => {
          const remoteTail = String(g.phone || '').replace(/\D/g, '').slice(-11);
          return remoteTail && remoteTail === localTail;
        });
        // Diagnostic: when the GHL match fails the staff send falls through
        // to direct WA, which on RDI throws WHATSAPP_PHONE_NUMBER_ID since
        // the property migrated to GHL. Log enough to debug WHY without
        // dumping every phone in the location to the logs.
        if (!ghlConvObj?.id) {
          console.warn(`[mensagens] GHL match miss — local phone=${conversation.contactPhone} (tail=${localTail}), GHL search returned ${search.conversations?.length || 0} convs, sample phones: ${(search.conversations || []).slice(0, 3).map(g => g.phone).join(', ') || '(none)'}`);
        }
        if (ghlConvObj?.id) {
          const ghlType =
            channel === 'WHATSAPP'  ? 'WhatsApp' :
            channel === 'INSTAGRAM' ? 'IG'       :
            channel === 'FACEBOOK'  ? 'FB'       :
            channel === 'GBP'       ? 'GMB'      :
                                      'WhatsApp';
          const sendResult = await ghlConv.sendMessage({
            conversationId: ghlConvObj.id,
            type:           ghlType,
            body,
            contactId:      ghlConvObj.contactId || null,
          });
          if (sendResult.ok) {
            const message = await prisma.inboxMessage.create({
              data: {
                conversationId: conversation.id,
                staffId:        req.staff.id,
                direction:      'OUTBOUND',
                channel,
                body,
                sentAt:         new Date(),
                readAt:         new Date(),
                // Stamp ghlMessageId so the 2-min poll doesn't re-mirror
                // this exact message back into the inbox as a duplicate.
                ghlMessageId:   sendResult.messageId || null,
              },
              include: { staff: { select: { name: true } } },
            });
            await prisma.conversation.update({
              where: { id: conversation.id },
              data:  { lastMessageAt: new Date() },
            });
            return res.json(serializeMessage(message));
          }
          console.warn('[mensagens] GHL send failed, falling back to direct:', sendResult.error);
        }
        // No matching GHL conversation found — fall through to direct.
      } else {
        if (search.status === 401) {
          console.warn('[mensagens] GHL search 401 — PIT missing scopes; falling back to direct.');
        } else {
          console.warn('[mensagens] GHL search failed, falling back to direct:', search.error);
        }
      }
    }

    // ── Fallback: direct per-channel paths ───────────────────────────────
    if (channel === 'WHATSAPP') {
      if (!conversation.contactPhone) {
        return res.status(400).json({ error: 'Contato sem telefone WhatsApp' });
      }
      // RDI has migrated WhatsApp into GHL — there's no longer a working
      // direct Meta Cloud API path (WHATSAPP_PHONE_NUMBER_ID is unset).
      // If we got here, the GHL lookup above didn't find the conversation.
      // Surface a useful error instead of crashing on the missing env var,
      // and avoid the stack-trace toast in the staff app.
      if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
        return res.status(502).json({
          error: 'Não foi possível enviar via GHL e o caminho direto WhatsApp não está configurado. Verifique se a conversa existe no GHL desta location.',
          code: 'GHL_LOOKUP_FAILED_NO_DIRECT_FALLBACK',
        });
      }
      await sendWhatsAppDirect(conversation.contactPhone, body);

    } else if (channel === 'INSTAGRAM') {
      if (!conversation.contactInstagram) {
        return res.status(400).json({ error: 'Contato sem Instagram vinculado' });
      }
      await sendInstagramDM(conversation.contactInstagram, body, conversation.id);

    } else if (channel === 'EMAIL') {
      if (!conversation.contactEmail) {
        return res.status(400).json({ error: 'Contato sem e-mail' });
      }
      await sendInboxEmail({
        to:        conversation.contactEmail,
        fromName:  staff?.name || 'Recantos da Serra',
        subject:   subject || `Mensagem de ${staff?.name || 'Recantos da Serra'}`,
        body,
        signature: staff?.emailSignature,
      });
    } else {
      // FACEBOOK / GBP have no direct path — they only work through GHL.
      return res.status(400).json({ error: `Canal ${channel} requer GHL Conversations API ativo` });
    }

    // Store message
    const message = await prisma.inboxMessage.create({
      data: {
        conversationId: conversation.id,
        staffId:        req.staff.id,
        direction:      'OUTBOUND',
        channel,
        body,
        sentAt:         new Date(),
        readAt:         new Date(),
      },
      include: { staff: { select: { name: true } } },
    });

    // Update conversation lastMessageAt
    await prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: new Date() },
    });

    res.json(serializeMessage(message));
  } catch (err) {
    console.error('[mensagens] POST mensagens error:', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar mensagem' });
  }
});

// ── PATCH /:id/status — open or resolve a conversation ───────────────────────
router.patch('/:id/status', requireStaff, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['OPEN', 'RESOLVED'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status deve ser um de: ${validStatuses.join(', ')}` });
  }

  try {
    const conversation = await prisma.conversation.update({
      where: { id: req.params.id },
      data:  { status },
      include: { messages: { orderBy: { sentAt: 'desc' }, take: 1 } },
    });
    res.json(serializeConversation(conversation));
  } catch (err) {
    console.error('[mensagens] PATCH status error:', err);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// ── PATCH /:id/lida — mark conversation as read ───────────────────────────────
router.patch('/:id/lida', requireStaff, async (req, res) => {
  try {
    await prisma.inboxMessage.updateMany({
      where: {
        conversationId: req.params.id,
        direction:      'INBOUND',
        readAt:         null,
      },
      data: { readAt: new Date() },
    });

    await prisma.conversation.update({
      where: { id: req.params.id },
      data:  { unreadCount: 0 },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[mensagens] PATCH lida error:', err);
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// ── POST /webhooks/ghl-message — inbound WA/Instagram from GHL ────────────────
// Mounted at /api/webhooks/ghl-message (no /api/staff prefix, no auth)
// Verified by static token — accepted via:
//   1. x-webhook-secret header  (preferred)
//   2. ?secret= query parameter (fallback for GHL workflows that can't add custom headers)
router.post('/ghl-message', async (req, res) => {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[mensagens] GHL_WEBHOOK_SECRET not set — rejecting webhook');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  // Accept the secret from either the header or the URL query string
  const provided = req.headers['x-webhook-secret'] || req.query.secret || '';
  const secretBuf   = Buffer.from(secret);
  const providedBuf = Buffer.from(provided);
  if (
    providedBuf.length !== secretBuf.length ||
    !crypto.timingSafeEqual(providedBuf, secretBuf)
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Extract our 8 inbox fields from GHL's actual payload shape — handles
  // both the flat shape (curl-style POSTs from tests) and the nested shape
  // ({ customData: {...}, message: {...}, contact: {...} }) that GHL Custom
  // Webhook actions emit. See extractGhlMessagePayload() above for details.
  const {
    phone, contactName, contactEmail, avatarUrl,
    body, channel, rawChannel, channelDefaulted,
    direction, isAiAgent, sentAt,
  } = extractGhlMessagePayload(req.body);

  // If we had to default the channel because the workflow's mapping
  // returned a non-normalizable value, surface it in the logs so the
  // misconfiguration is visible without breaking real traffic.
  if (channelDefaulted) {
    console.warn('[mensagens] ghl-message channel defaulted → WHATSAPP. rawChannel was:',
      JSON.stringify(rawChannel), '— consider hardcoding `channel: WHATSAPP` in the workflow customData.');
  }

  if (sentAt) {
    // Replay window — needs to be wide enough to absorb normal GHL workflow
    // queue latency (we've seen 5-10 min in practice on busy locations).
    // The static URL secret already provides the primary auth; this guard
    // exists only to bound how long an exfiltrated payload remains useful.
    const age = Date.now() - new Date(sentAt).getTime();
    if (age > 30 * 60 * 1000) {
      return res.status(400).json({ error: 'Webhook payload too old (replay prevention)' });
    }
  }
  if (!body || !channel) {
    // Log received keys + truncated body so we can diagnose GHL workflow
    // misconfigurations (variable not resolving, wrong field name, etc.)
    // without leaking full message content into logs.
    console.warn('[mensagens] ghl-message 400 — missing body/channel. Received keys:',
      Object.keys(req.body || {}),
      'customData keys:', Object.keys(req.body?.customData || {}),
      'body preview:', String(body || '').slice(0, 80) || '(empty)',
      'rawChannel:', rawChannel || '(empty)',
      'normalized channel:', channel || '(empty)');
    return res.status(400).json({
      error: 'body and channel required',
      receivedKeys: Object.keys(req.body || {}),
      customDataKeys: Object.keys(req.body?.customData || {}),
      bodyEmpty: !body,
      channelEmpty: !channel,
      rawChannel: rawChannel || null,
    });
  }
  if (!['INBOUND', 'OUTBOUND'].includes(direction)) {
    return res.status(400).json({ error: 'direction must be INBOUND or OUTBOUND' });
  }

  // Channels stored in the inbox. Extended for the GHL conversation hub:
  // WhatsApp + Instagram + Facebook DM + Google Business Profile messaging.
  // EMAIL / CHAT WIDGET / OTHER stay out of the inbox (handled elsewhere).
  const inboxChannels = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'GBP'];
  if (!inboxChannels.includes(channel)) {
    return res.json({ ok: true, skipped: true, reason: `channel ${channel} not handled by inbox` });
  }

  // GHL workflow webhooks don't provide an instagramId — use phone as the universal
  // contact identifier (GHL contacts always have phone even for Instagram DMs).
  // Fall back to email if phone is absent.
  const contactKey = phone || contactEmail;
  if (!contactKey) {
    return res.status(400).json({ error: 'phone or email required to identify contact' });
  }

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'No active property' });

    // Find or create conversation — keyed by phone (preferred) or email
    let conversation = await prisma.conversation.findFirst({
      where: {
        propertyId: property.id,
        ...(phone ? { contactPhone: phone } : { contactEmail }),
      },
    });

    // INBOUND increments unread (admin needs to read it); OUTBOUND doesn't
    // (it's an AI/staff message LEAVING us — admin already saw the prompt).
    const isInbound = direction === 'INBOUND';

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          propertyId:    property.id,
          contactName:   contactName || phone || contactEmail || 'Contato',
          contactPhone:  phone        || null,
          contactEmail:  contactEmail || null,
          avatarUrl:     avatarUrl    || null,
          lastMessageAt: new Date(),
          unreadCount:   isInbound ? 1 : 0,
        },
      });
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          ...(isInbound ? { unreadCount: { increment: 1 } } : {}),
          avatarUrl:     avatarUrl || conversation.avatarUrl,
        },
      });
    }

    // Store message — direction + isAiAgent come from the GHL payload so
    // we can faithfully mirror what GHL's conversation log shows.
    await prisma.inboxMessage.create({
      data: {
        conversationId: conversation.id,
        direction,
        channel,
        body,
        isAiAgent: Boolean(isAiAgent),
        sentAt: sentAt ? new Date(sentAt) : new Date(),
      },
    });

    // Smart-reply (legacy local FAQ bot): only fires for INBOUND when the
    // property has explicitly opted in. With GHL conversation-hub agents
    // active (the canonical path for AI replies), every property should
    // have smartReplyEnabled=false to avoid duplicate replies. The hook
    // stays in place as a fallback if you ever turn it on per-property.
    if (isInbound) {
      require('../lib/smart-reply').maybeAutoReply({
        conversation,
        inboundMessage: { body, channel },
        property,
      }).catch(e => console.error('[smart-reply] error:', e.message));
    }

    // Push to ADMIN — only on INBOUND. OUTBOUND is just a mirror of what
    // GHL's AI agent (or human staff in GHL) already sent; admins don't
    // need a "new message" notification for their own outgoing reply.
    if (!isInbound) {
      return res.json({ ok: true, conversationId: conversation.id, mirrored: 'OUTBOUND' });
    }

    // Only staff with inboxPushEnabled. We can't filter
    // `pushSubscription IS NOT NULL` directly on Json? fields in newer Prisma
    // versions — sendPushToStaff guards internally and skips rows without
    // a subscription, so the in-memory filter below is enough.
    prisma.staffMember.findMany({
      where: {
        role: 'ADMIN',
        active: true,
        inboxPushEnabled: true,
      },
      select: { id: true, pushSubscription: true },
    }).then(rows => {
      const admins = rows.filter(a => a.pushSubscription);
      const { sendPushToStaff } = require('../lib/push');
      return Promise.allSettled(
        admins.map(a => sendPushToStaff(a.id, {
          title: `Nova mensagem — ${conversation.contactName}`,
          body:  body.length > 80 ? body.slice(0, 80) + '…' : body,
          type:  'INBOX_MESSAGE',
          data:  { conversationId: conversation.id },
        }))
      );
    }).catch(e => console.error('[push] inbox push error:', e.message));

    res.json({ ok: true, conversationId: conversation.id });
  } catch (err) {
    console.error('[mensagens] ghl-message webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Exported for unit testing — `router` is the default; helpers are attached
// for direct test access without spinning up an Express app.
router.__test__ = { extractGhlMessagePayload, normalizeGhlChannel };
module.exports = router;
