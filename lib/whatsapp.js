'use strict';

/**
 * WhatsApp Business Cloud API service.
 *
 * Replaces GHL as the WhatsApp bridge for all automated and manual messages.
 * Credentials are read from env at call time — no restart needed after update.
 *
 * Required env vars:
 *   WHATSAPP_PHONE_NUMBER_ID  — from Meta Business Manager → WhatsApp → Phone Numbers
 *   WHATSAPP_ACCESS_TOKEN     — permanent System User token from Meta Business Manager
 *   WHATSAPP_VERIFY_TOKEN     — any secret string; used to verify the webhook with Meta
 */

const https  = require('https');
const prisma = require('./db');
const { sendPushToRole } = require('./push');

const META_API_VERSION = 'v19.0';
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL || 'https://g.page/r/CXxZj8v-oLgBEBM/review';

// ── Credentials ───────────────────────────────────────────────────────────────

function getPhoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID;
}

function getAccessToken() {
  return process.env.WHATSAPP_ACCESS_TOKEN;
}

// ── Core HTTP helper ──────────────────────────────────────────────────────────

function graphPost(path, body) {
  const token = getAccessToken();
  if (!token) {
    return Promise.reject(new Error('WHATSAPP_ACCESS_TOKEN not configured'));
  }

  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'graph.facebook.com',
      path:     `/${META_API_VERSION}${path}`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization':  `Bearer ${token}`,
      },
      timeout: 15000,
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(json.error?.message || `Meta API error ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Meta API parse error: ${data.slice(0, 120)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Meta API timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Phone normalization ───────────────────────────────────────────────────────

/**
 * Normalize a Brazilian phone number to E.164 format (e.g. "+5531991234567").
 * Handles inputs like: "31 99123-4567", "+5531991234567", "5531991234567", "031991234567"
 */
function normalizePhone(phone) {
  let n = String(phone).replace(/[\s\-().]/g, '');
  if (!n.startsWith('+')) {
    if (n.startsWith('55') && n.length >= 12)  n = '+' + n;
    else if (n.startsWith('0'))                 n = '+55' + n.slice(1);
    else                                        n = '+55' + n;
  }
  return n;
}

// ── Send template ─────────────────────────────────────────────────────────────

/**
 * Send a Meta-approved template message to a phone number.
 *
 * @param {string}   to           - Recipient phone (any Brazilian format)
 * @param {string}   templateName - Meta-approved template name
 * @param {string[]} bodyVars     - Values for {{1}}, {{2}}, ... in the template body
 * @param {string|null} bookingId - Optional booking ID for MessageLog tracking
 * @returns {Promise<{metaMessageId: string|null}>}
 */
// ── Template body preview for InboxMessage logging ───────────────────────────
//
// When an automated template fires (booking_confirmed, booking_declined, etc),
// we create a row in InboxMessage so staff see the auto-sent message inline
// with the guest's conversation thread — not hidden in MessageLog. Meta owns
// the literal template body (it's approved on their side), so we render a
// faithful preview here using the same variable positions Meta uses.
//
// Pure function — no I/O — so it can be unit-tested.
const TEMPLATE_PREVIEWS = {
  booking_confirmed: (v) =>
    `🎉 Reserva confirmada!\n\n` +
    `Olá ${v[0] ?? '{{1}}'}! Sua reserva no ${v[1] ?? '{{2}}'} está confirmada.\n\n` +
    `📅 Check-in: ${v[2] ?? '{{3}}'}\n` +
    `📅 Check-out: ${v[3] ?? '{{4}}'}\n` +
    `💰 Total: R$ ${v[4] ?? '{{5}}'}\n\n` +
    `Estamos ansiosos para recebê-lo. Alguma dúvida, é só responder esta mensagem.`,

  booking_declined: (v) =>
    `Olá ${v[0] ?? '{{1}}'}, infelizmente não conseguiremos confirmar sua reserva.\n\n` +
    `Motivo: ${v[1] ?? '{{2}}'}\n\n` +
    `Adoraríamos recebê-lo em outra data — é só entrar em contato por aqui e vamos verificar disponibilidade juntos.`,

  checkin_boas_vindas: (v) =>
    `Bem-vindo, ${v[0] ?? '{{1}}'}!\n\n` +
    `Seu check-in está marcado para ${v[1] ?? '{{2}}'}.\n` +
    `📶 WiFi: ${v[2] ?? '{{3}}'} · 🔑 ${v[3] ?? '{{4}}'}\n` +
    `Emergência: ${v[4] ?? '{{5}}'}`,
};

function renderTemplatePreview(templateName, vars = []) {
  const renderer = TEMPLATE_PREVIEWS[templateName];
  const raw = renderer
    ? renderer(vars)
    : `[${templateName}] ${vars.join(' · ')}`;
  // Truncate to 1000 chars so the InboxMessage body column stays manageable
  // and the conversation list preview doesn't get overwhelmed by a huge note.
  return raw.length > 1000 ? raw.slice(0, 997) + '…' : raw;
}

async function sendTemplate(to, templateName, bodyVars = [], bookingId = null) {
  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID not configured');

  const phone = normalizePhone(to);

  const body = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                phone,
    type:              'template',
    template: {
      name:     templateName,
      language: { code: 'pt_BR' },
      components: bodyVars.length > 0 ? [{
        type:       'body',
        parameters: bodyVars.map(v => ({ type: 'text', text: String(v) })),
      }] : [],
    },
  };

  // Create log entry before sending (status QUEUED)
  const log = await prisma.messageLog.create({
    data: {
      bookingId,
      guestPhone:   phone,
      templateName,
      direction:    'OUTBOUND',
      status:       'QUEUED',
    },
  }).catch(e => { console.error('[wa] log create error:', e.message); return null; });

  try {
    const result = await graphPost(`/${phoneNumberId}/messages`, body);
    const metaMessageId = result.messages?.[0]?.id ?? null;

    if (log) {
      await prisma.messageLog.update({
        where: { id: log.id },
        data:  { status: 'SENT', metaMessageId },
      }).catch(() => {});
    }

    console.log(`[wa] Template "${templateName}" → ${phone} (wamid: ${metaMessageId})`);

    // Mirror the outbound into the guest's conversation thread so admins see
    // the auto-sent message alongside human replies. Best-effort — failing
    // this should never break the template send itself.
    logOutboundToInbox({ phone, templateName, bodyVars, metaMessageId })
      .catch(e => console.error('[wa] logOutboundToInbox error:', e.message));

    return { metaMessageId };
  } catch (err) {
    if (log) {
      await prisma.messageLog.update({
        where: { id: log.id },
        data:  { status: 'FAILED', errorMessage: err.message },
      }).catch(() => {});
    }
    console.error(`[wa] sendTemplate "${templateName}" failed:`, err.message);
    throw err;
  }
}

// ── Send free text ────────────────────────────────────────────────────────────

/**
 * Send a free-text message. ONLY valid within the 24-hour customer service window
 * (i.e. the guest must have messaged first within the last 24h).
 * Use this for replies to inbound messages from the inbox.
 *
 * @param {string}   to        - Recipient phone
 * @param {string}   text      - Message text
 * @param {string|null} bookingId
 */
async function sendText(to, text, bookingId = null) {
  const phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID not configured');

  const phone = normalizePhone(to);

  const body = {
    messaging_product: 'whatsapp',
    recipient_type:    'individual',
    to:                phone,
    type:              'text',
    text:              { preview_url: false, body: text },
  };

  const log = await prisma.messageLog.create({
    data: {
      bookingId,
      guestPhone: phone,
      direction:  'OUTBOUND',
      body:       text.slice(0, 500),
      status:     'QUEUED',
    },
  }).catch(e => { console.error('[wa] log create error:', e.message); return null; });

  try {
    const result = await graphPost(`/${phoneNumberId}/messages`, body);
    const metaMessageId = result.messages?.[0]?.id ?? null;

    if (log) {
      await prisma.messageLog.update({
        where: { id: log.id },
        data:  { status: 'SENT', metaMessageId },
      }).catch(() => {});
    }

    console.log(`[wa] Text → ${phone} (wamid: ${metaMessageId})`);
    return { metaMessageId };
  } catch (err) {
    if (log) {
      await prisma.messageLog.update({
        where: { id: log.id },
        data:  { status: 'FAILED', errorMessage: err.message },
      }).catch(() => {});
    }
    console.error(`[wa] sendText failed:`, err.message);
    throw err;
  }
}

// ── NPS classification ────────────────────────────────────────────────────────

/**
 * @param {number} score - 0-10
 * @returns {'promotor' | 'neutro' | 'detrator'}
 */
function classifyNpsScore(score) {
  if (score >= 9) return 'promotor';
  if (score >= 7) return 'neutro';
  return 'detrator';
}

// ── Webhook processing ────────────────────────────────────────────────────────

/**
 * Process a raw Meta webhook payload.
 * Handles: delivery status updates + inbound text messages (NPS replies + inbox).
 *
 * Called from POST /api/webhooks/whatsapp — response already sent to Meta before calling this.
 */
async function processWebhook(payload) {
  const entries = payload.entry ?? [];
  for (const entry of entries) {
    for (const change of (entry.changes ?? [])) {
      if (change.field !== 'messages') continue;
      const value = change.value;

      // ── Delivery status updates ─────────────────────────────────────────────
      for (const status of (value.statuses ?? [])) {
        const dbStatus = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' }[status.status];
        if (dbStatus && status.id) {
          await prisma.messageLog.updateMany({
            where: { metaMessageId: status.id },
            data:  { status: dbStatus },
          }).catch(() => {});
        }
      }

      // ── Inbound messages ────────────────────────────────────────────────────
      for (const msg of (value.messages ?? [])) {
        if (msg.type !== 'text') continue;

        const fromPhone  = normalizePhone(msg.from);
        const text       = (msg.text?.body ?? '').trim();
        const timestamp  = new Date(parseInt(msg.timestamp, 10) * 1000);

        console.log(`[wa] Inbound from ${fromPhone}: "${text.slice(0, 60)}"`);

        // Log inbound message
        await prisma.messageLog.create({
          data: {
            guestPhone:    fromPhone,
            direction:     'INBOUND',
            body:          text.slice(0, 500),
            status:        'READ',
            metaMessageId: msg.id,
            sentAt:        timestamp,
          },
        }).catch(() => {});

        // Store in Conversation inbox (non-blocking)
        storeInboxMessage(fromPhone, text, timestamp).catch(e =>
          console.error('[wa] storeInboxMessage error:', e.message)
        );

        // Check if this is an NPS reply (0-10 number)
        handlePotentialNpsReply(fromPhone, text).catch(e =>
          console.error('[wa] handlePotentialNpsReply error:', e.message)
        );
      }
    }
  }
}

// ── Inbox storage ─────────────────────────────────────────────────────────────

/**
 * Mirror an automated OUTBOUND template send into the guest's conversation
 * thread. Looks up the active property, finds or creates a Conversation by
 * phone, and appends an InboxMessage row. Called best-effort from sendTemplate.
 *
 * NOTE: does not bump unreadCount (the admin doesn't need a red badge for
 * messages the system sent on their behalf).
 */
async function logOutboundToInbox({ phone, templateName, bodyVars, metaMessageId }) {
  const property = await prisma.property.findFirst({ where: { active: true } });
  if (!property) return;

  const normalized = normalizePhone(phone);
  const body = renderTemplatePreview(templateName, bodyVars);
  const sentAt = new Date();

  let conversation = await prisma.conversation.findFirst({
    where: { propertyId: property.id, contactPhone: normalized },
  });
  if (!conversation) {
    // First outbound to a new contact — create a conversation so future
    // inbound replies land in the same thread.
    const booking = await prisma.booking.findFirst({
      where:   { guestPhone: { contains: normalized.replace(/\D/g, '').slice(-11) } },
      orderBy: { createdAt: 'desc' },
      select:  { guestName: true },
    });
    conversation = await prisma.conversation.create({
      data: {
        propertyId:    property.id,
        contactName:   booking?.guestName || normalized,
        contactPhone:  normalized,
        lastMessageAt: sentAt,
        unreadCount:   0,
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: sentAt },
    });
  }

  await prisma.inboxMessage.create({
    data: {
      conversationId: conversation.id,
      direction:      'OUTBOUND',
      channel:        'WHATSAPP',
      body,
      isAiAgent:      true,   // marks the row as system/automated (staffId null)
      sentAt,
    },
  });
}

async function storeInboxMessage(phone, body, sentAt) {
  const property = await prisma.property.findFirst({ where: { active: true } });
  if (!property) return;

  // Look up contact name from most-recent booking with this phone
  const phoneDigits = phone.replace(/\D/g, '').slice(-11); // last 11 digits
  const booking = await prisma.booking.findFirst({
    where:   { guestPhone: { contains: phoneDigits } },
    orderBy: { createdAt: 'desc' },
    select:  { guestName: true },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { propertyId: property.id, contactPhone: phone },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        propertyId:    property.id,
        contactName:   booking?.guestName || phone,
        contactPhone:  phone,
        lastMessageAt: sentAt,
        unreadCount:   1,
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data:  { lastMessageAt: sentAt, unreadCount: { increment: 1 } },
    });
  }

  await prisma.inboxMessage.create({
    data: {
      conversationId: conversation.id,
      direction:      'INBOUND',
      channel:        'WHATSAPP',
      body,
      sentAt,
    },
  });

  // Push notification to admin staff with inbox push enabled
  prisma.staffMember.findMany({
    where:  { role: 'ADMIN', active: true, inboxPushEnabled: true, NOT: { pushSubscription: null } },
    select: { id: true },
  }).then(admins => {
    const { sendPushToStaff } = require('./push');
    return Promise.allSettled(
      admins.map(a => sendPushToStaff(a.id, {
        title: `Nova mensagem WA — ${conversation.contactName}`,
        body:  body.length > 80 ? body.slice(0, 80) + '…' : body,
        type:  'INBOX_MESSAGE',
        data:  { conversationId: conversation.id },
      }))
    );
  }).catch(() => {});
}

// ── NPS reply handler ─────────────────────────────────────────────────────────

async function handlePotentialNpsReply(phone, text) {
  const score = parseInt(text.replace(/[^0-9]/g, ''), 10);
  if (isNaN(score) || score < 0 || score > 10 || text.replace(/[^0-9]/g, '') !== text.trim()) return;

  // Find most-recent booking for this phone with a pending NPS survey
  const phoneDigits = phone.replace(/\D/g, '').slice(-11);
  const booking = await prisma.booking.findFirst({
    where: {
      surveyStatus: 'ENVIADO',
      guestPhone:   { contains: phoneDigits },
      survey:       { npsScore: null },
    },
    include: {
      survey: true,
      property: { select: { id: true, googleReviewUrl: true } },
    },
    orderBy: { checkOut: 'desc' },
  });

  if (!booking?.survey) return;

  const classification = classifyNpsScore(score);

  await prisma.survey.update({
    where: { id: booking.survey.id },
    data: {
      npsScore:          score,
      npsClassification: classification,
      respondedAt:       new Date(),
      adminAlerted:      false,  // reset so cron picks it up for push notification
    },
  });

  await prisma.booking.update({
    where: { id: booking.id },
    data:  { surveyStatus: 'RESPONDIDO' },
  });

  console.log(`[wa] NPS reply: ${booking.guestName} → ${score}/10 (${classification})`);

  // Resolve follow-up template name from DB (fallback to convention)
  const lookupTemplate = async (triggerEvent, fallback) => {
    const t = await prisma.messageTemplate.findUnique({ where: { triggerEvent } });
    return t?.active ? t.name : fallback;
  };

  if (classification === 'promotor') {
    const reviewUrl = booking.property?.googleReviewUrl || GOOGLE_REVIEW_URL;
    const tmpl = await lookupTemplate('nps_promotor_review', 'nps_promotor_review');
    await sendTemplate(phone, tmpl, [booking.guestName, reviewUrl], booking.id);
    await prisma.survey.update({
      where: { id: booking.survey.id },
      data:  { googleReviewLinkSent: true, npsFollowUpSent: true },
    });
  } else if (classification === 'detrator') {
    // 1. Send the existing apology template (preserved behavior)
    const tmpl = await lookupTemplate('nps_followup_apology', 'nps_agradecimento_melhoria');
    await sendTemplate(phone, tmpl, [booking.guestName], booking.id);

    // 2. Create a StaffTask for admin follow-up
    const defaultAdmin = await prisma.staffMember.findFirst({
      where:  { role: 'ADMIN', active: true },
      select: { id: true },
    });
    if (defaultAdmin) {
      await prisma.staffTask.create({
        data: {
          assignedToId: defaultAdmin.id,
          assignedById: defaultAdmin.id,
          bookingId:    booking.id,
          title:        `Follow-up detrator: ${booking.guestName} (NPS ${score})`,
          description:  booking.survey?.comment || 'Sem comentário adicional do hóspede.',
          dueDate:      new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      }).catch(e => console.error('[whatsapp] detractor task create failed:', e.message));
    }

    // 3. Send distinct urgent push to all admins
    await sendPushToRole('ADMIN', {
      title: `🚨 Detrator NPS ${score}: ${booking.guestName}`,
      body:  (booking.survey?.comment || '').slice(0, 140) || 'Tap para detalhes',
      type:  'NPS_DETRACTOR',
      data:  { bookingId: booking.id, priority: 'high' },
    }).catch(e => console.error('[whatsapp] detractor push failed:', e.message));

    // 4. Update Survey flags so the 2h alerts cron skips this one
    await prisma.survey.update({
      where: { id: booking.survey.id },
      data:  { npsFollowUpSent: true, adminAlerted: true },
    });
  } else {
    // neutro: just thank the guest, mark followup sent
    const tmpl = await lookupTemplate('nps_followup_apology', 'nps_agradecimento_melhoria');
    await sendTemplate(phone, tmpl, [booking.guestName], booking.id).catch(() => {});
    await prisma.survey.update({
      where: { id: booking.survey.id },
      data:  { npsFollowUpSent: true },
    });
  }
}

// ── Template seeder ───────────────────────────────────────────────────────────

/**
 * Seeds default MessageTemplate records on startup (upsert — safe to re-run).
 * Admins can update the `name` field via UI to point to their approved Meta template.
 */
async function seedTemplates() {
  const defaults = [
    {
      name:         'nps_pesquisa',
      description:  'Pesquisa NPS enviada após checkout — guest responde com número 0-10',
      triggerEvent: 'post_checkout_nps',
      variables:    [{ index: 1, key: 'nome', label: 'Nome do hóspede' }],
    },
    {
      name:         'nps_promotor_review',
      description:  'Solicitação de avaliação Google para hóspedes promotores (nota 9-10)',
      triggerEvent: 'nps_promotor_review',
      variables:    [
        { index: 1, key: 'nome',  label: 'Nome do hóspede' },
        { index: 2, key: 'link',  label: 'Link do Google Review' },
      ],
    },
    {
      name:         'nps_agradecimento_melhoria',
      description:  'Mensagem de agradecimento e pedido de detalhes para neutros/detratores (0-8)',
      triggerEvent: 'nps_followup_apology',
      variables:    [{ index: 1, key: 'nome', label: 'Nome do hóspede' }],
    },
    {
      name:         'lembrete_lista_hospedes',
      description:  'Lembrete D-7 solicitando lista de hóspedes e veículos',
      triggerEvent: 'guest_list_reminder',
      variables:    [
        { index: 1, key: 'nome',        label: 'Nome do hóspede' },
        { index: 2, key: 'data_checkin', label: 'Data de check-in' },
        { index: 3, key: 'prazo',       label: 'Prazo para envio (D-4)' },
      ],
    },
    {
      name:         'permissao_manutencao_piscina',
      description:  'Pedido de permissão para visita do piscineiro em estadias ≥ 5 noites',
      triggerEvent: 'pool_maintenance_permission',
      variables:    [
        { index: 1, key: 'nome',        label: 'Nome do hóspede' },
        { index: 2, key: 'data_checkin', label: 'Data de check-in' },
        { index: 3, key: 'noites',      label: 'Número de noites' },
      ],
    },
    {
      name:         'checkin_boas_vindas',
      description:  'Mensagem de boas-vindas enviada no dia do check-in com senha do WiFi e contato de emergência',
      triggerEvent: 'checkin_boas_vindas',
      variables:    [
        { index: 1, key: 'nome',        label: 'Primeiro nome do hóspede' },
        { index: 2, key: 'data_checkin', label: 'Data de check-in (ex: 20/04/2026)' },
        { index: 3, key: 'wifi_rede',   label: 'Nome da rede WiFi (SSID)' },
        { index: 4, key: 'wifi_senha',  label: 'Senha do WiFi' },
        { index: 5, key: 'emergencia',  label: 'Telefone de emergência da propriedade' },
      ],
    },
    {
      name:         'booking_confirmed',
      description:  'Reserva confirmada pelo admin — envia ao hóspede após clicar "Confirmar" no staff app',
      triggerEvent: 'booking_confirmed',
      variables:    [
        { index: 1, key: 'nome',          label: 'Primeiro nome do hóspede' },
        { index: 2, key: 'propriedade',   label: 'Nome da propriedade (ex: Recanto dos Ipês)' },
        { index: 3, key: 'data_checkin',  label: 'Data de check-in (DD/MM/YYYY)' },
        { index: 4, key: 'data_checkout', label: 'Data de check-out (DD/MM/YYYY)' },
        { index: 5, key: 'total',         label: 'Valor total (ex: 1.250,00)' },
      ],
    },
    {
      name:         'booking_declined',
      description:  'Reserva recusada pelo admin — comunica a decisão com empatia e inclui o motivo',
      triggerEvent: 'booking_declined',
      variables:    [
        { index: 1, key: 'nome',           label: 'Primeiro nome do hóspede' },
        { index: 2, key: 'motivo_recusa',  label: 'Motivo da recusa (adminDeclineNote)' },
      ],
    },
  ];

  for (const tpl of defaults) {
    await prisma.messageTemplate.upsert({
      where:  { triggerEvent: tpl.triggerEvent },
      create: tpl,
      update: { description: tpl.description, variables: tpl.variables }, // never overwrite admin-edited name
    });
  }

  console.log('[wa] Message templates seeded');
}

// ── Check-in welcome (WiFi + access info) ────────────────────────────────────

/**
 * Sends the checkin_boas_vindas WhatsApp template to a guest checking in today.
 * Pulls WiFi credentials from property.accessInfo automatically — admin only
 * needs to keep the DB field up-to-date via the staff app property settings.
 *
 * @param {object} booking  - { id, guestName, guestPhone, checkIn }
 * @param {object} property - { accessInfo: { wifi: { ssid, password }, checkin: { emergency } } }
 */
async function sendCheckinWelcome(booking, property) {
  if (!booking.guestPhone) {
    throw new Error('Booking has no guestPhone');
  }

  const accessInfo = property?.accessInfo || {};
  const wifi       = accessInfo.wifi       || {};
  const checkin    = accessInfo.checkin    || {};

  // Resolve template name from DB so admin can change it without a redeploy
  const tpl = await prisma.messageTemplate.findUnique({
    where: { triggerEvent: 'checkin_boas_vindas' },
  });
  const templateName = tpl?.active ? tpl.name : 'checkin_boas_vindas';

  // Format check-in date as DD/MM/YYYY
  const checkInDate = booking.checkIn instanceof Date
    ? booking.checkIn.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const firstName  = (booking.guestName || '').split(' ')[0] || 'Hóspede';
  const wifiSsid   = wifi.ssid     || 'Pergunte na recepção';
  const wifiPass   = wifi.password || 'Pergunte na recepção';
  const emergency  = checkin.emergency || '+55 31 2391-6688';

  return sendTemplate(
    booking.guestPhone,
    templateName,
    [firstName, checkInDate, wifiSsid, wifiPass, emergency],
    booking.id
  );
}

// ── High-level booking status helpers ────────────────────────────────────────

/**
 * Fire booking_confirmed WA template to the guest when admin confirms a
 * REQUESTED booking. Best-effort — swallows errors (logged inside) so it
 * never blocks the /confirmar endpoint.
 */
async function sendBookingConfirmedWA(booking, property) {
  if (!booking?.guestPhone) return { skipped: 'no_phone' };
  const firstName    = (booking.guestName || '').split(' ')[0] || 'hóspede';
  const propertyName = property?.name || 'Recanto dos Ipês';
  const fmt          = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
  const total        = Number(booking.totalAmount || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    return await sendTemplate(
      booking.guestPhone,
      'booking_confirmed',
      [firstName, propertyName, fmt(booking.checkIn), fmt(booking.checkOut), total],
      booking.id
    );
  } catch (e) {
    console.error('[wa] sendBookingConfirmedWA error:', e.message);
    return { error: e.message };
  }
}

/**
 * Fire booking_declined WA template when admin declines. Includes the admin's
 * typed reason so the guest has context. Best-effort like the above.
 */
async function sendBookingDeclinedWA(booking) {
  if (!booking?.guestPhone) return { skipped: 'no_phone' };
  const firstName = (booking.guestName || '').split(' ')[0] || 'hóspede';
  const reason    = (booking.adminDeclineNote || '').trim() || 'não conseguimos confirmar nesta data';
  try {
    return await sendTemplate(
      booking.guestPhone,
      'booking_declined',
      [firstName, reason],
      booking.id
    );
  } catch (e) {
    console.error('[wa] sendBookingDeclinedWA error:', e.message);
    return { error: e.message };
  }
}

module.exports = {
  sendTemplate,
  sendText,
  sendCheckinWelcome,
  sendBookingConfirmedWA,
  sendBookingDeclinedWA,
  classifyNpsScore,
  normalizePhone,
  processWebhook,
  seedTemplates,
  // Exposed for unit tests (pure function, no side effects).
  renderTemplatePreview,
};
