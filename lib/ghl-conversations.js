'use strict';

/**
 * GHL Conversations API client.
 *
 * Used by:
 *   - lib/cron.js → 2-min poll that mirrors OUTBOUND messages from GHL
 *     (since GHL has no "Outbound Sent" workflow trigger)
 *   - routes/mensagens.js → staff-send path. When GHL_API_KEY is set we
 *     route POST /:id/mensagens through GHL's hub so it picks the
 *     correct channel; falls back to the existing direct paths on auth
 *     or network failure.
 *
 * Auth note: the user's PIT may be missing scopes
 * (conversations.readonly + conversations/message.readonly +
 *  conversations/message.write + contacts.readonly). Every helper
 * returns { ok: false, status: 401, error } instead of throwing so
 * callers can degrade gracefully — the cron just logs and skips, the
 * staff send falls back to direct.
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
// Conversations API Version. GHL versions different surfaces with different
// dates; conversations is on 2021-04-15 per their public docs as of 2026-04.
const VERSION  = '2021-04-15';

/**
 * @typedef {Object} GhlMessage
 * @property {string} id              GHL message id (used as InboxMessage.ghlMessageId)
 * @property {'inbound'|'outbound'} direction
 * @property {string} body            Message text
 * @property {string} dateAdded       ISO timestamp
 * @property {string} messageType     'SMS' | 'Email' | 'WhatsApp' | 'IG' | 'FB' | 'GMB' | 'TYPE_*'
 * @property {string|null} userId     null when AI/automation sent it; populated for human staff in GHL UI
 * @property {string} conversationId
 */

async function ghlRequest(method, path, body) {
  if (!process.env.GHL_API_KEY) {
    return { ok: false, status: 0, error: 'no-api-key' };
  }
  const url = `${GHL_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization:  `Bearer ${process.env.GHL_API_KEY}`,
        Version:        VERSION,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    return {
      ok:     false,
      status: res.status,
      error:  data?.message || text || res.statusText,
      raw:    data,
    };
  }
  return { ok: true, status: res.status, data };
}

/**
 * Search conversations for the configured location.
 * GHL endpoint: GET /conversations/search?locationId=...&limit=...
 *
 * @param {object} opts
 * @param {string} [opts.locationId]         defaults to GHL_COMPANY_ID env
 * @param {number} [opts.limit=50]
 * @param {string|number|Date|null} [opts.lastMessageAfter] passed as `lastMessageDate` query param (ISO)
 * @returns {Promise<{ ok: boolean, conversations: Array, error?: string, status?: number }>}
 */
async function searchConversations({ locationId, limit = 50, lastMessageAfter = null } = {}) {
  const loc = locationId || process.env.GHL_COMPANY_ID;
  const params = new URLSearchParams({ locationId: loc || '', limit: String(limit) });
  if (lastMessageAfter) params.set('lastMessageDate', new Date(lastMessageAfter).toISOString());
  const result = await ghlRequest('GET', `/conversations/search?${params}`);
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status, conversations: [] };
  }
  return { ok: true, conversations: result.data?.conversations || [] };
}

/**
 * Fetch messages for a single conversation, newest first.
 * GHL endpoint: GET /conversations/:id/messages?limit=...
 *
 * Response envelopes have varied across GHL releases — we accept both:
 *   { messages: { messages: [...] } }   (wrapped)
 *   { messages: [...] }                  (flat)
 *
 * @param {string} conversationId
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @returns {Promise<{ ok: boolean, messages: GhlMessage[], error?: string, status?: number }>}
 */
async function getConversationMessages(conversationId, { limit = 20 } = {}) {
  const result = await ghlRequest('GET', `/conversations/${conversationId}/messages?limit=${limit}`);
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status, messages: [] };
  }
  const wrapped = result.data?.messages?.messages;
  const flat    = result.data?.messages;
  const arr = Array.isArray(wrapped) ? wrapped : Array.isArray(flat) ? flat : [];
  return { ok: true, messages: arr };
}

/**
 * Send a message via GHL — GHL handles channel routing based on conversationId.
 * GHL endpoint: POST /conversations/messages
 *
 * @param {object} args
 * @param {string} args.conversationId
 * @param {string} args.type           'WhatsApp' | 'IG' | 'FB' | 'GMB' | 'SMS' | 'Email'
 * @param {string} args.body
 * @param {string|null} [args.contactId]
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string, status?: number }>}
 */
async function sendMessage({ conversationId, type, body, contactId = null }) {
  const payload = { type, conversationId, message: body };
  if (contactId) payload.contactId = contactId;
  const result = await ghlRequest('POST', '/conversations/messages', payload);
  if (!result.ok) {
    return { ok: false, error: result.error, status: result.status };
  }
  return { ok: true, messageId: result.data?.messageId || result.data?.id };
}

module.exports = { searchConversations, getConversationMessages, sendMessage };
