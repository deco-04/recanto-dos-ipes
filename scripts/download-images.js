#!/usr/bin/env node
/**
 * download-images.js
 *
 * Downloads all site photos from Google Drive into the /images folder.
 * Files must have "Anyone with the link" → Viewer sharing enabled in Drive.
 *
 * Usage:  node scripts/download-images.js
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const IMAGES_DIR = path.join(__dirname, '..', 'images');

// ── Image manifest ────────────────────────────────────────────────────────────
// { id: Google Drive file ID, name: local filename }
const MANIFEST = [
  { id: '1uwQ0O63Rcoyun9Ndvqc6KnomboeTxau-', name: 'logo.png'     },
  { id: '1tcXD7VsxgcSCwSOUorPjyRZYvWAma4Df', name: 'hero.jpg'     },
  { id: '11Z-N_Do_370m5JdP_Dr06PyMHz60SIQc', name: 'sobre.jpg'    },
  { id: '1Oif23FgQubtxryood4TtUiYd3Okg31Yn', name: 'pool.jpg'     },
  { id: '1xMEaTh3giADu1pRSgIKDnK67tT2_DoJv', name: 'sauna.jpg'   },
  { id: '1kiHS62jD5yCWrJlaxwyFMzgwJDVI6v8d', name: 'games.jpg'    },
  { id: '1k77ewvidjM9QwqfgP9q_kFYwFg18K8EN', name: 'kitchen.jpg'  },
  { id: '1xhKJ7soiy5jDzgJ2GAam3OdXo3klRgh8', name: 'sports.jpg'   },
  { id: '1D_PDswcOHFGauN7fE1yl3DRXvOXSH_dL', name: 'room-1.jpg'  },
  { id: '1DmMGsK78xKXfHIA31sm0dL8hcbq28wfL', name: 'room-2.jpg'  },
  { id: '1xMEaTh3giADu1pRSgIKDnK67tT2_DoJv', name: 'room-3.jpg'  },
  { id: '1D_PDswcOHFGauN7fE1yl3DRXvOXSH_dL', name: 'room-4.jpg'  },
  { id: '1tcXD7VsxgcSCwSOUorPjyRZYvWAma4Df', name: 'sala.jpg'    },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Follow redirects and return the final response. */
function fetchFollowRedirects (url, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Node.js image downloader)' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();                              // drain to free socket
        const next = new URL(headers.location, url).href;
        resolve(fetchFollowRedirects(next, redirectsLeft - 1));
      } else {
        resolve(res);
      }
    }).on('error', reject);
  });
}

/** Save a response stream to disk, rejecting if content-type looks like HTML. */
function saveStream (res, dest) {
  return new Promise((resolve, reject) => {
    const ct = (res.headers['content-type'] || '').toLowerCase();
    if (ct.includes('text/html')) {
      res.resume();
      return reject(new Error(
        `Received HTML — file is private or requires sign-in. ` +
        `Share it as "Anyone with the link → Viewer" in Google Drive.`
      ));
    }
    const tmp = dest + '.tmp';
    const out = fs.createWriteStream(tmp);
    res.pipe(out);
    out.on('finish', () => { fs.renameSync(tmp, dest); resolve(); });
    out.on('error', (e) => { fs.unlink(tmp, () => {}); reject(e); });
  });
}

function driveUrl (id) {
  return `https://drive.google.com/uc?export=view&id=${id}`;
}

function formatBytes (n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function downloadOne ({ id, name }) {
  const dest = path.join(IMAGES_DIR, name);

  if (fs.existsSync(dest)) {
    const size = fs.statSync(dest).size;
    console.log(`  ✓ skip   ${name}  (${formatBytes(size)} already on disk)`);
    return { name, status: 'skipped' };
  }

  const url = driveUrl(id);
  try {
    const res  = await fetchFollowRedirects(url);
    const size = parseInt(res.headers['content-length'] || '0', 10);
    await saveStream(res, dest);
    const actual = fs.statSync(dest).size;
    console.log(`  ↓ saved  ${name}  (${formatBytes(actual)})`);
    return { name, status: 'ok' };
  } catch (err) {
    console.error(`  ✗ FAIL   ${name}  — ${err.message}`);
    return { name, status: 'failed', error: err.message };
  }
}

async function main () {
  console.log('\nRecanto dos Ipês — Image Downloader\n');

  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    console.log(`Created ${IMAGES_DIR}\n`);
  }

  // Download sequentially to avoid hammering Drive
  const results = [];
  for (const entry of MANIFEST) {
    results.push(await downloadOne(entry));
  }

  const ok      = results.filter(r => r.status === 'ok').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const failed  = results.filter(r => r.status === 'failed');

  console.log(`\n── Summary ──────────────────────────────────`);
  console.log(`  Downloaded : ${ok}`);
  console.log(`  Skipped    : ${skipped} (already present)`);
  console.log(`  Failed     : ${failed.length}`);

  if (failed.length) {
    console.log('\nFailed files (make them public in Drive):');
    failed.forEach(f => console.log(`  • ${f.name}  (Drive ID in manifest)`));
    console.log('\nHow to fix: right-click each file in Google Drive →');
    console.log('  Share → Anyone with the link → Viewer → Done\n');
    process.exit(1);
  } else {
    console.log('\nAll images ready in /images ✓\n');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
