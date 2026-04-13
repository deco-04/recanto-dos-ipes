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

// ── Startup env validation — crash fast in production ─────────────────────────
if (process.env.NODE_ENV === 'production') {
  const REQUIRED_ENV = [
    'DATABASE_URL',
    'SESSION_SECRET',
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'ADMIN_SECRET',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
  ];
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[startup] FATAL: Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ── Gzip / Brotli ─────────────────────────────────────────────────────────────
app.use(compression({ level: 6 }));

// ── Security headers ──────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
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

          // Push notification to ADMIN staff (non-blocking)
          const { sendPushToRole, sendPushToUser } = require('./lib/push');
          sendPushToRole('ADMIN', {
            title: 'Nova Reserva Confirmada 🏡',
            body:  `${updated.guestName} · ${new Date(updated.checkIn).toLocaleDateString('pt-BR')} → ${new Date(updated.checkOut).toLocaleDateString('pt-BR')}`,
            type:  'BOOKING_CONFIRMED',
            data:  { bookingId: updated.id },
          }).catch(e => console.error('[push] booking confirmed push failed:', e.message));

          // Push notification to guest (if they have a push subscription)
          if (updated.userId) {
            const checkinFmt  = new Date(updated.checkIn).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
            const checkoutFmt = new Date(updated.checkOut).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
            sendPushToUser(updated.userId, {
              title: 'Reserva confirmada! 🏡',
              body:  `Check-in ${checkinFmt} · Check-out ${checkoutFmt}. Prepare-se para uma estadia incrível!`,
              type:  'BOOKING_CONFIRMED_GUEST',
              data:  { bookingId: updated.id, url: '/dashboard' },
            }).catch(e => console.error('[push] guest booking confirmed push failed:', e.message));
          }
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

// ── Trust proxy — Railway terminates TLS at its reverse proxy ─────────────────
// Without this, express-session sees HTTP internally and refuses to set the
// Secure cookie, meaning the session cookie is never delivered to the browser.
app.set('trust proxy', 1);

// ── Sessions ──────────────────────────────────────────────────────────────────
// connect-pg-simple auto-creates a "session" table (sid/sess/expire columns).
// We do NOT use a Prisma Session model — column names are incompatible.
const sessionStore = process.env.DATABASE_URL
  ? new PgSession({
      conString:            process.env.DATABASE_URL,
      createTableIfMissing: true,   // auto-creates "session" table on first boot
    })
  : new session.MemoryStore();

// SESSION_SECRET is validated above (process.exit(1) if missing in production)

app.use(session({
  store:             sessionStore,
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave:            false,
  saveUninitialized: false,
  rolling:           true,   // reset maxAge on every response (keeps active users logged in)
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days, resets on each request
    sameSite: 'strict',
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

// ── Staff upload storage (replaces Cloudinary) ────────────────────────────────
const { UPLOAD_DIR } = require('./routes/uploads');
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '60d',
  etag: true,
  setHeaders(res) {
    const origin = process.env.STAFF_APP_ORIGIN;
    // In production, only expose uploads to the staff app origin (never '*')
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (process.env.NODE_ENV !== 'production') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  },
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

// ── CORS for staff PWA (app.recantosdaserra.com) ──────────────────────────────
const STAFF_ORIGIN = process.env.STAFF_APP_ORIGIN || 'https://app.recantosdaserra.com';
function staffCors(req, res, next) {
  const origin = req.headers.origin;
  // Allow Railway preview URLs and the production domain
  if (origin && (origin === STAFF_ORIGIN || origin.endsWith('.up.railway.app'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (process.env.NODE_ENV !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/bookings',   require('./routes/bookings'));
app.use('/api/pricing',    require('./routes/pricing'));
app.use('/api/push',       require('./routes/push'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/staff/auth',              staffCors, require('./routes/staff-auth'));
app.use('/api/staff/auth/webauthn',     staffCors, require('./routes/staff-webauthn'));
app.use('/api/staff',                   staffCors, require('./routes/staff-portal'));
app.use('/api/admin/staff', staffCors, require('./routes/admin-staff'));
app.use('/api/uploads',     staffCors, require('./routes/uploads').router);
app.use('/api/reviews',    require('./routes/reviews'));
app.use('/api/ical',       require('./routes/ical-export'));

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
app.get('/galeria',   (_req, res) => res.sendFile(path.join(ROOT, 'galeria.html')));
app.get('/faq',       (_req, res) => res.sendFile(path.join(ROOT, 'faq.html')));
app.get('/politica-cancelamento', (_req, res) => res.sendFile(path.join(ROOT, 'politica-cancelamento.html')));
app.get('/politica-privacidade',  (_req, res) => res.sendFile(path.join(ROOT, 'politica-privacidade.html')));
app.get('/termos-de-servico',     (_req, res) => res.sendFile(path.join(ROOT, 'termos-de-servico.html')));
// Public app pages (in /public/ — not at ROOT, so need explicit routes)
app.get('/booking',   (_req, res) => res.sendFile(path.join(ROOT, 'public', 'booking.html')));
app.get('/login',     (_req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'dashboard.html')));

// ── Fallback → index.html (SPA-safe, but not for /api routes) ────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(ROOT, 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────────
// Logs full error server-side; never exposes internal details to the client.
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  // Log with stack in dev, message-only in prod to avoid leaking file paths
  if (process.env.NODE_ENV === 'production') {
    console.error(`[server] Error ${status} on ${req.method} ${req.path}:`, err.message);
  } else {
    console.error('[server] Unhandled error:', err);
  }
  if (req.path.startsWith('/api/')) {
    // In production, return a generic message — never expose err.message or stack
    const clientMsg = process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor'
      : (err.message || 'Erro interno do servidor');
    return res.status(status).json({ error: clientMsg });
  }
  res.status(status).sendFile(path.join(ROOT, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Recanto dos Ipês · listening on port ${PORT}`);

  // Start background cron jobs (push reminders always run; iCal sync only when URLs are configured)
  const { startCronJobs } = require('./lib/cron');
  startCronJobs();
});
