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
// push imported inline in webhook handler (sendPushToStaff)

const router = express.Router();

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

    // Route to correct channel
    if (channel === 'WHATSAPP') {
      if (!conversation.contactPhone) {
        return res.status(400).json({ error: 'Contato sem telefone WhatsApp' });
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
      return res.status(400).json({ error: 'Canal inválido' });
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

  // Reject stale webhooks (> 5 minutes old) to prevent replay attacks
  const { phone, contactName, contactEmail, avatarUrl, body, channel, sentAt } = req.body;
  if (sentAt) {
    const age = Date.now() - new Date(sentAt).getTime();
    if (age > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Webhook payload too old (replay prevention)' });
    }
  }
  if (!body || !channel) {
    return res.status(400).json({ error: 'body and channel required' });
  }

  // Only WHATSAPP and INSTAGRAM are stored in the inbox.
  // EMAIL, CHAT WIDGET, OTHER are valid GHL channels but not handled here — ack and skip.
  const inboxChannels = ['WHATSAPP', 'INSTAGRAM'];
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

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          propertyId:    property.id,
          contactName:   contactName || phone || contactEmail || 'Contato',
          contactPhone:  phone        || null,
          contactEmail:  contactEmail || null,
          avatarUrl:     avatarUrl    || null,
          lastMessageAt: new Date(),
          unreadCount:   1,
        },
      });
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          unreadCount:   { increment: 1 },
          avatarUrl:     avatarUrl || conversation.avatarUrl,
        },
      });
    }

    // Store message
    await prisma.inboxMessage.create({
      data: {
        conversationId: conversation.id,
        direction:      'INBOUND',
        channel,
        body,
        sentAt:         sentAt ? new Date(sentAt) : new Date(),
      },
    });

    // Smart-reply: non-blocking AI FAQ bot. Won't delay the webhook ack;
    // gated by Property.smartReplyEnabled (default false). See lib/smart-reply.js.
    require('../lib/smart-reply').maybeAutoReply({
      conversation,
      inboundMessage: { body, channel },
      property,
    }).catch(e => console.error('[smart-reply] error:', e.message));

    // Push to ADMIN (only staff with inboxPushEnabled)
    prisma.staffMember.findMany({
      where: {
        role: 'ADMIN',
        active: true,
        inboxPushEnabled: true,
        NOT: { pushSubscription: null },
      },
      select: { id: true },
    }).then(admins => {
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

module.exports = router;
