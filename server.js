'use strict';

const express     = require('express');
const compression = require('compression');
const path        = require('path');
const session     = require('express-session');
const PgSession   = require('connect-pg-simple')(session);
const passport    = require('passport');

const app  = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ── Gzip / Brotli ─────────────────────────────────────────────────────────────
app.use(compression({ level: 6 }));

// ── Security headers ──────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS — only over HTTPS in production
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Content-Security-Policy — allows CDNs used by the site
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com https://js.stripe.com https://maps.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdn.tailwindcss.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "frame-src https://js.stripe.com https://www.google.com",
    "connect-src 'self' https://api.stripe.com",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

// ── Stripe webhook — must receive raw body BEFORE express.json() ──────────────
app.post('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig    = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secret && process.env.NODE_ENV === 'production') {
      console.error('[stripe] STRIPE_WEBHOOK_SECRET not set in production — rejecting webhook');
      return res.status(400).send('Webhook Error: missing secret');
    }
    if (!secret) {
      console.warn('[stripe] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (dev only)');
    }

    let event;
    try {
      const stripe = require('./lib/stripe');
      event = secret
        ? stripe.webhooks.constructEvent(req.body, sig, secret)
        : JSON.parse(req.body);
    } catch (err) {
      console.error('[stripe] webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      try {
        const prisma = require('./lib/db');
        const booking = await prisma.booking.findUnique({
          where: { stripePaymentIntentId: pi.id },
        });

        if (booking && booking.status === 'PENDING') {
          const updated = await prisma.booking.update({
            where: { id: booking.id },
            data:  { status: 'CONFIRMED' },
          });
          console.log(`[stripe] Booking ${booking.id} confirmed via webhook`);

          // Fire GHL + confirmation email (non-blocking)
          const { notifyBookingConfirmed } = require('./lib/ghl-webhook');
          const { sendBookingConfirmation } = require('./lib/mailer');
          notifyBookingConfirmed(updated).catch(e => console.error('[ghl]', e.message));
          sendBookingConfirmation({ booking: updated }).catch(e => console.error('[mailer]', e.message));
        }
      } catch (err) {
        console.error('[stripe] webhook DB error:', err);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      try {
        const prisma = require('./lib/db');
        await prisma.booking.updateMany({
          where: { stripePaymentIntentId: pi.id, status: 'PENDING' },
          data:  { status: 'CANCELLED' },
        });
        console.log(`[stripe] PaymentIntent ${pi.id} failed — booking cancelled`);
      } catch (err) {
        console.error('[stripe] webhook payment_failed DB error:', err);
      }
    }

    res.json({ received: true });
  }
);

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessionStore = process.env.DATABASE_URL
  ? new PgSession({
      conString: process.env.DATABASE_URL,
      tableName: 'Session',
      createTableIfMissing: false, // table managed by Prisma
    })
  : new session.MemoryStore();

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[session] FATAL: SESSION_SECRET is not set in production. Sessions are insecure.');
}

app.use(session({
  store:             sessionStore,
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
  },
  name: 'rdi.sid',
}));

// ── Passport ──────────────────────────────────────────────────────────────────
require('./routes/auth'); // Registers Google strategy via side effect
app.use(passport.initialize());
app.use(passport.session());

// ── Images — 1-year immutable cache ───────────────────────────────────────────
app.use('/images', express.static(path.join(ROOT, 'images'), {
  maxAge: '365d',
  immutable: true,
  etag: false,
}));

// ── Public assets (booking.html, dashboard.html, login.html, /js/*.js) ────────
app.use(express.static(path.join(ROOT, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/bookings',  require('./routes/bookings'));
app.use('/api/pricing',   require('./routes/pricing'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Admin — manual iCal sync trigger
app.post('/api/admin/sync-ical', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { syncAll } = require('./lib/ical-sync');
  const results = await syncAll();
  res.json({ results });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Stripe public key — safe to expose to frontend ────────────────────────────
app.get('/api/config/stripe', (_req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

// ── Main site (HTML — always revalidated) ─────────────────────────────────────
app.use(express.static(ROOT, {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// ── Named page routes (clean URLs without .html) ─────────────────────────────
app.get('/galeria', (_req, res) => res.sendFile(path.join(ROOT, 'galeria.html')));
app.get('/faq',     (_req, res) => res.sendFile(path.join(ROOT, 'faq.html')));

// ── Fallback → index.html (SPA-safe, but not for /api routes) ────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message || 'Erro interno do servidor' });
  }
  res.status(status).sendFile(path.join(ROOT, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Recanto dos Ipês · listening on port ${PORT}`);

  // Start iCal sync cron job (only in production or when URLs are set)
  if (process.env.AIRBNB_ICAL_URL || process.env.BOOKING_COM_ICAL_URL) {
    const { startCronJobs } = require('./lib/cron');
    startCronJobs();
  }
});
