'use strict';

const cron = require('node-cron');
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

  console.log('[cron] iCal sync scheduled (hourly at :07)');
}

module.exports = { startCronJobs };
