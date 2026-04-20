'use strict';

// In-memory per-source backoff for iCal rate-limit responses (HTTP 429).
// When a feed returns 429, we skip the next N cron cycles to give the remote
// OTA time to lift the limit. Reset on any non-429 outcome (success or other
// error). Module-level state is fine because the cron has an in-process guard
// and a Redis distributed lock — only one worker touches this at a time.

const DEFAULT_SKIP_CYCLES = 4; // 4 hourly cron cycles = ~4h cooldown

const state = new Map(); // source → { skipRemaining: number }

function shouldSkip(source) {
  const entry = state.get(source);
  if (!entry || entry.skipRemaining <= 0) return false;
  entry.skipRemaining -= 1;
  return true;
}

function recordRateLimited(source, cycles = DEFAULT_SKIP_CYCLES) {
  state.set(source, { skipRemaining: cycles });
}

function recordSuccess(source) {
  state.delete(source);
}

// Exposed for tests — not part of the public contract.
function _reset() {
  state.clear();
}

module.exports = { shouldSkip, recordRateLimited, recordSuccess, _reset };
