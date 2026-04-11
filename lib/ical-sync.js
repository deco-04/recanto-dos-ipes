'use strict';

const https  = require('https');
const http   = require('http');
const ical   = require('node-ical');
const prisma = require('./db');

// Domains allowed as iCal redirect targets (prevents SSRF via redirect)
const ICAL_ALLOWED_DOMAINS = ['airbnb.com', 'booking.com', 'bookingbutton.com', 'icalendar.com'];

function isAllowedIcalHost(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return ICAL_ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Fetches an iCal URL and returns its text content.
 * Follows at most ONE redirect, and only to whitelisted domains.
 */
function fetchIcal(url, _redirected = false) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (_redirected) {
          return reject(new Error('iCal fetch: too many redirects'));
        }
        const redirectUrl = res.headers.location;
        if (!isAllowedIcalHost(redirectUrl)) {
          return reject(new Error(`iCal fetch: redirect to disallowed host blocked (${redirectUrl})`));
        }
        return fetchIcal(redirectUrl, true).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`iCal fetch failed: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('iCal fetch timed out')); });
    req.on('error', reject);
  });
}

/**
 * Extracts all booked dates (as YYYY-MM-DD strings) from parsed iCal events.
 */
function extractBlockedDates(parsed) {
  const dates = new Set();

  for (const event of Object.values(parsed)) {
    if (event.type !== 'VEVENT') continue;

    const summary = (event.summary || '').toString().toLowerCase();
    // Skip "airbnb not available" / availability hold placeholder events
    // but keep actual reservation events
    const isAirbnbHold = summary.includes('not available') || summary === 'blocked';

    let start = event.start;
    let end   = event.end || event.start;

    if (!start) continue;

    // node-ical may return JS Date objects
    if (!(start instanceof Date)) start = new Date(start);
    if (!(end instanceof Date))   end   = new Date(end);

    // Iterate each day from start to end (exclusive of checkout day)
    const cur = new Date(start);
    cur.setHours(12, 0, 0, 0);
    const last = new Date(end);
    last.setHours(12, 0, 0, 0);

    while (cur < last) {
      dates.add(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
  }

  return dates;
}

/**
 * Syncs an iCal feed into BlockedDate table.
 * Upserts dates found in the feed; deletes dates for this source no longer in the feed.
 *
 * @param {'AIRBNB'|'BOOKING_COM'} source
 * @param {string} url - iCal URL
 */
async function syncIcal(source, url) {
  if (!url) {
    console.log(`[ical-sync] No URL configured for ${source}, skipping.`);
    return { source, synced: 0, deleted: 0, error: null };
  }

  try {
    console.log(`[ical-sync] Fetching ${source} iCal…`);
    const text   = await fetchIcal(url);
    const parsed = ical.parseICS(text);
    const dates  = extractBlockedDates(parsed);

    console.log(`[ical-sync] ${source}: ${dates.size} blocked dates found`);

    // Upsert all found dates
    let synced = 0;
    const now = new Date();

    for (const dateStr of dates) {
      await prisma.blockedDate.upsert({
        where: {
          date_source: {
            date:   new Date(dateStr),
            source: source,
          },
        },
        update: { syncedAt: now },
        create: {
          date:   new Date(dateStr),
          source: source,
          syncedAt: now,
        },
      });
      synced++;
    }

    // Delete dates that are no longer in the feed (cancellations)
    const existing = await prisma.blockedDate.findMany({
      where: { source },
      select: { id: true, date: true },
    });

    const toDelete = existing.filter(row => {
      const d = row.date.toISOString().split('T')[0];
      return !dates.has(d);
    });

    if (toDelete.length > 0) {
      await prisma.blockedDate.deleteMany({
        where: { id: { in: toDelete.map(r => r.id) } },
      });
      console.log(`[ical-sync] ${source}: removed ${toDelete.length} cancelled dates`);
    }

    return { source, synced, deleted: toDelete.length, error: null };
  } catch (err) {
    console.error(`[ical-sync] ${source} sync failed:`, err.message);
    return { source, synced: 0, deleted: 0, error: err.message };
  }
}

/**
 * Syncs all configured iCal sources.
 */
async function syncAll() {
  const results = await Promise.allSettled([
    syncIcal('AIRBNB',      process.env.AIRBNB_ICAL_URL),
    syncIcal('BOOKING_COM', process.env.BOOKING_COM_ICAL_URL),
  ]);
  return results.map(r => r.value ?? r.reason);
}

module.exports = { syncIcal, syncAll };
