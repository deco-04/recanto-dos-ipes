// routes/push.js — Guest Web Push subscription management
// Mounted at: /api/push
'use strict';

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');

// ── Auth guard ────────────────────────────────────────────────────────────────
function requireGuest(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  next();
}

// ── GET /api/push/vapid-key ───────────────────────────────────────────────────
// Returns the VAPID public key needed for PushManager.subscribe().
// Public endpoint — no auth required (key is safe to expose).
router.get('/vapid-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Push notifications não disponíveis' });
  }
  res.json({ publicKey: key });
});

// ── POST /api/push/subscribe ──────────────────────────────────────────────────
// Saves (or replaces) the guest's push subscription object.
// Body: { subscription: PushSubscription }
router.post('/subscribe', requireGuest, async (req, res) => {
  const { subscription } = req.body;

  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: 'Subscription inválida' });
  }

  try {
    await prisma.user.update({
      where: { id: req.session.userId },
      data:  { pushSubscription: subscription },
    });
    console.log(`[push] Guest ${req.session.userId} subscribed to push notifications`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar subscription' });
  }
});

// ── POST /api/push/unsubscribe ────────────────────────────────────────────────
// Clears the guest's push subscription (opt-out or browser unregister).
router.post('/unsubscribe', requireGuest, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.session.userId },
      data:  { pushSubscription: null },
    });
    console.log(`[push] Guest ${req.session.userId} unsubscribed from push notifications`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao remover subscription' });
  }
});

// ── GET /api/push/status ──────────────────────────────────────────────────────
// Returns whether the authenticated guest has an active push subscription.
router.get('/status', requireGuest, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.session.userId },
      select: { pushSubscription: true },
    });
    res.json({ subscribed: !!user?.pushSubscription });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
