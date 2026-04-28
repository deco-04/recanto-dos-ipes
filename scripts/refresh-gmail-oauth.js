'use strict';
/**
 * Gmail OAuth refresh helper.
 *
 * Why this exists:
 *   The mailer (lib/mailer.js) sends email via Gmail REST API (port 443) because
 *   Railway blocks SMTP. That requires an OAuth2 refresh_token. Tokens expire
 *   when the OAuth app is in "Testing" status (7 days) OR when unused for ~6
 *   months (Production). After expiry, every email send fails silently (logged
 *   as "Gmail OAuth stale — refresh at https://console.cloud.google.com").
 *
 * What this script does:
 *   1. Reads GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET from .env
 *   2. Spins up a local callback server on http://localhost:53682
 *   3. Prints an OAuth consent URL for you to visit in browser
 *   4. Captures the authorization code via the redirect
 *   5. Exchanges it for a fresh refresh_token
 *   6. Prints the new GMAIL_REFRESH_TOKEN value to paste into Railway
 *
 * Prerequisites:
 *   In Google Cloud Console → APIs & Services → Credentials → your OAuth 2.0
 *   Client ID, ensure http://localhost:53682/oauth2callback is in
 *   "Authorized redirect URIs". If not, add it temporarily, run this script,
 *   then remove it (security best practice).
 *
 *   Also recommended: APIs & Services → OAuth consent screen → Publishing
 *   status → "PUBLISH APP" (move from Testing → Production). Self-use of
 *   gmail.send scope doesn't require Google review and gives indefinite
 *   refresh-token lifetime instead of the 7-day testing limit.
 */

const http = require('http');
const url  = require('url');
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Tiny .env loader — avoids adding a dotenv dependency for this one-shot script.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const REDIRECT_URI = 'http://localhost:53682/oauth2callback';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.error('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  console.error('   Pull them from Railway with:  railway variables --service recanto-dos-ipes');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI,
);

const authUrl = oauth2.generateAuthUrl({
  access_type:  'offline',     // ← required to get a refresh_token
  prompt:       'consent',     // ← force re-consent so a NEW refresh_token is issued
  scope:        SCOPES,
});

console.log('────────────────────────────────────────────────────');
console.log('STEP 1 — Open this URL in your browser:');
console.log('');
console.log(authUrl);
console.log('');
console.log('Sign in as recantodoipes@gmail.com → Continue → Allow');
console.log('────────────────────────────────────────────────────');

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/oauth2callback') {
    res.writeHead(404); res.end('Not found'); return;
  }
  const code = parsed.query.code;
  if (!code) {
    res.writeHead(400); res.end('Missing ?code parameter'); return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h1>✅ Token captured</h1><p>Check your terminal — close this tab.</p></body></html>`);

    console.log('');
    console.log('────────────────────────────────────────────────────');
    console.log('STEP 2 — New refresh token (paste this into Railway):');
    console.log('');
    console.log('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('');
    console.log('Railway path: project RDI-&-Central-Equipes → service');
    console.log('              recanto-dos-ipes → Variables → GMAIL_REFRESH_TOKEN');
    console.log('────────────────────────────────────────────────────');

    if (!tokens.refresh_token) {
      console.warn('⚠️  No refresh_token received. This usually means you previously');
      console.warn('   approved this app without revoking. Visit:');
      console.warn('   https://myaccount.google.com/permissions');
      console.warn('   → revoke "Recantos da Serra" or similar → re-run this script.');
    }

    server.close();
    process.exit(0);
  } catch (e) {
    console.error('❌ Token exchange failed:', e.message);
    res.writeHead(500); res.end('Token exchange failed: ' + e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(53682, () => {
  console.log('Listening for callback on http://localhost:53682 …');
});
