'use strict';

/**
 * GHL Conversations → InboxMessage mirror helper.
 *
 * Pure function (no cron / no scheduling) — the cron loops over active
 * conversations and calls mirrorGhlMessage() for each GHL message it
 * fetches. Idempotency is enforced via InboxMessage.ghlMessageId @unique:
 * if a message has already been mirrored we skip it.
 *
 * Direction + isAiAgent semantics:
 *   GHL.direction = 'outbound', userId = null   → AI/automation → isAiAgent=true
 *   GHL.direction = 'outbound', userId = "..."  → human staff in GHL UI → isAiAgent=false
 *   GHL.direction = 'inbound'                    → guest → INBOUND, isAiAgent=false
 *     (note: inbound is normally written by the /webhooks/ghl-message route,
 *      so the poll typically only mirrors OUTBOUND. We still handle inbound
 *      for completeness and as a backup if the webhook drops a message.)
 */

const prismaDefault = require('./db');

/**
 * Map GHL channel/messageType strings to our local MsgChannel enum.
 * Returns null for unknown / unsupported channels (caller should skip mirror).
 */
function mapGhlMessageType(type) {
  const t = String(type || '').toUpperCase();
  if (t.includes('WHATSAPP') || t === 'WA' || t === 'TYPE_WHATSAPP')   return 'WHATSAPP';
  if (t.includes('IG') || t.includes('INSTAGRAM'))                     return 'INSTAGRAM';
  if (t.includes('FB') || t.includes('FACEBOOK'))                      return 'FACEBOOK';
  if (t.includes('GMB') || t.includes('GBP') || t.includes('GOOGLE'))  return 'GBP';
  if (t.includes('EMAIL'))                                             return 'EMAIL';
  return null;
}

/**
 * Mirror a single GHL message into our InboxMessage table.
 * Idempotent — uses ghlMessageId @unique to dedup.
 *
 * @param {object} args
 * @param {object} args.ghlMessage      Raw GHL message object
 * @param {object} args.conversation    Local Conversation row (must have id)
 * @param {object} [args.prismaClient]  Defaults to lib/db
 * @returns {Promise<{ mirrored: boolean, reason?: string }>}
 */
async function mirrorGhlMessage({ ghlMessage, conversation, prismaClient = prismaDefault }) {
  if (!ghlMessage?.id || !ghlMessage?.body) {
    return { mirrored: false, reason: 'invalid-payload' };
  }

  const channel = mapGhlMessageType(ghlMessage.messageType);
  if (!channel) {
    return { mirrored: false, reason: 'unknown-channel' };
  }

  const existing = await prismaClient.inboxMessage.findUnique({
    where: { ghlMessageId: ghlMessage.id },
    select: { id: true },
  });
  if (existing) {
    return { mirrored: false, reason: 'already-mirrored' };
  }

  const direction = String(ghlMessage.direction || '').toLowerCase() === 'outbound'
    ? 'OUTBOUND'
    : 'INBOUND';
  // GHL: userId null = AI/automation, userId set = human staff in GHL UI.
  // Only meaningful for OUTBOUND (inbound is always from a guest contact).
  const isAiAgent = direction === 'OUTBOUND' && !ghlMessage.userId;

  await prismaClient.inboxMessage.create({
    data: {
      conversationId: conversation.id,
      direction,
      channel,
      body:           ghlMessage.body,
      isAiAgent,
      sentAt:         ghlMessage.dateAdded ? new Date(ghlMessage.dateAdded) : new Date(),
      ghlMessageId:   ghlMessage.id,
    },
  });
  return { mirrored: true };
}

module.exports = { mapGhlMessageType, mirrorGhlMessage };
