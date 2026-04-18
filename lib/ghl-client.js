'use strict';

/**
 * Lightweight client for GoHighLevel REST API. Uses Node 18+ built-in fetch.
 * Reads GHL_API_KEY (agency-level Private Integration Token) and GHL_COMPANY_ID
 * from process.env. Caches responses in Redis for 5 minutes to stay well under
 * GHL's rate limits.
 */

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';
const CACHE_TTL_MS = 5 * 60 * 1000;

let _redis = null;
function getRedis() {
  if (_redis !== null) return _redis;
  if (!process.env.REDIS_URL) { _redis = false; return _redis; }
  try {
    const Redis = require('ioredis');
    _redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    _redis.connect().catch(() => { _redis = false; });
  } catch {
    _redis = false;
  }
  return _redis;
}

async function cacheGet(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    const v = await r.get(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

async function cacheSet(key, value) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(value), 'PX', CACHE_TTL_MS);
  } catch {
    /* swallow */
  }
}

/**
 * Fetch contacts from GHL.
 * @param {Object} opts
 * @param {number} [opts.limit=100]
 * @param {string} [opts.query='']
 * @returns {Promise<Array<{ id: string, name: string, phone: string|null, email: string|null, lastActivityAt: string|null }>>}
 */
async function fetchContacts({ limit = 100, query = '' } = {}) {
  if (!process.env.GHL_API_KEY) {
    console.warn('[ghl-client] GHL_API_KEY not configured — returning empty list');
    return [];
  }
  if (!process.env.GHL_COMPANY_ID) {
    console.warn('[ghl-client] GHL_COMPANY_ID not configured — returning empty list');
    return [];
  }

  const cacheKey = `ghl:contacts:${query}:${limit}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    locationId: process.env.GHL_COMPANY_ID,
    limit: String(limit),
  });
  if (query) params.set('query', query);

  const url = `${GHL_BASE}/contacts/?${params}`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: GHL_API_VERSION,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    console.error('[ghl-client] fetch error:', e.message);
    return [];
  }

  if (!res.ok) {
    console.error(`[ghl-client] GHL responded ${res.status} ${res.statusText}`);
    return [];
  }

  let body;
  try { body = await res.json(); } catch { body = null; }

  const contacts = Array.isArray(body?.contacts) ? body.contacts : [];

  const normalized = contacts.map(c => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.contactName || c.email || 'Sem nome',
    phone: c.phone || null,
    email: c.email || null,
    lastActivityAt: c.lastActivity || c.dateUpdated || c.dateAdded || null,
  }));

  await cacheSet(cacheKey, normalized);
  return normalized;
}

module.exports = { fetchContacts };
