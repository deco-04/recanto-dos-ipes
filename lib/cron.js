'use strict';

const cron   = require('node-cron');
const prisma = require('./db');
const { syncAll }        = require('./ical-sync');
const { isLocked, setLock, clearLock } = require('./redis-rate-limit');
const { runRetention, RETENTION_MONTHS } = require('./retention');
const { runAlertRules }                  = require('./alert-rules');
const { sendPushToRole, sendPushToStaff, sendPushToUser } = require('./push');
const { sendGuestListReminder, sendWhatsAppMessage } = require('./ghl-webhook');
const { sendTemplate, sendText }                     = require('./whatsapp');
const { createWeeklyPackage }            = require('./conteudo-agent');

/**
 * Starts all scheduled background jobs.
 * Called once at server startup.
 */
function startCronJobs() {
  // iCal sync — every hour (only when iCal URLs are configured)
  // Lock prevents concurrent runs (e.g. if a sync takes longer than the interval).
  if (process.env.AIRBNB_ICAL_URL || process.env.BOOKING_COM_ICAL_URL) {
    // In-process guard (same instance) + Redis distributed lock (cross-instance,
    // e.g. two Railway containers overlapping during a rolling redeploy).
    let _icalSyncRunning = false;

    cron.schedule('0 * * * *', async () => {
      if (_icalSyncRunning) {
        console.log('[cron] iCal sync: previous run still in progress, skipping');
        return;
      }
      // Distributed lock: 10-min TTL prevents a dead instance from holding it forever
      if (await isLocked('ical-sync')) {
        console.log('[cron] iCal sync: another instance is running, skipping');
        return;
      }
      await setLock('ical-sync', 10 * 60 * 1000);
      _icalSyncRunning = true;
      console.log('[cron] Starting iCal sync…');
      try {
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
      } finally {
        _icalSyncRunning = false;
        await clearLock('ical-sync');
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

  // Auto-complete past bookings — daily at 02:00 UTC
  // Marks CONFIRMED bookings whose checkout date has passed as COMPLETED.
  // Keeps historical records accurate without requiring manual admin action.
  // Safe: only touches CONFIRMED status (won't touch CANCELLED/REFUNDED bookings).
  cron.schedule('0 2 * * *', async () => {
    try {
      const now = new Date();
      const { count } = await prisma.booking.updateMany({
        where: {
          status:   'CONFIRMED',
          checkOut: { lt: now },
        },
        data: { status: 'COMPLETED' },
      });
      if (count > 0) {
        console.log(`[cron] Auto-complete: marked ${count} past booking(s) as COMPLETED`);
      }
    } catch (err) {
      console.error('[cron] Auto-complete past bookings failed:', err.message);
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

  // ── Post-checkout NPS survey — daily at 12:00 BRT (15:00 UTC) ────────────────
  // 1. Sends WhatsApp NPS template to guests whose checkout was yesterday.
  // 2. Also sends a push notification to guests with the app installed.
  // 3. Creates or updates the Survey record and marks surveyStatus = ENVIADO.
  //    (Bug fix: previously surveyStatus was never updated after sending.)
  cron.schedule('0 15 * * *', async () => {
    try {
      const today     = new Date();
      const yesterday = new Date(today);
      yesterday.setUTCDate(today.getUTCDate() - 1);
      const yesterdayDate = yesterday.toISOString().slice(0, 10);

      const bookings = await prisma.booking.findMany({
        where: {
          status:       { in: ['CONFIRMED', 'COMPLETED'] },
          checkOut:     new Date(yesterdayDate),
          surveyStatus: 'NAO_ENVIADO',
        },
        select: {
          id:         true,
          userId:     true,
          guestName:  true,
          guestEmail: true,
          guestPhone: true,
        },
      });

      if (bookings.length === 0) return;

      // Resolve NPS template name from DB
      const npsTpl = await prisma.messageTemplate.findUnique({
        where: { triggerEvent: 'post_checkout_nps' },
      });
      const npsTemplateName = npsTpl?.active ? npsTpl.name : 'nps_pesquisa';

      let waSent = 0;
      let pushSent = 0;

      for (const booking of bookings) {
        // 1. Send WhatsApp NPS template (primary collection method)
        if (booking.guestPhone) {
          try {
            await sendTemplate(booking.guestPhone, npsTemplateName, [booking.guestName], booking.id);
            waSent++;
          } catch (e) {
            console.error(`[cron] NPS WA send failed for ${booking.guestName}:`, e.message);
          }
        }

        // 2. Create or update Survey record
        const now = new Date();
        await prisma.survey.upsert({
          where:  { bookingId: booking.id },
          create: { bookingId: booking.id, guestEmail: booking.guestEmail, waSentAt: now },
          update: { waSentAt: now },
        });

        // 3. Mark booking surveyStatus = ENVIADO (was missing before — this is the bug fix)
        await prisma.booking.update({
          where: { id: booking.id },
          data:  { surveyStatus: 'ENVIADO' },
        });

        // 4. Also send push notification to guests with the app installed
        if (booking.userId) {
          const result = await sendPushToUser(booking.userId, {
            title: 'Como foi sua estadia? ⭐',
            body:  'Esperamos que tenha curtido cada momento no Recanto dos Ipês. Sua avaliação é muito importante para nós!',
            type:  'SURVEY_REQUEST',
            data:  { bookingId: booking.id, url: '/dashboard' },
          });
          if (result) pushSent++;
        }
      }

      console.log(`[cron] Post-checkout NPS: ${waSent} WA sent, ${pushSent} push sent (${bookings.length} booking(s))`);
    } catch (err) {
      console.error('[cron] Post-checkout NPS survey failed:', err.message);
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

      // Find system staff for auto-created tasks (first ADMIN + first PISCINEIRO)
      const [adminStaff, piscineiro] = await Promise.all([
        prisma.staffMember.findFirst({ where: { role: 'ADMIN', active: true }, select: { id: true } }),
        prisma.staffMember.findFirst({ where: { role: 'PISCINEIRO', active: true }, select: { id: true } }),
      ]);

      for (const booking of bookings) {
        const nights = Math.round(
          (new Date(booking.checkOut).getTime() - new Date(booking.checkIn).getTime()) / 86400000
        );
        const checkInFmt = new Date(booking.checkIn).toLocaleDateString('pt-BR', {
          day: '2-digit', month: '2-digit', year: 'numeric',
        });

        // Send WA guest list reminder (non-blocking)
        sendGuestListReminder(booking).catch(e =>
          console.error('[cron] D-7 guest list reminder error:', e.message)
        );

        // Push to ADMIN
        sendPushToRole('ADMIN', {
          title: `Lembrete D-7 enviado — ${booking.guestName}`,
          body:  `Check-in em 7 dias. Aguardando lista de hóspedes.`,
          type:  'PRESTAY_REMINDER_SENT',
          data:  { bookingId: booking.id },
        }).catch(() => {});

        // Push to GOVERNANTA and PISCINEIRO so they can plan ahead
        const d7Body = `${booking.guestName} · ${nights} noite${nights !== 1 ? 's' : ''} · Check-in ${checkInFmt}`;
        sendPushToRole('GOVERNANTA', {
          title: `📅 Chegada em 7 dias — ${booking.guestName}`,
          body:  d7Body,
          type:  'PRESTAY_REMINDER_SENT',
          data:  { bookingId: booking.id },
        }).catch(() => {});
        sendPushToRole('PISCINEIRO', {
          title: `📅 Chegada em 7 dias — ${booking.guestName}`,
          body:  d7Body,
          type:  'PRESTAY_REMINDER_SENT',
          data:  { bookingId: booking.id },
        }).catch(() => {});

        // ── Pool cleaning task for stays ≥ 5 nights ──────────────────────────
        if (nights >= 5 && adminStaff) {
          // Avoid duplicates — check if a pool task already exists for this booking
          const existing = await prisma.staffTask.findFirst({
            where: { bookingId: booking.id, title: { contains: 'piscina' } },
            select: { id: true },
          });

          if (!existing) {
            const midStay = new Date(booking.checkIn);
            midStay.setDate(midStay.getDate() + Math.floor(nights / 2));

            const taskData = {
              title:        `Manutenção de piscina — ${booking.guestName}`,
              description:  `Estadia de ${nights} noites. Visita recomendada no meio da estadia (${midStay.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}).`,
              dueDate:      midStay,
              bookingId:    booking.id,
              status:       'PENDENTE',
              assignedById: adminStaff.id,
              assignedToId: piscineiro ? piscineiro.id : adminStaff.id,
            };

            await prisma.staffTask.create({ data: taskData });

            // Notify PISCINEIRO (or ADMIN if no piscineiro)
            if (piscineiro) {
              sendPushToStaff(piscineiro.id, {
                title: '🏊 Nova tarefa — manutenção de piscina',
                body:  `${booking.guestName} · ${nights} noites · Check-in ${checkInFmt}`,
                type:  'TASK_ASSIGNED',
                data:  { bookingId: booking.id },
              }).catch(() => {});
            }
            sendPushToRole('ADMIN', {
              title: `🏊 Tarefa criada — piscina (${booking.guestName})`,
              body:  `Estadia de ${nights} noites. Visita agendada para meio da estadia.`,
              type:  'TASK_ASSIGNED',
              data:  { bookingId: booking.id },
            }).catch(() => {});

            // WhatsApp to guest asking permission (direct Meta API)
            if (booking.guestPhone) {
              // Try template first; fall back to free text if template not configured
              prisma.messageTemplate.findUnique({ where: { triggerEvent: 'pool_maintenance_permission' } })
                .then(tpl => {
                  if (tpl?.active) {
                    return sendTemplate(
                      booking.guestPhone,
                      tpl.name,
                      [booking.guestName, checkInFmt, String(nights)],
                      booking.id
                    );
                  }
                  // Fallback: free-text (works within 24h window only)
                  const waMsg = [
                    `Olá, ${booking.guestName}! 🏡`,
                    ``,
                    `Sua estadia no *Sítio Recanto dos Ipês* está confirmada para ${checkInFmt} (${nights} noites). Estamos ansiosos para recebê-los!`,
                    ``,
                    `Para estadias mais longas, nosso piscineiro costuma fazer uma visita de rotina para manter a piscina em perfeito estado. 🏊`,
                    ``,
                    `Você prefere que ele venha, ou prefere privacidade total?`,
                    `✅ *Sim* · 🙏 *Não*`,
                  ].join('\n');
                  return sendText(booking.guestPhone, waMsg, booking.id);
                })
                .catch(e => console.error('[cron] Pool WA message error:', e.message));
            }

            console.log(`[cron] Pool task created for ${booking.guestName} (${nights} nights)`);
          }
        }
      }

      console.log(`[cron] D-7 reminders: sent to ${bookings.length} booking(s)`);
    } catch (err) {
      console.error('[cron] D-7 pre-stay reminder failed:', err.message);
    }
  });

  // ── Check-in TODAY admin reminder — daily at 08:00 UTC (05:00 BRT) ──────────
  // Pushes to ADMIN when there are guests checking in today — day-of heads-up.
  cron.schedule('0 8 * * *', async () => {
    try {
      const today = new Date();
      const todayDate = today.toISOString().slice(0, 10);

      const bookings = await prisma.booking.findMany({
        where: { status: 'CONFIRMED', checkIn: new Date(todayDate) },
        select: { id: true, guestName: true, guestCount: true, hasPet: true },
      });

      if (bookings.length === 0) return;

      const petCount = bookings.filter(b => b.hasPet).length;
      const petNote  = petCount > 0 ? ` · ${petCount} com pet` : '';
      const body     = bookings.length === 1
        ? `${bookings[0].guestName} · ${bookings[0].guestCount || '?'} hóspede(s)${petNote}`
        : `${bookings.map(b => b.guestName).join(', ')}${petNote}`;

      const sent = await sendPushToRole('ADMIN', {
        title: `🏡 Check-in hoje — ${bookings.length} reserva${bookings.length > 1 ? 's' : ''}`,
        body,
        type:  'CHECKIN_TODAY_ADMIN',
        data:  { bookingIds: bookings.map(b => b.id) },
      });

      if (sent > 0) {
        console.log(`[cron] Check-in today: notified ${sent} admin(s) about ${bookings.length} booking(s)`);
      }

      // Also notify CASA and PISCINA roles about today's check-ins
      const staffBody = bookings.length === 1
        ? `${bookings[0].guestName} · ${bookings[0].guestCount || '?'} hóspede(s)${bookings[0].hasPet ? ' · com pet 🐾' : ''}`
        : `${bookings.length} grupos chegando hoje`;

      await sendPushToRole('GOVERNANTA', {
        title: `🏠 Check-in hoje — casa precisa estar pronta`,
        body:  staffBody,
        type:  'CHECKIN_TODAY_ADMIN',
        data:  { bookingIds: bookings.map(b => b.id) },
      });
      await sendPushToRole('PISCINEIRO', {
        title: `🏊 Check-in hoje — hóspedes chegando`,
        body:  staffBody,
        type:  'CHECKIN_TODAY_ADMIN',
        data:  { bookingIds: bookings.map(b => b.id) },
      });

      // Also notify CASA about check-outs today (they need to clean)
      const checkouts = await prisma.booking.findMany({
        where: { status: 'CONFIRMED', checkOut: new Date(todayDate) },
        select: { id: true, guestName: true, guestCount: true },
      });
      if (checkouts.length > 0) {
        const coBody = checkouts.length === 1
          ? `${checkouts[0].guestName} saindo hoje — limpeza necessária`
          : `${checkouts.length} grupos saindo hoje — limpeza necessária`;
        await sendPushToRole('GOVERNANTA', {
          title: `🧹 Check-out hoje`,
          body:  coBody,
          type:  'CHECKIN_TODAY_ADMIN',
          data:  { bookingIds: checkouts.map(b => b.id) },
        });
      }
    } catch (err) {
      console.error('[cron] Check-in today push failed:', err.message);
    }
  });

  // ── D-7 guest push — alongside existing admin D-7 reminder ──────────────────
  // This runs at the same schedule (daily 12:00 UTC) as the admin D-7 reminder.
  // Sends a push to guests (if they have a subscription) checking in in 7 days.
  cron.schedule('5 12 * * *', async () => {
    try {
      const target = new Date();
      target.setUTCDate(target.getUTCDate() + 7);
      const targetDate = target.toISOString().split('T')[0];

      const bookings = await prisma.booking.findMany({
        where: { status: 'CONFIRMED', checkIn: new Date(targetDate), userId: { not: null } },
        select: { id: true, userId: true, guestName: true, checkIn: true },
      });

      if (bookings.length === 0) return;

      let sent = 0;
      for (const booking of bookings) {
        const checkInFmt = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
        const result = await sendPushToUser(booking.userId, {
          title: 'Sua estadia está chegando! 🌿',
          body:  `Faltam 7 dias para o seu check-in em ${checkInFmt}. Prepare-se!`,
          type:  'PRESTAY_D7_GUEST',
          data:  { bookingId: booking.id, url: '/dashboard' },
        });
        if (result) sent++;
      }

      if (sent > 0) {
        console.log(`[cron] D-7 guest push: sent to ${sent}/${bookings.length} guest(s)`);
      }
    } catch (err) {
      console.error('[cron] D-7 guest push failed:', err.message);
    }
  });

  // ── Task deadline tomorrow — daily at 09:00 UTC (06:00 BRT) ─────────────────
  // Pushes to the assigned staff member when their task is due tomorrow.
  cron.schedule('0 9 * * *', async () => {
    try {
      const today    = new Date();
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(today.getUTCDate() + 1);
      const tomorrowDate = tomorrow.toISOString().slice(0, 10);

      const tasks = await prisma.staffTask.findMany({
        where: {
          status:  'PENDENTE',
          dueDate: { gte: new Date(tomorrowDate), lt: new Date(tomorrowDate + 'T23:59:59Z') },
          assignedToId: { not: null },
        },
        select: { id: true, title: true, assignedToId: true },
      });

      let sent = 0;
      for (const task of tasks) {
        const result = await sendPushToStaff(task.assignedToId, {
          title: '⏰ Tarefa vence amanhã',
          body:  task.title,
          type:  'TASK_DUE_TOMORROW',
          data:  { taskId: task.id },
        });
        if (result) sent++;
      }

      if (sent > 0) {
        console.log(`[cron] Task deadline reminders: sent ${sent} notification(s)`);
      }
    } catch (err) {
      console.error('[cron] Task deadline push failed:', err.message);
    }
  });

  // ── Overdue tasks — daily at 10:00 UTC (07:00 BRT) ──────────────────────────
  // Pushes to assigned staff and ADMIN for tasks past their due date.
  cron.schedule('0 10 * * *', async () => {
    try {
      const now = new Date();

      const tasks = await prisma.staffTask.findMany({
        where: {
          status:  'PENDENTE',
          dueDate: { lt: now },
          assignedToId: { not: null },
        },
        select: { id: true, title: true, assignedToId: true, dueDate: true },
      });

      if (tasks.length === 0) return;

      // Group overdue tasks: notify each assignee and also ADMIN once for all
      const byAssignee = {};
      for (const task of tasks) {
        if (!byAssignee[task.assignedToId]) byAssignee[task.assignedToId] = [];
        byAssignee[task.assignedToId].push(task);
      }

      for (const [assigneeId, assigneeTasks] of Object.entries(byAssignee)) {
        await sendPushToStaff(assigneeId, {
          title: `🔴 ${assigneeTasks.length} tarefa${assigneeTasks.length > 1 ? 's' : ''} em atraso`,
          body:  assigneeTasks.map(t => t.title).join(' · '),
          type:  'TASK_OVERDUE',
          data:  { taskIds: assigneeTasks.map(t => t.id) },
        }).catch(() => {});
      }

      await sendPushToRole('ADMIN', {
        title: `🔴 ${tasks.length} tarefa${tasks.length > 1 ? 's' : ''} em atraso`,
        body:  tasks.map(t => t.title).slice(0, 3).join(' · ') + (tasks.length > 3 ? ' …' : ''),
        type:  'TASK_OVERDUE_ADMIN',
        data:  { count: tasks.length },
      }).catch(() => {});

      console.log(`[cron] Overdue tasks: ${tasks.length} task(s) past due`);
    } catch (err) {
      console.error('[cron] Overdue tasks push failed:', err.message);
    }
  });

  // ── Pre-check-in inspection overdue — daily at 11:00 UTC (08:00 BRT) ────────
  // Alerts ADMIN when a booking is checking in tomorrow but has no PRE_CHECKIN inspection.
  cron.schedule('0 11 * * *', async () => {
    try {
      const today    = new Date();
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(today.getUTCDate() + 1);
      const tomorrowDate = tomorrow.toISOString().slice(0, 10);

      const bookings = await prisma.booking.findMany({
        where: { status: 'CONFIRMED', checkIn: new Date(tomorrowDate) },
        select: {
          id: true, guestName: true,
          inspections: { where: { type: 'PRE_CHECKIN' }, select: { id: true } },
        },
      });

      const missing = bookings.filter(b => b.inspections.length === 0);
      if (missing.length === 0) return;

      const sent = await sendPushToRole('ADMIN', {
        title: `⚠️ Vistoria pré check-in pendente`,
        body:  `${missing.map(b => b.guestName).join(', ')} chegam amanhã sem vistoria registrada`,
        type:  'INSPECTION_OVERDUE',
        data:  { bookingIds: missing.map(b => b.id) },
      });

      if (sent > 0) {
        console.log(`[cron] Inspection overdue: ${missing.length} booking(s) without PRE_CHECKIN inspection`);
      }
    } catch (err) {
      console.error('[cron] Inspection overdue push failed:', err.message);
    }
  });

  // ── Survey score notifications — every 2 hours ───────────────────────────────
  // Finds surveys that have been responded to but not yet notified to admin.
  // Uses the adminAlerted flag to avoid double-notifying.
  cron.schedule('0 */2 * * *', async () => {
    try {
      const newResponses = await prisma.survey.findMany({
        where: { respondedAt: { not: null }, adminAlerted: false },
        include: { booking: { select: { guestName: true, id: true } } },
      });

      if (newResponses.length === 0) return;

      for (const survey of newResponses) {
        const starScore = survey.score ?? 0;
        const npsScore  = survey.npsScore;
        const npsClass  = survey.npsClassification;
        const guestName = survey.booking?.guestName || 'Hóspede';

        // Build title and body depending on which score type arrived
        let title, body, type;
        if (npsScore !== null && npsScore !== undefined) {
          const emoji = npsClass === 'promotor' ? '🌟' : npsClass === 'neutro' ? '😐' : '⚠️';
          title = `${emoji} NPS ${npsScore}/10 — ${npsClass} — ${guestName}`;
          body  = survey.comment
            ? `"${survey.comment.slice(0, 80)}"`
            : `Classificação: ${npsClass}`;
          type  = npsClass === 'detrator' ? 'SURVEY_LOW_SCORE' : 'SURVEY_HIGH_SCORE';
        } else {
          const isLow = starScore <= 3;
          const stars = '★'.repeat(starScore) + '☆'.repeat(5 - starScore);
          title = isLow
            ? `⚠️ Avaliação baixa — ${starScore}★ de ${guestName}`
            : `Nova avaliação — ${starScore}★ de ${guestName}`;
          body  = survey.comment ? `${stars} · "${survey.comment.slice(0, 80)}"` : stars;
          type  = isLow ? 'SURVEY_LOW_SCORE' : 'SURVEY_HIGH_SCORE';
        }

        await sendPushToRole('ADMIN', {
          title,
          body,
          type,
          data: { surveyId: survey.id, bookingId: survey.bookingId, npsScore, starScore },
        }).catch(() => {});

        // Mark as alerted so we don't push again
        await prisma.survey.update({
          where: { id: survey.id },
          data:  { adminAlerted: true },
        });
      }

      console.log(`[cron] Survey notifications: ${newResponses.length} new response(s) notified`);
    } catch (err) {
      console.error('[cron] Survey notification push failed:', err.message);
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

  // ── AI Content Agent — Monday 07:00 BRT (10:00 UTC) ─────────────────────────
  // Generates weekly content packages for brands that have a BrandContentConfig.
  cron.schedule('0 10 * * 1', async () => {
    console.log('[cron] Running weekly AI content generation...');
    try {
      // Only generate for brands that have a BrandContentConfig record
      const configs = await prisma.brandContentConfig.findMany({
        where:  { property: { active: true } },
        select: { brand: true, propertyId: true },
      });
      if (configs.length === 0) return;

      let totalCreated = 0;

      for (const { brand, propertyId } of configs) {
        try {
          const posts = await createWeeklyPackage(brand, propertyId);
          totalCreated += posts.length;
          console.log(`[cron] Content: ${posts.length} posts created for ${brand}`);

          sendPushToRole('ADMIN', {
            title: 'Pacote de conteúdo gerado ✨',
            body:  `Pacote de conteúdo gerado — ${brand} · ${posts.length} posts aguardando revisão`,
            type:  'CONTENT_PACKAGE_READY',
            data:  { brand, propertyId },
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

  console.log(`[cron] Jobs scheduled: iCal sync (hourly) · OTP cleanup (03:00) · Auto-complete past bookings (02:00) · Stale PENDING (30min) · Check-in today admin (08:00) · Task deadline (09:00) · Task overdue (10:00) · Inspection overdue (11:00) · D-7 admin+guest (12:00) · Check-in guest reminder (13:00) · Survey push guest (15:00) · Alert push (30min) · Survey score admin (2h) · Media retention (monthly 04:00, ${RETENTION_MONTHS}mo) · Content agent (Mon 10:00)`);
}

module.exports = { startCronJobs };
