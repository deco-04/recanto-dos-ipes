'use strict';

/**
 * Redis-backed rate limiting with graceful in-memory fallback.
 *
 * Falls back to per-process Maps when Redis is unavailable (local dev,
 * transient outage). All public functions are async but complete in < 2 ms
 * under normal conditions.
 *
 * Key namespaces (all prefixed with 'rl:'):
 *   rl:<key>          — sliding-window counter (INCR/PEXPIRE)
 *   rl:lock:<key>     — boolean lock (exists = locked)
 */

// ── Redis client (lazy-initialized) ──────────────────────────────────────────
let Redis;
try {
  Redis = require('ioredis');
} catch {
  // ioredis not installed → in-memory only
  Redis = null;
}

/** @type {import('ioredis').Redis | null} */
let _redis       = null;
let _redisBroken = false;

function getRedis() {
  if (_redisBroken || !Redis || !process.env.REDIS_URL) return null;
  if (_redis) return _redis;

  _redis = new Redis(process.env.REDIS_URL, {
    lazyConnect:         false,
    maxRetriesPerRequest: 1,
    connectTimeout:      2_000,
    commandTimeout:      1_000,
    enableOfflineQueue:  false,
  });

  _redis.on('error', (err) => {
    console.error('[redis-rl] connection error – falling back to in-memory:', err.message);
    _redisBroken = true;
    try { _redis.disconnect(); } catch {}
    _redis = null;
    // Attempt reconnect after 60 s
    setTimeout(() => { _redisBroken = false; }, 60_000);
  });

  return _redis;
}

// ── In-memory fallback Maps ───────────────────────────────────────────────────
const _counters = new Map(); // key → { count, resetAt }
const _locks    = new Map(); // key → lockedUntil (epoch ms)

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _counters) if (v.resetAt < now) _counters.delete(k);
  for (const [k, v] of _locks)    if (v < now)          _locks.delete(k);
}, 15 * 60 * 1000).unref();

// ── Lua script: atomic INCR + conditional PEXPIRE ─────────────────────────────
const LUA_INCR = `
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return {c, redis.call('PTTL', KEYS[1])}
`;

// ── checkLimit ────────────────────────────────────────────────────────────────
/**
 * Atomic sliding-window rate check.
 *
 * @param {string} key       Unique key (e.g. 'otp:user@example.com')
 * @param {number} max       Maximum allowed hits within the window
 * @param {number} windowMs  Window duration in milliseconds
 * @returns {Promise<{ok: boolean, minutesLeft?: number}>}
 */
async function checkLimit(key, max, windowMs) {
  const redis = getRedis();

  if (redis) {
    try {
      const [count, pttl] = await redis.eval(LUA_INCR, 1, 'rl:' + key, String(windowMs));
      if (count > max) {
        return { ok: false, minutesLeft: Math.max(1, Math.ceil(pttl / 60_000)) };
      }
      return { ok: true };
    } catch (err) {
      console.error('[redis-rl] checkLimit error – allowing request:', err.message);
    }
  }

  // In-memory fallback
  const now   = Date.now();
  const entry = _counters.get(key);
  if (!entry || entry.resetAt < now) {
    _counters.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (entry.count >= max) {
    return { ok: false, minutesLeft: Math.max(1, Math.ceil((entry.resetAt - now) / 60_000)) };
  }
  entry.count++;
  return { ok: true };
}

// ── isLocked ──────────────────────────────────────────────────────────────────
/**
 * Returns true if the lock key is currently active.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function isLocked(key) {
  const redis = getRedis();
  if (redis) {
    try {
      return (await redis.exists('rl:lock:' + key)) === 1;
    } catch {}
  }
  const until = _locks.get(key);
  return until != null && until > Date.now();
}

// ── setLock ───────────────────────────────────────────────────────────────────
/**
 * Activate a lock for ttlMs milliseconds.
 * @param {string} key
 * @param {number} ttlMs
 */
async function setLock(key, ttlMs) {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.set('rl:lock:' + key, '1', 'PX', ttlMs);
      return;
    } catch {}
  }
  _locks.set(key, Date.now() + ttlMs);
}

// ── tryAcquireLock ────────────────────────────────────────────────────────────
/**
 * Atomically acquire a lock. Returns true if the lock was acquired, false if
 * it was already held. Uses Redis SET NX (set-if-not-exists) to prevent the
 * TOCTOU race that exists when isLocked() + setLock() are called separately.
 * @param {string} key
 * @param {number} ttlMs
 * @returns {Promise<boolean>} true = acquired, false = already locked
 */
async function tryAcquireLock(key, ttlMs) {
  const redis = getRedis();
  if (redis) {
    try {
      const result = await redis.set('rl:lock:' + key, '1', 'NX', 'PX', ttlMs);
      return result === 'OK'; // 'OK' → acquired; null → already locked
    } catch (err) {
      console.error('[redis-rl] tryAcquireLock error – falling back to in-memory:', err.message);
    }
  }
  // In-memory fallback: check-and-set is synchronous so it's inherently atomic
  const now = Date.now();
  const until = _locks.get(key);
  if (until != null && until > now) return false; // already locked
  _locks.set(key, now + ttlMs);
  return true;
}

// ── clearLock ─────────────────────────────────────────────────────────────────
/**
 * Remove a lock key (e.g. after successful verification).
 * @param {string} key
 */
async function clearLock(key) {
  const redis = getRedis();
  if (redis) {
    try {
      await redis.del('rl:lock:' + key);
      return;
    } catch {}
  }
  _locks.delete(key);
}

// ── recordFailure ─────────────────────────────────────────────────────────────
/**
 * Increment a failure counter. When maxFailures is reached, activates a lock
 * and resets the counter.
 *
 * @param {string} failKey    Counter key  (e.g. 'verify:user@example.com:fails')
 * @param {string} lockKey    Lock key     (e.g. 'verify:user@example.com')
 * @param {number} maxFailures
 * @param {number} lockTtlMs  How long to lock after threshold is reached
 * @returns {Promise<{nowLocked: boolean}>}
 */
async function recordFailure(failKey, lockKey, maxFailures, lockTtlMs) {
  const windowMs = lockTtlMs * 4; // counters expire well after any lock clears
  const redis    = getRedis();

  if (redis) {
    try {
      const [count] = await redis.eval(LUA_INCR, 1, 'rl:' + failKey, String(windowMs));
      if (count >= maxFailures) {
        await redis.set('rl:lock:' + lockKey, '1', 'PX', lockTtlMs);
        await redis.del('rl:' + failKey);
        return { nowLocked: true };
      }
      return { nowLocked: false };
    } catch (err) {
      console.error('[redis-rl] recordFailure error:', err.message);
    }
  }

  // In-memory fallback
  const now   = Date.now();
  const entry = _counters.get(failKey) || { count: 0, resetAt: now + windowMs };
  entry.count += 1;
  _counters.set(failKey, entry);
  if (entry.count >= maxFailures) {
    _locks.set(lockKey, now + lockTtlMs);
    _counters.delete(failKey);
    return { nowLocked: true };
  }
  return { nowLocked: false };
}

module.exports = { checkLimit, isLocked, setLock, tryAcquireLock, clearLock, recordFailure };
