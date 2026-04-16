// lib/push.js
'use strict';

const webpush = require('web-push');
const prisma  = require('./db');

// ── VAPID configuration ───────────────────────────────────────────────────────

let vapidConfigured = false;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || 'mailto:recantodoipes@gmail.com',
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
 * @param {'ADMIN'|'GOVERNANTA'|'PISCINEIRO'} role
 * @param {{ title: string, body: string, type: string, data?: object }} payload
 * @returns {Promise<number>} count of successful sends
 */
async function sendPushToRole(role, payload) {
  // Note: filtering on Json? fields for IS NOT NULL is unreliable in Prisma v6.
  // Fetch all active staff for the role; sendPushToStaff skips those without a subscription.
  const staff = await prisma.staffMember.findMany({
    where:  { role, active: true },
    select: { id: true },
  });

  const results = await Promise.allSettled(
    staff.map(s => sendPushToStaff(s.id, payload))
  );

  return results.filter(r => r.status === 'fulfilled' && r.value === true).length;
}

// ── sendPushToUser ────────────────────────────────────────────────────────────

/**
 * Send a Web Push notification to a single guest (User).
 * If the subscription is expired/invalid (410/404), clears it from the DB.
 *
 * @param {string} userId
 * @param {{ title: string, body: string, type: string, data?: object }} payload
 * @returns {Promise<boolean>} true if sent, false if no subscription or VAPID not configured
 */
async function sendPushToUser(userId, { title, body, type, data = {} }) {
  if (!vapidConfigured) return false;

  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { pushSubscription: true, name: true, email: true },
  });

  if (!user?.pushSubscription) return false;

  const subscription = user.pushSubscription;

  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, type, data }));
    console.log(`[push] Sent "${type}" to guest ${user.name || user.email || userId}`);
    return true;
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.warn(`[push] Guest subscription expired for ${userId}, clearing`);
      await prisma.user.update({
        where: { id: userId },
        data:  { pushSubscription: null },
      });
    } else {
      console.error(`[push] Failed to send to guest ${userId}:`, err.message);
    }
    return false;
  }
}

module.exports = { sendPushToStaff, sendPushToRole, sendPushToUser };
