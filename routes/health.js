'use strict';

/**
 * /api/health — operational health check.
 *
 * Returns aggregated status of each integration the SRI backend depends on.
 * Used by:
 *   - Railway's auto-restart logic (treats non-2xx as unhealthy)
 *   - The admin app's "Sistemas" widget (visible to ADMIN only)
 *   - External uptime monitors (BetterStack, UptimeRobot, etc.)
 *
 * Response shape (status: ok | degraded | error):
 *   {
 *     status:    'ok',
 *     timestamp: '2026-04-30T...',
 *     uptimeSeconds: 12345,
 *     services: {
 *       database:  { status: 'ok',              latencyMs: 12 },
 *       ghl:       { status: 'ok',              details: 'PIT + locationId configured' },
 *       whatsapp:  { status: 'not-configured',  details: 'WHATSAPP_PHONE_NUMBER_ID missing' },
 *       gmail:     { status: 'ok' },
 *       anthropic: { status: 'ok' },
 *       ical:      { status: 'ok',              details: 'last sync 23m ago' },
 *       push:      { status: 'ok' },
 *     }
 *   }
 *
 * Auth model: PUBLIC. Standard practice for health endpoints. Output is
 * deliberately scrubbed of secrets, keys, locationIds, etc. — only
 * "configured / not-configured / ok / degraded / error" status flags.
 */

const express = require('express');
const prisma  = require('../lib/db');

const router = express.Router();

// Lazy-resolve service start time so tests can call /health repeatedly
// without uptime drifting unpredictably.
const SERVICE_START_AT = Date.now();

/**
 * Each check returns { status, ...details }. They never throw — any error
 * is captured and reported as status: 'error' so the aggregator stays alive
 * even if a single integration is down.
 */
async function checkDatabase() {
  const t0 = Date.now();
  try {
    // Lightweight ping — Postgres returns instantly.
    await prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', latencyMs: Date.now() - t0 };
  } catch (err) {
    return { status: 'error', error: err.message?.slice(0, 200) || 'unknown' };
  }
}

function checkGhl() {
  // We don't ping GHL on every health hit — that would burn rate limits
  // and slow the endpoint. Just verify required env vars are present;
  // the cron jobs surface real auth failures separately.
  const hasKey = Boolean(process.env.GHL_API_KEY);
  const hasLoc = Boolean(process.env.GHL_COMPANY_ID || process.env.GHL_LOCATION_ID);
  if (!hasKey)  return { status: 'not-configured', details: 'GHL_API_KEY missing' };
  if (!hasLoc)  return { status: 'not-configured', details: 'GHL_COMPANY_ID / GHL_LOCATION_ID missing' };
  return { status: 'ok', details: 'PIT + locationId configured' };
}

function checkWhatsApp() {
  // Direct Meta Cloud API path. RDI has migrated to GHL so this is
  // expected to be 'not-configured' in production today; the GHL path
  // covers WhatsApp delivery.
  const hasId    = Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID);
  const hasToken = Boolean(process.env.WHATSAPP_ACCESS_TOKEN);
  if (!hasId && !hasToken) {
    return { status: 'not-configured', details: 'using GHL hosted WA instead' };
  }
  if (!hasId || !hasToken) {
    return { status: 'degraded', details: 'partial config — set both PHONE_NUMBER_ID and ACCESS_TOKEN' };
  }
  return { status: 'ok' };
}

function checkGmail() {
  const hasClient  = Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
  const hasRefresh = Boolean(process.env.GMAIL_REFRESH_TOKEN);
  if (!hasClient)  return { status: 'not-configured', details: 'OAuth client not configured' };
  if (!hasRefresh) return { status: 'degraded', details: 'GMAIL_REFRESH_TOKEN missing — re-run scripts/refresh-gmail-oauth.js' };
  return { status: 'ok' };
}

function checkAnthropic() {
  return process.env.ANTHROPIC_API_KEY
    ? { status: 'ok' }
    : { status: 'not-configured', details: 'content + briefing crons will skip' };
}

function checkPush() {
  const hasKeys = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  return hasKeys
    ? { status: 'ok' }
    : { status: 'not-configured', details: 'web push notifications disabled' };
}

/**
 * iCal sync freshness — derives "last sync" from the most recent
 * Booking row imported from Airbnb/Booking.com. The hourly cron writes
 * `dateAdded` on import, so a stale value means the cron has been failing
 * silently. Threshold: 6h is degraded, 24h is error.
 */
async function checkIcalFreshness() {
  try {
    const latest = await prisma.booking.findFirst({
      where:   { source: { in: ['AIRBNB', 'BOOKING_COM'] } },
      orderBy: { createdAt: 'desc' },
      select:  { createdAt: true, source: true },
    });
    if (!latest) {
      return { status: 'unknown', details: 'no iCal-sourced bookings ever imported' };
    }
    const ageMs    = Date.now() - latest.createdAt.getTime();
    const ageMin   = Math.round(ageMs / 60000);
    const details  = `last imported booking ${ageMin}m ago (${latest.source})`;
    if (ageMs > 24 * 60 * 60 * 1000) return { status: 'error',    details };
    if (ageMs > 6  * 60 * 60 * 1000) return { status: 'degraded', details };
    return { status: 'ok', details };
  } catch (err) {
    return { status: 'error', error: err.message?.slice(0, 200) || 'unknown' };
  }
}

/**
 * Aggregates per-service statuses into one top-level status:
 *   - any 'error'                                                → 'error'
 *   - any 'degraded'                                              → 'degraded'
 *   - 'not-configured' counts as 'ok' (intentional missing config)
 *   - otherwise                                                   → 'ok'
 */
function rollupStatus(services) {
  const statuses = Object.values(services).map(s => s?.status);
  if (statuses.includes('error'))    return 'error';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

router.get('/', async (_req, res) => {
  // Run independent checks in parallel — DB + iCal hit Postgres, the rest
  // are pure env-var inspection so total latency ≈ DB ping (~10ms).
  const [database, ical] = await Promise.all([
    checkDatabase(),
    checkIcalFreshness(),
  ]);

  const services = {
    database,
    ghl:       checkGhl(),
    whatsapp:  checkWhatsApp(),
    gmail:     checkGmail(),
    anthropic: checkAnthropic(),
    push:      checkPush(),
    ical,
  };
  const status = rollupStatus(services);

  // HTTP status: 200 when ok or degraded (the system is still serving),
  // 503 only when something fundamental is broken (DB, all WA paths, etc.)
  // so Railway/uptime-monitor restart loops aren't triggered by partial
  // outages on non-critical paths (e.g. Gmail OAuth).
  const httpCode = status === 'error' ? 503 : 200;

  res.status(httpCode).json({
    status,
    timestamp:     new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - SERVICE_START_AT) / 1000),
    services,
  });
});

module.exports = router;
