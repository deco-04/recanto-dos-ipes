'use strict';

const express    = require('express');
const compression = require('compression');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ── Gzip / Brotli ────────────────────────────────────────────────────────────
app.use(compression({ level: 6 }));

// ── Security headers ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── Images — served with a 1-year immutable cache ────────────────────────────
app.use('/images', express.static(path.join(ROOT, 'images'), {
  maxAge: '365d',
  immutable: true,
  etag: false,
}));

// ── HTML — always revalidated (no stale landing page on redeploys) ────────────
app.use(express.static(ROOT, {
  index: 'index.html',
  setHeaders (res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      // CSS, JS, fonts — 1 hour
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Fallback → index.html (SPA-safe) ─────────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Recanto dos Ipês · listening on port ${PORT}`);
});
