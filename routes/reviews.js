'use strict';

const express = require('express');
const https   = require('https');
const router  = express.Router();

// ── In-memory cache (survives restarts only within the same process) ──────────
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Helper: promisify a simple https GET → parsed JSON
function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Invalid JSON from Google Places API')); }
      });
    }).on('error', reject);
  });
}

// GET /api/reviews/google
router.get('/google', async (req, res) => {
  const now = Date.now();

  // Serve from cache if still fresh
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL) {
    return res.json({ ...cache.data, cached: true });
  }

  const apiKey  = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID;

  if (!apiKey || !placeId) {
    // Env vars not configured — return safe placeholder
    return res.json({ rating: 4.9, totalRatings: 0, configured: false, cached: false });
  }

  try {
    const url  = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total&key=${apiKey}`;
    const json = await httpsGetJSON(url);

    if (json.status !== 'OK') {
      throw new Error(`Google Places API error: ${json.status}`);
    }

    const result = json.result || {};
    const data = {
      rating:       result.rating            ?? null,
      totalRatings: result.user_ratings_total ?? 0,
      configured:   true,
      cached:       false,
    };

    cache = { data, fetchedAt: now };
    return res.json(data);

  } catch (err) {
    console.error('[reviews/google]', err.message);

    // Fall back to last cached data if available
    if (cache.data) {
      return res.json({ ...cache.data, cached: true, error: 'stale_cache' });
    }

    // Last-resort placeholder
    return res.json({ rating: null, totalRatings: 0, configured: true, cached: false, error: 'fetch_failed' });
  }
});

module.exports = router;
