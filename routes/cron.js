'use strict';

/**
 * Cron-triggered maintenance endpoints.
 *
 * Mounted at: /api/staff/cron
 *
 * All endpoints are guarded by the `X-Cron-Secret` header (env var
 * `CRON_SECRET`). They are safe to call from Railway Cron (or any external
 * scheduler) via HTTP. They do NOT require a staff JWT — the cron secret
 * is the sole auth surface.
 */

const express = require('express');
const prisma  = require('../lib/db');

const router = express.Router();

// ── POST /auto-complete-stale-bookings ────────────────────────────────────────
// Flip every CONFIRMED booking whose checkout was > 48h ago to COMPLETED.
// Defensive against the Governanta forgetting to submit a CHECKOUT vistoria
// (the primary path that transitions the booking — see commit a83b6b2).
//
// Body: { dryRun?: boolean }
// Returns: { transitioned: N, ids: [bookingId...], dryRun?: true }
function makeAutoCompleteStaleHandler({ prisma: prismaDep = prisma, now = () => new Date() } = {}) {
  return async function autoCompleteStaleHandler(req, res) {
    const provided = req.headers?.['x-cron-secret'];
    const expected = process.env.CRON_SECRET;
    if (!expected || !provided || provided !== expected) {
      return res.status(401).json({ error: 'Invalid or missing X-Cron-Secret' });
    }

    const dryRun = Boolean(req.body?.dryRun);
    const cutoff = new Date(now().getTime() - 48 * 60 * 60 * 1000);

    try {
      // Prisma's `lt` on a Date is strictly less-than, which gives us the
      // boundary semantics we want: a booking whose checkOut is EXACTLY 48h
      // ago is NOT yet stale. That's important — a guest who checked out at
      // 11:00 today should not be auto-completed at 11:00 two days later.
      const candidates = await prismaDep.booking.findMany({
        where:  { status: 'CONFIRMED', checkOut: { lt: cutoff } },
        select: { id: true, guestName: true, checkOut: true, status: true },
      });

      if (dryRun) {
        return res.json({
          transitioned: 0,
          ids: candidates.map((b) => b.id),
          dryRun: true,
        });
      }

      const transitionedIds = [];
      for (const b of candidates) {
        // Double-defense: never flip anything that isn't CONFIRMED right now.
        // (The findMany where-clause already filters this, but we re-check
        // explicitly so a future refactor of the query can't silently
        // over-flip terminal states.)
        if (b.status !== 'CONFIRMED') continue;

        console.log(
          `[cron] auto-complete booking ${b.id} guestName=${b.guestName ?? '(unknown)'} checkout=${b.checkOut.toISOString()}`,
        );
        await prismaDep.booking.update({
          where: { id: b.id },
          data:  { status: 'COMPLETED' },
        });
        transitionedIds.push(b.id);
      }

      return res.json({
        transitioned: transitionedIds.length,
        ids: transitionedIds,
      });
    } catch (err) {
      console.error('[cron] auto-complete-stale-bookings error:', err);
      return res.status(500).json({ error: err.message || 'Cron job failed' });
    }
  };
}

router.post('/auto-complete-stale-bookings', makeAutoCompleteStaleHandler());

module.exports = router;
module.exports.makeAutoCompleteStaleHandler = makeAutoCompleteStaleHandler;
