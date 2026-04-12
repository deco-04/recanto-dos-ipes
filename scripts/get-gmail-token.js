/**
 * One-time helper — generates the GMAIL_REFRESH_TOKEN for Railway.
 *
 * Run once locally (never in production):
 *   node scripts/get-gmail-token.js
 *
 * Prerequisites:
 *   1. Enable Gmail API in Google Cloud Console:
 *      console.cloud.google.com → APIs & Services → Enable APIs
 *      → search "Gmail API" → Enable
 *
 *   2. Add http://localhost:3000/oauth2callback as an authorized redirect URI
 *      in your OAuth 2.0 Client ID (the same one used for Google login):
 *      console.cloud.google.com → APIs & Services → Credentials
 *      → click your OAuth 2.0 Client ID → add to Authorized redirect URIs
 *
 *   3. Set env vars (copy from Railway or .env):
 *      GOOGLE_CLIENT_ID=...
 *      GOOGLE_CLIENT_SECRET=...
 *      GMAIL_USER=recantodoipes@gmail.com
 *
 * What it does:
 *   - Prints a Google authorization URL
 *   - You visit it, log in as recantodoipes@gmail.com, grant Gmail access
 *   - Script starts a tiny local server on :3000 to catch the callback
 *   - Prints the refresh token → copy it to Railway as GMAIL_REFRESH_TOKEN
 */

'use strict';

require('dotenv').config();
const http     = require('http');
const { URL }  = require('url');
const https    = require('https');
const readline = require('readline');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/oauth2callback';
const SCOPE         = 'https://mail.google.com/';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
  console.error('Copy them from Railway (recanto-dos-ipes service variables) into a .env file or export them.');
  process.exit(1);
}

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent` +
  `&login_hint=${encodeURIComponent(process.env.GMAIL_USER || '')}`;

console.log('\n━━━ Gmail OAuth2 Token Generator ━━━\n');
console.log('Step 1: Open this URL in your browser and log in as recantodoipes@gmail.com:\n');
console.log(authUrl);
console.log('\nStep 2: Waiting for Google to redirect back...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');

  if (url.pathname !== '/oauth2callback') {
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.end('Error: no code in callback');
    server.close();
    return;
  }

  // Exchange code for tokens
  const postData = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  }).toString();

  const tokenReq = https.request({
    hostname: 'oauth2.googleapis.com',
    path:     '/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  }, (tokenRes) => {
    let body = '';
    tokenRes.on('data', chunk => body += chunk);
    tokenRes.on('end', () => {
      const tokens = JSON.parse(body);

      if (tokens.error) {
        console.error('\nError from Google:', tokens.error_description || tokens.error);
        res.end('Error — check terminal');
        server.close();
        return;
      }

      console.log('\n━━━ SUCCESS ━━━\n');
      console.log('Add this to Railway → recanto-dos-ipes → Variables:\n');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
      console.log('━━━━━━━━━━━━━━━\n');
      console.log('Note: this refresh token does not expire unless you revoke it.\n');

      res.end('<h2>Done! Check your terminal for the refresh token. You can close this tab.</h2>');
      server.close();
    });
  });

  tokenReq.on('error', err => {
    console.error('Request error:', err.message);
    res.end('Error — check terminal');
    server.close();
  });

  tokenReq.write(postData);
  tokenReq.end();
});

server.listen(3000, () => {
  // Ready to receive the callback
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Error: port 3000 is in use. Stop the Express dev server first, then re-run this script.');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
