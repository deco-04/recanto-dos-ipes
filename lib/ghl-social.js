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

  // Determine scheduled time
  const scheduledFor = post.scheduledFor || (() => {
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

module.exports = { schedulePost, cancelScheduledPost };
