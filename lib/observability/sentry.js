'use strict';

/**
 * Sentry integration — error tracking + transaction sampling.
 *
 * Gated entirely on SENTRY_DSN env var:
 *   - DSN missing → init() is a no-op, every captureXxx call is a no-op,
 *     wrapCronJob() returns the original function unchanged. Code that
 *     uses these helpers stays identical whether Sentry is on or off.
 *   - DSN present → events flow to Sentry with structured tags
 *     (cronJob, route, staffId, role, requestId).
 *
 * PII review:
 *   - We deliberately do NOT capture request bodies, headers, or query
 *     strings — those routinely carry guest names, phone numbers, addresses.
 *   - Stack frames + module paths are kept (needed for triage) but variable
 *     values are stripped (Sentry's `sendDefaultPii: false`).
 *   - Tags carry only opaque IDs (staffId, propertyId) and enums (role,
 *     channel, status code). No free-text content.
 *
 * Why a wrapper module instead of inlining @sentry/node calls everywhere:
 *   - We can swap providers (Sentry → BetterStack → OpenTelemetry) without
 *     touching every cron job.
 *   - Tests don't need a Sentry mock — they just call the wrapper and the
 *     no-op path runs.
 *   - One central place to enforce the PII filtering, sampling, and tag
 *     conventions.
 */

const Sentry = require('@sentry/node');

let initialized = false;

/**
 * Initialize Sentry. Call once at server boot, BEFORE Express routes.
 * Safe to call multiple times — re-init is a no-op.
 *
 * Returns true if Sentry is now active, false if the DSN was missing
 * (callers can branch on this for status logging).
 */
function initSentry() {
  if (initialized) return true;
  if (!process.env.SENTRY_DSN) {
    // No DSN — every helper below short-circuits. Log once at boot so it's
    // obvious from Railway logs that errors aren't being captured.
    console.log('[sentry] SENTRY_DSN not set — error tracking disabled');
    return false;
  }

  Sentry.init({
    dsn:                process.env.SENTRY_DSN,
    environment:        process.env.RAILWAY_ENVIRONMENT
                          || process.env.NODE_ENV
                          || 'production',
    release:            process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // Performance traces — sample 10% to keep cost predictable on Railway.
    // Bump to 1.0 temporarily when debugging slow endpoints.
    tracesSampleRate:   parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    sendDefaultPii:     false,                  // CRITICAL — no guest data in events
    attachStacktrace:   true,
    beforeSend(event) {
      // Defense-in-depth: strip request body + cookies + headers even if
      // a future Sentry version tries to attach them by default.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        // Keep method + URL pathname (no query string) for triage context.
        if (event.request.url) {
          try {
            const u = new URL(event.request.url, 'http://localhost');
            event.request.url = u.pathname;
          } catch { /* best-effort */ }
        }
      }
      return event;
    },
  });

  initialized = true;
  console.log('[sentry] initialized');
  return true;
}

/**
 * Capture an exception with structured tags. Safe to call when Sentry is
 * not initialized — short-circuits to no-op.
 *
 * Use this from route handlers: `captureException(err, { route: req.path,
 * staffId: req.staff?.id })`. Avoid passing user-typed content as tag
 * values — tags should be opaque IDs or enum values.
 *
 * @param {Error} err
 * @param {Record<string, string | number | undefined>} [tags]
 */
function captureException(err, tags = {}) {
  if (!initialized) return;
  Sentry.captureException(err, { tags: scrubTags(tags) });
}

/**
 * Wrap a cron job function so any thrown exception is captured with a
 * `cronJob: <name>` tag. Re-throws the original error so existing
 * upstream error handling (try/catch in cron.schedule callbacks) is
 * preserved.
 *
 * Returns the original function untouched when Sentry isn't initialized
 * — there's no point paying the wrapper overhead for a no-op.
 *
 * @template {(...args: any[]) => Promise<any>} F
 * @param {string} name  used as the cronJob tag value
 * @param {F} fn
 * @returns {F}
 */
function wrapCronJob(name, fn) {
  if (!initialized) return fn;
  return /** @type {F} */ (async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      Sentry.captureException(err, { tags: { cronJob: name } });
      throw err;
    }
  });
}

/**
 * Express error-handling middleware. Mount AFTER all routes so it sees
 * unhandled exceptions. Always calls next(err) so the existing JSON 500
 * handler still runs — Sentry just observes.
 */
function expressErrorHandler() {
  return (err, req, res, next) => {
    if (initialized) {
      Sentry.captureException(err, {
        tags: scrubTags({
          route:   req.route?.path || req.path,
          method:  req.method,
          status:  err.statusCode || 500,
          staffId: req.staff?.id,
          role:    req.staff?.role,
        }),
      });
    }
    next(err);
  };
}

/**
 * Drop nullish values + coerce everything to string so Sentry's strict
 * tag-value validation doesn't reject the event.
 */
function scrubTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = String(v).slice(0, 200);  // Sentry tag value cap
  }
  return out;
}

module.exports = {
  initSentry,
  captureException,
  wrapCronJob,
  expressErrorHandler,
  // Exposed for tests + advanced callers that need direct SDK access:
  _Sentry: Sentry,
  _isInitialized: () => initialized,
};
