// lib/oauth-state-store.js
'use strict';

const crypto = require('crypto');

const COOKIE_NAME  = 'oauth_state';
const MAX_AGE_SECS = 10 * 60; // 10 minutes

// ── Helpers ───────────────────────────────────────────────────────────────────

function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Parse the raw Cookie header into a key→value map.
 * Avoids adding cookie-parser as a dependency.
 */
function parseCookies(header) {
  const map = {};
  if (!header) return map;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    map[key] = decodeURIComponent(val);
  }
  return map;
}

// ── CookieStateStore ──────────────────────────────────────────────────────────

/**
 * Custom Passport OAuth2 state store that keeps state in a short-lived
 * HMAC-signed cookie instead of the Express session.
 *
 * This allows the main session cookie to use sameSite: 'strict' while
 * the oauth_state cookie uses sameSite: 'lax' (required so Google can
 * send it back on the OAuth callback cross-site redirect).
 *
 * Interface matches passport-oauth2's AbstractStateStore:
 *   store(req, state, callback)
 *   verify(req, providedState, callback)
 */
class CookieStateStore {
  /**
   * Called by Passport when initiating the OAuth flow.
   * Signs `state` with HMAC and sets it as a short-lived cookie.
   */
  store(req, state, callback) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      return callback(new Error('SESSION_SECRET not set — cannot sign OAuth state'));
    }

    const sig    = hmac(state, secret);
    const value  = encodeURIComponent(`${state}.${sig}`);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';

    req.res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECS}; Path=/${secure}`
    );

    callback(null);
  }

  /**
   * Called by Passport on the OAuth callback.
   * Reads the signed cookie, verifies HMAC + equality, clears the cookie.
   */
  verify(req, providedState, callback) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      return callback(new Error('SESSION_SECRET not set'));
    }

    const cookies   = parseCookies(req.headers.cookie);
    const cookieVal = cookies[COOKIE_NAME];

    // Always clear the cookie, whether verification succeeds or fails
    req.res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`
    );

    if (!cookieVal) {
      return callback(null, false, { message: 'OAuth state cookie missing — possible CSRF or expired flow' });
    }

    const dotIdx = cookieVal.lastIndexOf('.');
    if (dotIdx < 0) {
      return callback(null, false, { message: 'OAuth state cookie malformed' });
    }

    const state = cookieVal.slice(0, dotIdx);
    const sig   = cookieVal.slice(dotIdx + 1);

    // Constant-time comparison to prevent timing attacks
    const expectedSig = hmac(state, secret);
    let sigMatch;
    try {
      sigMatch = crypto.timingSafeEqual(
        Buffer.from(sig,         'base64url'),
        Buffer.from(expectedSig, 'base64url'),
      );
    } catch {
      sigMatch = false;
    }

    if (!sigMatch) {
      return callback(null, false, { message: 'OAuth state signature invalid' });
    }

    if (state !== providedState) {
      return callback(null, false, { message: 'OAuth state mismatch' });
    }

    callback(null, state);
  }
}

module.exports = { CookieStateStore };
