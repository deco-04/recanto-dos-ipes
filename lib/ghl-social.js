'use strict';

/**
 * GHL Social Planner API
 *
 * Handles scheduling and cancelling posts via the GoHighLevel Social Planner API.
 * Requires: GHL_API_KEY and GHL_LOCATION_ID env vars.
 */

const https = require('https');

const GHL_BASE = 'services.leadconnectorhq.com';

function ghlRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const apiKey     = process.env.GHL_API_KEY;
    const locationId = process.env.GHL_LOCATION_ID;

    if (!apiKey || !locationId) {
      return reject(new Error('[ghl-social] GHL_API_KEY or GHL_LOCATION_ID not set'));
    }

    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: GHL_BASE,
      port:     443,
      path,
      method,
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version:        '2021-07-28',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`[ghl-social] ${res.statusCode}: ${data}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('[ghl-social] Request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Maps short weekday tokens (mon/tue/...) to Date.getUTCDay() integers (0=Sun…6=Sat).
 * Lower-cased before lookup so "Mon" / "MON" / "mon" all work.
 */
const WEEKDAY_INDEX = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/**
 * Picks the next free posting slot from a `BrandContentConfig.postingSchedule`
 * JSON shape, given the current contentType. Returns `null` when there's no
 * slot list defined for that channel — caller falls back to tomorrow-10:00.
 *
 * Schedule shape:
 *   {
 *     "INSTAGRAM_FEED": ["mon 10:00", "wed 14:00", "fri 09:00"],
 *     "BLOG":           ["tue 08:00"],
 *     "default":        "tomorrow 10:00"
 *   }
 *
 * Scans the next 7 days starting at `now` and returns the earliest matching
 * weekday+time. All times interpreted in the server's local TZ (Railway = UTC).
 *
 * @param {object|null|undefined} postingSchedule - BrandContentConfig.postingSchedule JSON
 * @param {string} contentType - e.g. "INSTAGRAM_FEED"
 * @param {Date}   [now=new Date()] - reference point; defaults to current time
 * @returns {Date|null}
 */
function pickNextScheduledSlot(postingSchedule, contentType, now = new Date()) {
  if (!postingSchedule || typeof postingSchedule !== 'object') return null;
  const slots = postingSchedule[contentType];
  if (!Array.isArray(slots) || slots.length === 0) return null;

  // Parse each entry into { weekday: 0-6, hour: 0-23, minute: 0-59 }.
  // Skip malformed entries silently — bad config shouldn't break scheduling.
  const parsed = [];
  for (const raw of slots) {
    if (typeof raw !== 'string') continue;
    const match = raw.trim().toLowerCase().match(/^([a-z]+)\s+(\d{1,2}):(\d{2})$/);
    if (!match) continue;
    const weekday = WEEKDAY_INDEX[match[1]];
    const hour    = parseInt(match[2], 10);
    const minute  = parseInt(match[3], 10);
    if (weekday === undefined || hour > 23 || minute > 59) continue;
    parsed.push({ weekday, hour, minute });
  }
  if (parsed.length === 0) return null;

  // Walk forward from `now`, day by day, hour by hour to find the soonest slot.
  // Bounded by 7 days because every weekday repeats within that window.
  let best = null;
  for (const { weekday, hour, minute } of parsed) {
    const candidate = new Date(now);
    // Calculate days to add to land on the desired weekday
    const dayDiff = (weekday - candidate.getUTCDay() + 7) % 7;
    candidate.setUTCDate(candidate.getUTCDate() + dayDiff);
    candidate.setUTCHours(hour, minute, 0, 0);
    // If today's slot has already passed, push to next week
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 7);
    if (!best || candidate < best) best = candidate;
  }
  return best;
}

/**
 * Schedules a ContentPost to GHL Social Planner.
 * @param {object} post   - ContentPost record (must have brand, contentType, body, scheduledFor)
 * @param {object} config - BrandContentConfig (for postingSchedule, defaultHashtags)
 * @returns {string}      - GHL post ID (ghlPostId)
 */
async function schedulePost(post, config) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) throw new Error('GHL_LOCATION_ID not set');

  // Determine platform from contentType
  const platformMap = {
    INSTAGRAM_FEED:    'instagram',
    INSTAGRAM_REELS:   'instagram',
    INSTAGRAM_STORIES: 'instagram',
    FACEBOOK:          'facebook',
    BLOG:              null, // Blog stays in app — no GHL scheduling
    GBP_POST:          'google', // Google Business Profile via GHL Social Planner
  };

  const platform = platformMap[post.contentType];
  if (!platform) {
    // Blog posts are not scheduled to GHL — return null
    return null;
  }

  // Determine scheduled time. Priority:
  //   1) explicit post.scheduledFor (admin set in UI)
  //   2) next slot from BrandContentConfig.postingSchedule for this contentType
  //   3) tomorrow at 10:00 (legacy fallback)
  const scheduledFor = post.scheduledFor
    || pickNextScheduledSlot(config?.postingSchedule, post.contentType)
    || (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      return d;
    })();

  const body = {
    locationId,
    postDetails: {
      content:    post.body || '',
      platform,
      mediaUrls:  Array.isArray(post.mediaUrls) ? post.mediaUrls : [],
    },
    scheduleTime: new Date(scheduledFor).toISOString(),
  };

  const result = await ghlRequest('POST', '/social-media-posting/posts', body);
  return result.id || result.postId || null;
}

/**
 * Cancels a scheduled GHL Social Planner post.
 * @param {string} ghlPostId - The GHL post ID returned from schedulePost
 */
async function cancelScheduledPost(ghlPostId) {
  if (!ghlPostId) return;
  await ghlRequest('DELETE', `/social-media-posting/posts/${ghlPostId}`, null)
    .catch(e => console.error('[ghl-social] cancelScheduledPost error:', e.message));
}

/**
 * Reads the current status of a GHL Social Planner post.
 * Used by:
 *   1. Gap #9 — pre-cancel reconciliation, so we don't roll back
 *      a post that GHL already published.
 *   2. Future fallback poller for Gap #4 if the webhook subscription
 *      ever stalls — caller can periodically `getPostStatus` on
 *      AGENDADO rows whose `scheduledFor` has passed.
 *
 * Returns an object shaped like:
 *   { status: 'SCHEDULED'|'PUBLISHED'|'FAILED'|'DRAFT'|'CANCELLED'|'UNKNOWN',
 *     publishedAt: Date|null,
 *     raw: <full GHL response> }
 *
 * Throws on network/auth errors so callers can decide whether to fail
 * open (Gap #9 chooses to: GHL outage shouldn't block admin rollback).
 *
 * @param {string} ghlPostId
 */
async function getPostStatus(ghlPostId) {
  if (!ghlPostId) return { status: 'UNKNOWN', publishedAt: null, raw: null };

  const result = await ghlRequest('GET', `/social-media-posting/posts/${ghlPostId}`, null);

  // GHL responses vary in shape across endpoints — accept both `result.post`
  // (wrapped) and a flat root object so this stays tolerant if GHL ships
  // a minor envelope change.
  const post = result?.post || result || {};
  const rawStatus = String(post.status || post.state || '').toUpperCase();

  // Map GHL's vocabulary to our internal canonical set. Anything that means
  // "the post is live" maps to PUBLISHED so the caller has a single check.
  let status = 'UNKNOWN';
  if (['PUBLISHED', 'POSTED', 'COMPLETE', 'COMPLETED', 'SUCCESS'].includes(rawStatus)) status = 'PUBLISHED';
  else if (['SCHEDULED', 'PENDING', 'QUEUED'].includes(rawStatus))                      status = 'SCHEDULED';
  else if (['FAILED', 'ERROR'].includes(rawStatus))                                     status = 'FAILED';
  else if (rawStatus === 'DRAFT')                                                       status = 'DRAFT';
  else if (['CANCELLED', 'CANCELED', 'DELETED'].includes(rawStatus))                    status = 'CANCELLED';

  const publishedAtRaw = post.publishedAt || post.postedAt || post.completedAt || null;
  const publishedAt    = publishedAtRaw ? new Date(publishedAtRaw) : null;

  return { status, publishedAt, raw: post };
}

module.exports = { schedulePost, cancelScheduledPost, pickNextScheduledSlot, getPostStatus };
