#!/usr/bin/env node
/**
 * collect-images.js — temporary bridge server
 *
 * Runs on http://localhost:5555 and accepts base64 image data POSTed
 * by the authenticated Google Drive viewer tab via JavaScript injection.
 *
 * Usage:  node scripts/collect-images.js
 * Stop:   Ctrl+C after all images are received
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT       = 5555;
const IMAGES_DIR = path.join(__dirname, '..', 'images');

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── Unique Drive IDs → target filenames ──────────────────────────────────────
const MANIFEST = [
  { id: '1uwQ0O63Rcoyun9Ndvqc6KnomboeTxau-', names: ['logo.png']               },
  { id: '1tcXD7VsxgcSCwSOUorPjyRZYvWAma4Df', names: ['hero.jpg', 'sala.jpg']   },
  { id: '11Z-N_Do_370m5JdP_Dr06PyMHz60SIQc', names: ['sobre.jpg']               },
  { id: '1Oif23FgQubtxryood4TtUiYd3Okg31Yn', names: ['pool.jpg']                },
  { id: '1xMEaTh3giADu1pRSgIKDnK67tT2_DoJv', names: ['sauna.jpg', 'room-3.jpg']},
  { id: '1kiHS62jD5yCWrJlaxwyFMzgwJDVI6v8d', names: ['games.jpg']               },
  { id: '1k77ewvidjM9QwqfgP9q_kFYwFg18K8EN', names: ['kitchen.jpg']             },
  { id: '1xhKJ7soiy5jDzgJ2GAam3OdXo3klRgh8', names: ['sports.jpg']              },
  { id: '1D_PDswcOHFGauN7fE1yl3DRXvOXSH_dL', names: ['room-1.jpg', 'room-4.jpg']},
  { id: '1DmMGsK78xKXfHIA31sm0dL8hcbq28wfL', names: ['room-2.jpg']              },
];

const received = new Set();

function corsHeaders (res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
}

const server = http.createServer((req, res) => {
  corsHeaders(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /status — show what's pending
  if (req.method === 'GET' && req.url === '/status') {
    const pending = MANIFEST.filter(m => !received.has(m.id)).map(m => m.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: [...received], pending }));
    return;
  }

  // POST /save — receive base64 image
  if (req.method === 'POST' && req.url === '/save') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { id, data } = JSON.parse(body);
        const entry = MANIFEST.find(m => m.id === id);
        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `unknown id: ${id}` }));
          return;
        }
        const b64 = data.replace(/^data:image\/\w+;base64,/, '');
        const buf = Buffer.from(b64, 'base64');
        for (const name of entry.names) {
          fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
        }
        received.add(id);
        const savedKB = Math.round(buf.length / 1024);
        const msg = `saved ${entry.names.join(', ')}  (${savedKB} KB)  [${received.size}/${MANIFEST.length}]`;
        console.log(`  ✓ ${msg}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, saved: entry.names }));

        if (received.size === MANIFEST.length) {
          console.log('\nAll images saved ✓  — shutting down.\n');
          server.close();
        }
      } catch (e) {
        console.error('Error saving image:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => {
  console.log(`\nRecanto dos Ipês — Image Collector  (port ${PORT})\n`);
  console.log('Navigate Chrome to each file viewer URL and run the extraction snippet.\n');
  console.log('── Files to collect ─────────────────────────────────────────────');
  MANIFEST.forEach(m => console.log(`  ${m.names.join(' + ').padEnd(28)}  https://drive.google.com/file/d/${m.id}/view`));
  console.log('');
  console.log('── Extraction snippet (run in DevTools Console or via MCP JS) ───');
  console.log(`
(async () => {
  const img = document.querySelector('img[src*="drive-viewer"]') || document.querySelector('img[src*="drive.google.com/u"]');
  if (!img) return console.error('no viewer image found');
  await new Promise(r => img.complete ? r() : img.addEventListener('load', r));
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  const b64 = c.toDataURL('image/jpeg', 0.92);
  const id = location.pathname.split('/')[3];
  const r = await fetch('http://localhost:5555/save', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({id, data: b64})
  });
  const j = await r.json();
  console.log(j.ok ? '✓ sent: ' + j.saved : '✗ error: ' + j.error);
})();
`);
});
