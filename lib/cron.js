'use strict';

const cron   = require('node-cron');
const prisma = require('./db');
const { syncAll }        = require('./ical-sync');
const { sendPushToUser } = require('./push');
const { runRetention, RETENTION_MONTHS } = require('./retention');
const { runAlertRules }                  = require('./alert-rules');
const { sendPushToRole }                 = require('./push');
const { sendGuestListReminder }          = require('./ghl-webhook');
const { createWeeklyPackage }            = require('./conteudo-agent');

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

  // ── Proactive operational alert push — every 30 minutes ─────────────────────
  // Finds URGENTE alerts and pushes to all ADMIN staff.
  // Tracks last-seen alert IDs to avoid spamming the same alert repeatedly.
  const _seenAlertIds = new Set();

  cron.schedule('*/30 * * * *', async () => {
    try {
      const properties = await prisma.property.findMany({
        where:  { active: true },
        select: { id: true, name: true },
      });

      // Run alert rules once per property, reuse results for both push and pruning
      const allCurrentIds = new Set();
      for (const property of properties) {
        const alerts  = await runAlertRules(prisma, property.id);
        alerts.forEach(a => allCurrentIds.add(a.id));

        const urgent  = alerts.filter(a => a.severity === 'URGENTE');
        const newOnes = urgent.filter(a => !_seenAlertIds.has(a.id));

        if (newOnes.length > 0) {
          // Mark as seen so we don't push again until they clear and reappear
          newOnes.forEach(a => _seenAlertIds.add(a.id));

          const sent = await sendPushToRole('ADMIN', {
            title: `⚠️ ${newOnes.length} alerta${newOnes.length > 1 ? 's' : ''} urgente${newOnes.length > 1 ? 's' : ''} — ${property.name}`,
            body:  newOnes.map(a => a.title).join(' · '),
            type:  'IA_ALERTA_URGENTE',
            data:  { url: '/admin/ia-operacoes' },
          });

          if (sent > 0) {
            console.log(`[cron] Alert push: ${newOnes.length} new urgent alert(s) → ${sent} admin(s) notified`);
          }
        }
      }

      // Prune seen IDs that no longer appear in any active property's alert list
      for (const id of _seenAlertIds) {
        if (!allCurrentIds.has(id)) _seenAlertIds.delete(id);
      }
    } catch (err) {
      console.error('[cron] Alert push failed:', err.message);
    }
  });

  // ── D-7 pre-stay guest list reminder — daily at 09:00 BRT (12:00 UTC) ────────
  // Sends a WhatsApp reminder to guests checking in exactly 7 days from now.
  // Also pushes a notification to ADMIN staff.
  cron.schedule('0 12 * * *', async () => {
    try {
      const target = new Date();
      target.setUTCDate(target.getUTCDate() + 7);
      const targetDate = target.toISOString().split('T')[0]; // YYYY-MM-DD

      const bookings = await prisma.booking.findMany({
        where: {
          status:  'CONFIRMED',
          checkIn: new Date(targetDate),
        },
        select: {
          id: true, guestName: true, guestPhone: true, guestEmail: true,
          checkIn: true, checkOut: true, guestCount: true, hasPet: true,
        },
      });

      if (bookings.length === 0) return;

      for (const booking of bookings) {
        // Send WA reminder to guest (non-blocking)
        sendGuestListReminder(booking).catch(e =>
          console.error('[cron] D-7 guest list reminder error:', e.message)
        );

        // Push notification to ADMIN
        sendPushToRole('ADMIN', {
          title: `Lembrete D-7 enviado — ${booking.guestName}`,
          body:  `Check-in em 7 dias. Aguardando lista de hóspedes.`,
          type:  'PRESTAY_REMINDER_SENT',
          data:  { bookingId: booking.id },
        }).catch(() => {});
      }

      console.log(`[cron] D-7 reminders: sent to ${bookings.length} booking(s)`);
    } catch (err) {
      console.error('[cron] D-7 pre-stay reminder failed:', err.message);
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

  // ── AI Content Agent — Monday 10:00 BRT (13:00 UTC) ─────────────────────────
  // Generates weekly content packages for all active brands.
  cron.schedule('0 13 * * 1', async () => {
    console.log('[cron] Running weekly AI content generation...');
    try {
      const property = await prisma.property.findFirst({ where: { active: true } });
      if (!property) return;

      const brands = ['RDI', 'RDS', 'CDS'];
      let totalCreated = 0;

      for (const brand of brands) {
        try {
          const posts = await createWeeklyPackage(brand, property.id);
          totalCreated += posts.length;
          console.log(`[cron] Content: ${posts.length} posts created for ${brand}`);

          sendPushToRole('ADMIN', {
            title: `Conteúdo ${brand} gerado ✨`,
            body:  `${posts.length} posts aguardando revisão`,
            type:  'CONTENT_PACKAGE_READY',
            data:  { brand, propertyId: property.id },
          }).catch(e => console.error('[push] content push error:', e.message));
        } catch (e) {
          console.error(`[cron] Content generation failed for ${brand}:`, e.message);
        }
      }

      console.log(`[cron] Content generation complete: ${totalCreated} posts created`);
    } catch (err) {
      console.error('[cron] Weekly content job failed:', err.message);
    }
  });

  console.log(`[cron] Jobs scheduled: iCal sync (every 5 min) · OTP cleanup (daily 03:00 UTC) · Stale PENDING cleanup (every 30 min) · Check-in reminders (daily 13:00 UTC) · Survey push (daily 15:00 UTC) · Alert push (every 30 min) · Media retention (monthly 04:00 UTC, ${RETENTION_MONTHS}mo policy) · Content agent (Monday 13:00 UTC)`);
}

module.exports = { startCronJobs };
