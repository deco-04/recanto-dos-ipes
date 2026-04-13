'use strict';

const cron   = require('node-cron');
const prisma = require('./db');
const { syncAll }        = require('./ical-sync');
const { sendPushToUser } = require('./push');
const { runRetention, RETENTION_MONTHS } = require('./retention');

/**
 * Starts all scheduled background jobs.
 * Called once at server startup.
 */
function startCronJobs() {
  // iCal sync — every 5 minutes (only when iCal URLs are configured)
  if (process.env.AIRBNB_ICAL_URL || process.env.BOOKING_COM_ICAL_URL) {
    cron.schedule('*/5 * * * *', async () => {
      console.log('[cron] Starting iCal sync…');
      const results = await syncAll();
      for (const r of results) {
        if (r.error) {
          console.error(`[cron] ${r.source} failed: ${r.error}`);
        } else {
          const parts = [`synced ${r.synced} dates, removed ${r.deleted}`];
          if (r.bookingsCreated)   parts.push(`+${r.bookingsCreated} new booking(s)`);
          if (r.bookingsCancelled) parts.push(`-${r.bookingsCancelled} cancelled`);
          console.log(`[cron] ${r.source}: ${parts.join(' · ')}`);
        }
      }
    });
  }

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

  // ── Check-in reminder push — daily at 10:00 BRT (13:00 UTC) ─────────────────
  // Sends a push notification to guests whose check-in is tomorrow.
  cron.schedule('0 13 * * *', async () => {
    try {
      const today    = new Date();
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(today.getUTCDate() + 1);

      const tomorrowDate = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD

      const bookings = await prisma.booking.findMany({
        where: {
          status:  'CONFIRMED',
          checkIn: new Date(tomorrowDate),
          userId:  { not: null },
        },
        select: {
          id:         true,
          userId:     true,
          guestName:  true,
          checkIn:    true,
          checkOut:   true,
          nights:     true,
          hasPet:     true,
        },
      });

      if (bookings.length === 0) return;

      let sent = 0;
      for (const booking of bookings) {
        const checkinFmt  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
        const checkoutFmt = new Date(booking.checkOut).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
        const nightsLabel = booking.nights === 1 ? '1 noite' : `${booking.nights} noites`;

        const result = await sendPushToUser(booking.userId, {
          title: 'Seu check-in é amanhã! 🌿',
          body:  `${checkinFmt} · ${nightsLabel} até ${checkoutFmt}. Estamos prontos para recebê-lo(a)!`,
          type:  'CHECKIN_REMINDER',
          data:  { bookingId: booking.id, url: '/dashboard' },
        });

        if (result) sent++;
      }

      if (sent > 0) {
        console.log(`[cron] Check-in reminders: sent push to ${sent}/${bookings.length} guest(s)`);
      }
    } catch (err) {
      console.error('[cron] Check-in reminder push failed:', err.message);
    }
  });

  // ── Post-checkout survey push — daily at 12:00 BRT (15:00 UTC) ───────────────
  // Sends a push notification to guests whose checkout was yesterday and
  // haven't received a survey yet.
  cron.schedule('0 15 * * *', async () => {
    try {
      const today     = new Date();
      const yesterday = new Date(today);
      yesterday.setUTCDate(today.getUTCDate() - 1);

      const yesterdayDate = yesterday.toISOString().slice(0, 10);

      const bookings = await prisma.booking.findMany({
        where: {
          status:       'CONFIRMED',
          checkOut:     new Date(yesterdayDate),
          userId:       { not: null },
          surveyStatus: 'NAO_ENVIADO',
        },
        select: {
          id:       true,
          userId:   true,
          guestName: true,
        },
      });

      if (bookings.length === 0) return;

      let sent = 0;
      for (const booking of bookings) {
        const result = await sendPushToUser(booking.userId, {
          title: 'Como foi sua estadia? ⭐',
          body:  'Esperamos que tenha curtido cada momento no Recanto dos Ipês. Sua avaliação é muito importante para nós!',
          type:  'SURVEY_REQUEST',
          data:  { bookingId: booking.id, url: '/dashboard' },
        });

        if (result) sent++;
      }

      if (sent > 0) {
        console.log(`[cron] Post-checkout survey push: sent to ${sent}/${bookings.length} guest(s)`);
      }
    } catch (err) {
      console.error('[cron] Post-checkout survey push failed:', err.message);
    }
  });

  // ── Media retention — 1st of each month at 04:00 UTC ────────────────────────
  // Purges original photos/videos older than RETENTION_MONTHS (default 6).
  // Thumbnails for photos are generated and kept forever.
  // All DB records, booking details, and checklist data are kept forever.
  cron.schedule('0 4 1 * *', async () => {
    console.log(`[cron] Media retention: purging originals older than ${RETENTION_MONTHS} months…`);
    try {
      const { photosProcessed, videosProcessed, errors } = await runRetention();
      console.log(`[cron] Retention complete: ${photosProcessed} photo(s), ${videosProcessed} video(s) purged${errors ? `, ${errors} error(s)` : ''}`);
    } catch (err) {
      console.error('[cron] Retention job failed:', err.message);
    }
  });

  console.log(`[cron] Jobs scheduled: iCal sync (every 5 min) · OTP cleanup (daily 03:00 UTC) · Stale PENDING cleanup (every 30 min) · Check-in reminders (daily 13:00 UTC) · Survey push (daily 15:00 UTC) · Media retention (monthly 04:00 UTC, ${RETENTION_MONTHS}mo policy)`);
}

module.exports = { startCronJobs };
