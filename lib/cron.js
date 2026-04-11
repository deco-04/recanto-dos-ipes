'use strict';

const cron   = require('node-cron');
const prisma = require('./db');
const { syncAll } = require('./ical-sync');

/**
 * Starts all scheduled background jobs.
 * Called once at server startup.
 */
function startCronJobs() {
  // iCal sync — every hour at minute 7 (avoids thundering herd at :00)
  cron.schedule('7 * * * *', async () => {
    console.log('[cron] Starting hourly iCal sync…');
    const results = await syncAll();
    for (const r of results) {
      if (r.error) {
        console.error(`[cron] ${r.source} failed: ${r.error}`);
      } else {
        console.log(`[cron] ${r.source}: synced ${r.synced} dates, removed ${r.deleted}`);
      }
    }
  });

  // OTP cleanup — daily at 03:00 UTC
  // Deletes verification codes older than 24 h (used, expired, or abandoned).
  // Keeps the table lean and removes any sensitive codes no longer needed.
  cron.schedule('0 3 * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const { count } = await prisma.verificationCode.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      console.log(`[cron] OTP cleanup: removed ${count} expired verification codes`);
    } catch (err) {
      console.error('[cron] OTP cleanup failed:', err.message);
    }
  });

  // Stale PENDING booking cleanup — every 30 minutes
  // Cancels bookings stuck in PENDING for > 2 hours (payment never completed).
  // Frees up the availability calendar and prevents ghost-blocked dates.
  // Safe to run: a PENDING booking means the Stripe PaymentIntent was created but
  // never charged — there is nothing to refund.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const { count } = await prisma.booking.updateMany({
        where: {
          status:    'PENDING',
          createdAt: { lt: twoHoursAgo },
        },
        data: { status: 'CANCELLED' },
      });
      if (count > 0) {
        console.log(`[cron] Stale PENDING cleanup: cancelled ${count} abandoned booking(s)`);
      }
    } catch (err) {
      console.error('[cron] Stale PENDING cleanup failed:', err.message);
    }
  });

  console.log('[cron] Jobs scheduled: iCal sync (hourly :07) · OTP cleanup (daily 03:00 UTC) · Stale PENDING cleanup (every 30 min)');
}

module.exports = { startCronJobs };
