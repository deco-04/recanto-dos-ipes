// lib/push.js
'use strict';

const webpush = require('web-push');
const prisma  = require('./db');

// ── VAPID configuration ───────────────────────────────────────────────────────

let vapidConfigured = false;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:admin@recantodosipes.com.br',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  vapidConfigured = true;
} else {
  console.warn('[push] VAPID keys not set — push notifications disabled');
}

// ── sendPushToStaff ───────────────────────────────────────────────────────────

/**
 * Send a Web Push notification to a single staff member.
 * Logs the notification to PushNotification table.
 * If the subscription is expired/invalid (410/404), clears it from the DB.
 *
 * @param {string} staffId
 * @param {{ title: string, body: string, type: string, data?: object }} payload
 * @returns {Promise<boolean>} true if sent, false if no subscription or VAPID not configured
 */
async function sendPushToStaff(staffId, { title, body, type, data = {} }) {
  if (!vapidConfigured) return false;

  const staff = await prisma.staffMember.findUnique({
    where:  { id: staffId },
    select: { pushSubscription: true, name: true },
  });

  if (!staff?.pushSubscription) return false;

  const subscription = staff.pushSubscription;

  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, type, data }));

    await prisma.pushNotification.create({
      data: { staffId, title, body, type, data },
    });

    console.log(`[push] Sent "${type}" to ${staff.name || staffId}`);
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.warn(`[push] Subscription expired for ${staffId}, clearing`);
      await prisma.staffMember.update({
        where: { id: staffId },
        data:  { pushSubscription: null },
      });
    } else {
      console.error(`[push] Failed to send to ${staffId}:`, err.message);
    }
    return false;
  }
}

// ── sendPushToRole ────────────────────────────────────────────────────────────

/**
 * Send a push notification to all active staff members with a given role.
 *
 * @param {'ADMIN'|'GUARDIA'|'PISCINEIRO'} role
 * @param {{ title: string, body: string, type: string, data?: object }} payload
 * @returns {Promise<number>} count of successful sends
 */
async function sendPushToRole(role, payload) {
  const staff = await prisma.staffMember.findMany({
    where:  { role, active: true, NOT: { pushSubscription: null } },
    select: { id: true },
  });

  const results = await Promise.allSettled(
    staff.map(s => sendPushToStaff(s.id, payload))
  );

  return results.filter(r => r.status === 'fulfilled' && r.value === true).length;
}

module.exports = { sendPushToStaff, sendPushToRole };
