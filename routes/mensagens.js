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
const jwt      = require('jsonwebtoken');
const prisma   = require('../lib/db');
const { sendWhatsAppMessage, sendInstagramDM } = require('../lib/ghl-webhook');
const { sendInboxEmail } = require('../lib/mailer');
// push imported inline in webhook handler (sendPushToStaff)

const router = express.Router();

// ── Auth middleware ────────────────────────────────────────────────────────────
async function requireStaff(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  const staff = await prisma.staffMember.findUnique({
    where:  { id: payload.sub },
    select: { id: true, role: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });

  req.staff = staff;
  next();
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
    const { channel, page = '1', limit = '30' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (channel && channel !== 'ALL') {
      where.messages = { some: { channel } };
    }

    const conversations = await prisma.conversation.findMany({
      where,
      orderBy: { lastMessageAt: 'desc' },
      skip,
      take: parseInt(limit),
      include: {
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
        },
      },
    });

    const total = await prisma.conversation.count({ where });

    res.json({
      conversations: conversations.map(serializeConversation),
      total,
      page: parseInt(page),
    });
  } catch (err) {
    console.error('[mensagens] GET /conversas error:', err);
    res.status(500).json({ error: 'Erro ao carregar conversas' });
  }
});

// ── GET /:id/mensagens — messages for a conversation ─────────────────────────
router.get('/:id/mensagens', requireStaff, async (req, res) => {
  try {
    const { page = '1', limit = '50' } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversa não encontrada' });

    const messages = await prisma.inboxMessage.findMany({
      where: { conversationId: req.params.id },
      orderBy: { sentAt: 'asc' },
      skip,
      take: parseInt(limit),
      include: { staff: { select: { name: true } } },
    });

    res.json({
      conversation: serializeConversation({ ...conversation, messages: [] }),
      messages: messages.map(serializeMessage),
      page: parseInt(page),
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
      await sendWhatsAppMessage(conversation.contactPhone, body, conversation.id);

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
// Verified by HMAC header from GHL
router.post('/ghl-message', async (req, res) => {
  // Optional HMAC verification
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-ghl-signature'] || '';
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const { phone, instagramId, contactName, contactEmail, avatarUrl, body, channel, sentAt } = req.body;
  if (!body || !channel) {
    return res.status(400).json({ error: 'body and channel required' });
  }

  const validChannels = ['WHATSAPP', 'INSTAGRAM'];
  if (!validChannels.includes(channel)) {
    return res.status(400).json({ error: 'Invalid channel' });
  }

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'No active property' });

    // Find or create conversation
    let conversation = await prisma.conversation.findFirst({
      where: {
        propertyId: property.id,
        ...(channel === 'WHATSAPP'  ? { contactPhone: phone } :
            channel === 'INSTAGRAM' ? { contactInstagram: instagramId } : {}),
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          propertyId:       property.id,
          contactName:      contactName || phone || instagramId || 'Contato',
          contactPhone:     channel === 'WHATSAPP'  ? phone       : null,
          contactInstagram: channel === 'INSTAGRAM' ? instagramId : null,
          contactEmail:     contactEmail || null,
          avatarUrl:        avatarUrl    || null,
          lastMessageAt:    new Date(),
          unreadCount:      1,
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
