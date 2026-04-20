'use strict';

/**
 * Tiny helper that registers the weekly content cron with a known,
 * TZ-aware contract: Monday 07:00 America/Denver.
 *
 * Extracted from cron.js so a unit test can pin the schedule contract
 * without booting the whole cron file (which touches Prisma, Redis, GHL,
 * WhatsApp, etc.). The real cron.js just calls this helper.
 */

function scheduleWeeklyContentCron(cron, handler) {
  return cron.schedule('0 7 * * 1', handler, { timezone: 'America/Denver' });
}

module.exports = { scheduleWeeklyContentCron };
