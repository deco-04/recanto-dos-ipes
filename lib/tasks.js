'use strict';

/**
 * lib/tasks.js — Staff task helpers
 *
 * createOtaTask: called by ical-sync after a new OTA booking is created.
 * Creates a StaffTask assigned to the first active ADMIN, pushes a notification
 * to all ADMINs, and stores the task ID on the Booking record (otaTaskId).
 */

const prisma           = require('./db');
const { sendPushToRole } = require('./push');

/**
 * Format a Date as DD/MM for notification bodies.
 */
function fmtDate(date) {
  const d   = new Date(date);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${mon}`;
}

/**
 * Creates a StaffTask for an incomplete OTA booking and stores its ID on the
 * Booking record. Sends a push notification to all ADMINs.
 *
 * @param {string} bookingId
 * @param {'AIRBNB'|'BOOKING_COM'} source
 * @param {string} guestName
 * @param {Date} checkIn
 */
async function createOtaTask(bookingId, source, guestName, checkIn) {
  // Find the first active ADMIN to use as assignedTo and assignedBy
  const admin = await prisma.staffMember.findFirst({
    where:  { role: 'ADMIN', active: true },
    select: { id: true },
  });

  if (!admin) {
    console.warn('[tasks] createOtaTask: no active ADMIN found, skipping task creation');
    return null;
  }

  const sourceLabel = source === 'AIRBNB' ? 'Airbnb' : 'Booking.com';
  const dateStr     = fmtDate(checkIn);

  let task;
  try {
    task = await prisma.staffTask.create({
      data: {
        assignedToId: admin.id,
        assignedById: admin.id,
        bookingId,
        title:       `Completar dados — ${sourceLabel}`,
        description: `${guestName} · check-in ${dateStr} · Dados incompletos da reserva ${sourceLabel}. Abra a reserva e preencha telefone, número de hóspedes e demais informações.`,
        status:      'PENDENTE',
      },
    });
  } catch (err) {
    console.error('[tasks] createOtaTask error:', err.message);
    return null;
  }

  // Store the task ID on the booking for auto-completion later
  await prisma.booking.update({
    where: { id: bookingId },
    data:  { otaTaskId: task.id },
  }).catch(err => console.error('[tasks] otaTaskId update error:', err.message));

  // Push to all ADMINs
  sendPushToRole('ADMIN', {
    title: `Nova reserva ${sourceLabel} — dados incompletos`,
    body:  `${guestName} · ${dateStr} · Toque para completar`,
    type:  'OTA_BOOKING_INCOMPLETE',
    data:  { bookingId, taskId: task.id },
  }).catch(err => console.error('[tasks] push error:', err.message));

  return task;
}

/**
 * Marks the auto-created OTA task as complete if all required fields are present.
 * Called after PATCH /reservas/:id/dados saves data.
 *
 * @param {string} bookingId
 */
async function maybeCompleteOtaTask(bookingId) {
  const booking = await prisma.booking.findUnique({
    where:  { id: bookingId },
    select: { otaTaskId: true, guestPhone: true, guestCount: true },
  });

  if (!booking?.otaTaskId) return;

  // Required fields: guestPhone (non-empty) and guestCount > 1 or explicitly set
  const phoneOk = booking.guestPhone && booking.guestPhone.trim().length > 0;
  const countOk = booking.guestCount && booking.guestCount > 1;

  if (phoneOk && countOk) {
    await prisma.staffTask.update({
      where: { id: booking.otaTaskId },
      data:  { status: 'FEITO', completedAt: new Date() },
    }).catch(err => console.error('[tasks] task complete error:', err.message));
  }
}

module.exports = { createOtaTask, maybeCompleteOtaTask };
