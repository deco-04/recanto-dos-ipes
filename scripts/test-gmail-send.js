'use strict';
/**
 * Sanity test for Gmail OAuth — sends a tiny test email to GMAIL_USER
 * (loops back to ourselves so it doesn't spam anyone). Verifies the
 * refresh_token is valid and the Gmail API client works end-to-end.
 *
 * Usage:
 *   node scripts/test-gmail-send.js
 *
 * Reads from local .env (which mirrors Railway production vars).
 */
const fs   = require('fs');
const path = require('path');

// Tiny .env loader (same pattern as refresh-gmail-oauth.js).
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

(async () => {
  // Override with the freshly-captured refresh token (newer than .env value)
  if (process.argv[2]) process.env.GMAIL_REFRESH_TOKEN = process.argv[2];

  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  const gmail = google.gmail({ version: 'v1', auth });

  const subject = `Gmail OAuth refresh test — ${new Date().toISOString()}`;
  const lines = [
    `From: "Recantos Mailer Test" <${process.env.GMAIL_USER}>`,
    `To: ${process.env.GMAIL_USER}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Se você está vendo este email, o GMAIL_REFRESH_TOKEN novo está funcionando.',
    'Pode arquivar/deletar.',
  ];
  const raw = Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  try {
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    console.log(`✅ Email sent. messageId=${res.data.id}`);
    console.log(`   Check inbox at ${process.env.GMAIL_USER}`);
  } catch (e) {
    console.error('❌ Gmail send failed:', e.message);
    if (e.response?.data) console.error('   ', JSON.stringify(e.response.data));
    process.exit(1);
  }
})();
