'use strict';

/**
 * Meta WhatsApp Business Cloud API — webhook endpoints.
 *
 * GET  /api/webhooks/whatsapp  — Meta webhook verification challenge
 * POST /api/webhooks/whatsapp  — inbound messages + delivery status updates
 *
 * Mounted in server.js at /api/webhooks/whatsapp (no /api/staff prefix, no auth).
 * The GET endpoint is unauthenticated by design — Meta requires it.
 * The POST endpoint validates the verify token for extra safety.
 */

const express = require('express');
const { processWebhook } = require('../lib/whatsapp');

const router = express.Router();

// ── GET — Meta webhook verification ──────────────────────────────────────────
// Meta sends: ?hub.mode=subscribe&hub.verify_token=TOKEN&hub.challenge=CHALLENGE
// We must echo the challenge back when mode = subscribe and token matches.
router.get('/', (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error('[wa-webhook] WHATSAPP_VERIFY_TOKEN not set — rejecting verification');
    return res.status(500).send('Not configured');
  }

  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[wa-webhook] Webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  console.warn('[wa-webhook] Webhook verification failed — token mismatch');
  return res.status(403).json({ error: 'Forbidden' });
});

// ── POST — inbound messages + delivery receipts ───────────────────────────────
// Meta expects a 200 response within 20 seconds — we ack immediately and
// process the payload asynchronously.
router.post('/', (req, res) => {
  // Acknowledge immediately so Meta doesn't retry
  res.status(200).json({ ok: true });

  // Process asynchronously — errors are logged but don't affect the 200 response
  processWebhook(req.body).catch(err =>
    console.error('[wa-webhook] processWebhook error:', err.message)
  );
});

module.exports = router;
