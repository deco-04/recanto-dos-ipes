'use strict';

/**
 * GHL Social Planner — published webhook (Gap #4)
 *
 * Mounted at /api/webhooks/ghl-social (no auth — gated by static token in body
 * or header, matching the GHL inbound-message webhook pattern in mensagens.js).
 *
 * GHL Social Planner can fire a workflow webhook when a scheduled post
 * actually publishes. We use that signal to flip our local
 * `ContentPost.stage` from AGENDADO → PUBLICADO and stamp `publishedAt`.
 *
 * Why a custom token (and not HMAC):
 *   GHL's no-code Workflow → Webhook trigger doesn't sign payloads — it just
 *   POSTs JSON to a URL. The codebase's existing inbound-from-GHL webhook
 *   (`/api/webhooks/ghl-message`) uses the same shared-secret strategy.
 *   We match it for operational consistency: one secret, one rotation flow.
 *
 * Configure GHL → Workflow → Trigger: "Social Planner Post Published"
 *                          → Action:  "Webhook"  POST to:
 *   https://<your-host>/api/webhooks/ghl-social?secret=$GHL_WEBHOOK_SECRET
 * Body must contain at least:
 *   { "postId": "<the GHL post id>", "status": "PUBLISHED",
 *     "publishedAt": "<optional ISO timestamp, defaults to now>" }
 *
 * Idempotent — re-firing the webhook for the same postId is a no-op once the
 * row is already PUBLICADO.
 */

const express = require('express');
const crypto  = require('crypto');

/**
 * Factory — returns an Express router with the prisma instance bound in.
 * Tests pass a mock prisma; production passes the real one.
 *
 * @param {object} deps
 * @param {object} deps.prisma   - Prisma client (or test double)
 * @param {function} [deps.now]  - clock injection for deterministic tests
 */
function createGhlSocialWebhookRouter({ prisma, now = () => new Date() } = {}) {
  if (!prisma) throw new Error('createGhlSocialWebhookRouter: prisma required');

  const router = express.Router();

  router.post('/', async (req, res) => {
    const secret = process.env.GHL_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[ghl-social-webhook] GHL_WEBHOOK_SECRET not set — rejecting');
      return res.status(500).json({ error: 'Webhook not configured' });
    }

    // Accept secret from either header or query — same dual-path as ghl-message.
    // Use timing-safe compare to defeat naive timing attacks.
    const provided = req.headers['x-webhook-secret'] || req.query.secret || '';
    const secretBuf   = Buffer.from(secret);
    const providedBuf = Buffer.from(String(provided));
    if (
      providedBuf.length !== secretBuf.length ||
      !crypto.timingSafeEqual(providedBuf, secretBuf)
    ) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // GHL uses different field names in different products — accept several
    // common shapes so the workflow-builder admin doesn't need to massage it.
    const postId      = req.body?.postId || req.body?.id || req.body?.ghlPostId;
    const rawStatus   = String(req.body?.status || req.body?.state || '').toUpperCase();
    const publishedAt = req.body?.publishedAt
      ? new Date(req.body.publishedAt)
      : now();

    if (!postId) {
      return res.status(400).json({ error: 'postId required' });
    }

    // Only act on terminal "the post went live" signal. Other states (failed,
    // cancelled) we log but don't auto-mutate — admin reviews manually.
    const isPublished = ['PUBLISHED', 'POSTED', 'COMPLETE', 'COMPLETED', 'SUCCESS'].includes(rawStatus);
    if (!isPublished) {
      console.log(`[ghl-social-webhook] postId=${postId} status=${rawStatus} — ignoring (not a publish event)`);
      return res.json({ ok: true, skipped: true, reason: 'not a publish event' });
    }

    try {
      const post = await prisma.contentPost.findFirst({ where: { ghlPostId: postId } });
      if (!post) {
        // Likely a race or a post for a different env — log and 200 so GHL
        // doesn't keep retrying.
        console.warn(`[ghl-social-webhook] no ContentPost for ghlPostId=${postId}`);
        return res.json({ ok: true, skipped: true, reason: 'no matching post' });
      }

      // Idempotency — don't double-stamp publishedAt and don't downgrade from
      // a later stage either.
      if (post.stage === 'PUBLICADO') {
        return res.json({ ok: true, alreadyPublished: true, postId: post.id });
      }

      const updated = await prisma.contentPost.update({
        where: { id: post.id },
        data:  {
          stage:       'PUBLICADO',
          publishedAt: post.publishedAt || publishedAt,
        },
      });

      console.log(`[ghl-social-webhook] post ${post.id} (ghl=${postId}) → PUBLICADO`);
      return res.json({ ok: true, postId: updated.id, stage: updated.stage });
    } catch (err) {
      console.error('[ghl-social-webhook] error:', err.message);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  });

  return router;
}

module.exports = { createGhlSocialWebhookRouter };
