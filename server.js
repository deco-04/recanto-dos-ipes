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
    'STAFF_JWT_SECRET',
    'STAFF_INTERNAL_SECRET',
    'GHL_WEBHOOK_SECRET',
    'STRIPE_WEBHOOK_SECRET',
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
        const prisma  = require('./lib/db');
        const booking = await prisma.booking.findFirst({
          where: { stripePaymentIntentId: pi.id, status: 'PENDING' },
          select: { id: true, guestName: true, checkIn: true },
        });
        if (booking) {
          await prisma.booking.update({
            where: { id: booking.id },
            data:  { status: 'CANCELLED' },
          });
          const { sendPushToRole } = require('./lib/push');
          const checkInDate = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
          sendPushToRole('ADMIN', {
            title: '💳 Pagamento recusado — reserva cancelada',
            body:  `${booking.guestName} · Check-in ${checkInDate} · Tente entrar em contato`,
            type:  'PAYMENT_FAILED',
            data:  { bookingId: booking.id },
          }).catch(e => console.error('[push] payment failed push failed:', e.message));
        }
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
// connect-pg-simple stores sessions in a "session" table. createTableIfMissing
// only fires on first SET (write), not GET, so we ensure the table exists
// explicitly on startup to avoid "relation does not exist" errors on every request.
const sessionStore = process.env.DATABASE_URL
  ? new PgSession({
      conString:            process.env.DATABASE_URL,
      createTableIfMissing: true,
    })
  : new session.MemoryStore();

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  _pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    varchar     NOT NULL COLLATE "default",
      "sess"   json        NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
      ) THEN
        ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `).then(() => _pool.end()).catch(err => console.error('[session-init]', err.message));
}

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
  // Allow the production domain and preview URLs scoped to this project only
  const isProduction = origin === STAFF_ORIGIN;
  const isOwnRailwayPreview = origin && origin.endsWith('.up.railway.app') &&
    (origin.startsWith('https://recantos-central-') || origin.startsWith('https://recantos-central.'));
  if (isProduction || isOwnRailwayPreview) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (process.env.NODE_ENV !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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
app.use('/api/admin/obra',  staffCors, require('./routes/obra'));
app.use('/api/uploads',     staffCors, require('./routes/uploads').router);
app.use('/api/reviews',    require('./routes/reviews'));
app.use('/api/ical',       require('./routes/ical-export'));

// Unified inbox — staff conversations (staffCors enforces allowed origins)
const mensagensRouter = require('./routes/mensagens');
app.use('/api/staff/conversas', staffCors, mensagensRouter);
// GHL inbound webhook (legacy — kept for Instagram DM inbound; WA now via Meta directly)
app.use('/api/webhooks', staffCors, mensagensRouter);

// WhatsApp Business Cloud API webhook (Meta → our server)
app.use('/api/webhooks/whatsapp', require('./routes/whatsapp-webhook'));

// WhatsApp admin routes (templates + NPS data)
app.use('/api/staff', staffCors, require('./routes/whatsapp-admin'));

// AI Content Agent (staff)
app.use('/api/staff/conteudo', staffCors, require('./routes/content'));

// Public blog API (no auth)
app.use('/api/blog', require('./routes/content'));

// Admin — manual iCal sync trigger
app.post('/api/admin/sync-ical', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { syncAll } = require('./lib/ical-sync');
  const results = await syncAll();
  res.json({ results });
});

// Admin — push notification for bookings with missing guest info
app.post('/api/admin/notify-incomplete-guests', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const prisma = require('./lib/db');
    const { sendPushToRole } = require('./lib/push');
    // guestName is non-nullable (String in schema) — no null check needed
    const PLACEHOLDER_NAMES = ['', 'Hóspede Airbnb', 'Hóspede Booking.com'];

    const incomplete = await prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED', 'REQUESTED', 'PENDING'] },
        guestName: { in: PLACEHOLDER_NAMES },
      },
      select: { id: true, guestName: true, checkIn: true, source: true },
      orderBy: { checkIn: 'asc' },
    });

    if (incomplete.length === 0) {
      return res.json({ ok: true, sent: 0, message: 'Todas as reservas já têm dados completos' });
    }

    const title = `${incomplete.length} reserva${incomplete.length > 1 ? 's' : ''} sem dados completos`;
    const body = incomplete.length === 1
      ? `Check-in ${new Date(incomplete[0].checkIn).toLocaleDateString('pt-BR')} — adicione os dados do hóspede`
      : `${incomplete.length} reservas precisam de nome e dados do hóspede`;

    const sent = await sendPushToRole('ADMIN', {
      title,
      body,
      type: 'INCOMPLETE_GUEST_DATA',
      data: { count: incomplete.length, bookingIds: incomplete.map(b => b.id) },
    });

    res.json({ ok: true, found: incomplete.length, sent, bookings: incomplete });
  } catch (err) {
    console.error('[admin] notify-incomplete-guests error:', err);
    res.status(500).json({ error: 'Erro ao enviar notificação' });
  }
});

// Admin — check push subscription state across all staff
app.get('/api/admin/push-debug', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const prisma = require('./lib/db');
  const staff = await prisma.staffMember.findMany({
    where:  { active: true },
    select: { id: true, name: true, email: true, role: true, pushSubscription: true },
  });
  res.json(staff.map(s => ({
    id:              s.id,
    name:            s.name,
    email:           s.email,
    role:            s.role,
    hasSubscription: !!s.pushSubscription,
  })));
});

// Admin — fire every push notification type to all ADMIN staff (test mode)
app.post('/api/admin/test-push-all', async (req, res) => {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { sendPushToRole } = require('./lib/push');

  // All notification types with realistic payloads
  const notifications = [
    // ── Booking events ────────────────────────────────────────────────────────
    {
      title: 'Nova Reserva Confirmada 🏡',
      body:  'Maria Silva · 20/05 → 23/05',
      type:  'BOOKING_CONFIRMED',
      data:  { bookingId: 'test-001' },
    },
    {
      title: 'Nova solicitação de reserva',
      body:  'João Pereira · 01/06 → 04/06',
      type:  'BOOKING_REQUESTED',
      data:  { bookingId: 'test-002' },
    },
    {
      title: 'Nova reserva Airbnb — dados incompletos',
      body:  'Hóspede Airbnb · 15/06 · Toque para completar',
      type:  'OTA_BOOKING_INCOMPLETE',
      data:  { bookingId: 'test-003' },
    },
    {
      title: 'Reserva cancelada — Airbnb',
      body:  'Hóspede Airbnb · 20/06 → 22/06 · Datas agora disponíveis',
      type:  'OTA_BOOKING_CANCELLED',
      data:  { bookingId: 'test-004' },
    },
    {
      title: '💳 Pagamento recusado — reserva cancelada',
      body:  'Carlos Mendes · Check-in 10 jul · Tente entrar em contato',
      type:  'PAYMENT_FAILED',
      data:  { bookingId: 'test-005' },
    },
    {
      title: '2 reservas sem dados completos',
      body:  '2 reservas precisam de nome e dados do hóspede',
      type:  'INCOMPLETE_GUEST_DATA',
      data:  { count: 2 },
    },
    // ── Check-in / stay events ────────────────────────────────────────────────
    {
      title: '🏡 Check-in hoje — 1 reserva',
      body:  'Família Souza · 6 hóspedes · com pet',
      type:  'CHECKIN_TODAY_ADMIN',
      data:  { bookingIds: ['test-006'] },
    },
    {
      title: 'Lembrete D-7 enviado — Ana Costa',
      body:  'Check-in em 7 dias. Aguardando lista de hóspedes.',
      type:  'PRESTAY_REMINDER_SENT',
      data:  { bookingId: 'test-007' },
    },
    // ── Inspections ──────────────────────────────────────────────────────────
    {
      title: 'Vistoria Pré Check-in concluída ✓',
      body:  'Família Souza · Check-in 25 mai · Tudo OK',
      type:  'INSPECTION_SUBMITTED',
      data:  { reportId: 'test-r01' },
    },
    {
      title: '⚠️ 2 problemas na vistoria de Checkout',
      body:  'Carlos Mendes · Check-in 15 mai · Torneira, Chuveiro',
      type:  'INSPECTION_ISSUES',
      data:  { reportId: 'test-r02' },
    },
    {
      title: '⚠️ Vistoria pré check-in pendente',
      body:  'Família Souza, Ana Costa chegam amanhã sem vistoria registrada',
      type:  'INSPECTION_OVERDUE',
      data:  { bookingIds: ['test-006', 'test-007'] },
    },
    // ── Pool / maintenance ────────────────────────────────────────────────────
    {
      title: 'Manutenção da piscina registrada 🏊',
      body:  'Pré Check-in · por Pedro (Piscineiro)',
      type:  'POOL_MAINTENANCE_LOGGED',
      data:  { logId: 'test-l01' },
    },
    // ── Service tickets (Chamados) ────────────────────────────────────────────
    {
      title: 'Novo chamado aberto',
      body:  'Vazamento no banheiro da suíte · Prioridade ALTA',
      type:  'SERVICE_TICKET_OPENED',
      data:  { ticketId: 'test-t01' },
    },
    {
      title: '🚨 Chamado URGENTE aberto',
      body:  'Falta de energia elétrica · Prioridade URGENTE',
      type:  'SERVICE_TICKET_URGENTE',
      data:  { ticketId: 'test-t02' },
    },
    {
      title: 'Chamado resolvido ✅',
      body:  'Vazamento no banheiro da suíte · resolvido por Lucas (Guardião)',
      type:  'SERVICE_TICKET_RESOLVED',
      data:  { ticketId: 'test-t01' },
    },
    // ── Tasks ────────────────────────────────────────────────────────────────
    {
      title: 'Nova tarefa atribuída a você 📋',
      body:  'Verificar estoque de lenha · Prazo: 25/05/2026',
      type:  'TASK_ASSIGNED',
      data:  { taskId: 'test-tk01' },
    },
    {
      title: '⏰ Tarefa vence amanhã',
      body:  'Verificar estoque de lenha',
      type:  'TASK_DUE_TOMORROW',
      data:  { taskId: 'test-tk01' },
    },
    {
      title: '🔴 2 tarefas em atraso',
      body:  'Verificar estoque de lenha · Limpeza do deck',
      type:  'TASK_OVERDUE',
      data:  { count: 2 },
    },
    {
      title: 'Tarefa concluída ✅',
      body:  'Verificar estoque de lenha — concluída por Lucas (Guardião)',
      type:  'TASK_COMPLETED',
      data:  { taskId: 'test-tk01' },
    },
    // ── Staff events ──────────────────────────────────────────────────────────
    {
      title: 'Novo membro da equipe adicionado 👤',
      body:  'Lucas Ferreira (Guardião) foi adicionado(a) à equipe',
      type:  'STAFF_MEMBER_ADDED',
      data:  { staffId: 'test-s01' },
    },
    {
      title: 'Solicitação de recuperação de senha',
      body:  'Lucas Ferreira precisa redefinir o acesso',
      type:  'STAFF_RECOVERY_REQUEST',
      data:  { staffId: 'test-s01' },
    },
    // ── Messages ──────────────────────────────────────────────────────────────
    {
      title: 'Nova mensagem — Maria Silva',
      body:  'Olá, qual o horário de check-in?',
      type:  'INBOX_MESSAGE',
      data:  { conversationId: 'test-c01' },
    },
    // ── Surveys ──────────────────────────────────────────────────────────────
    {
      title: 'Nova avaliação — 5★ de Maria Silva',
      body:  '★★★★★ · "Lugar incrível, voltaremos com certeza!"',
      type:  'SURVEY_HIGH_SCORE',
      data:  { score: 5 },
    },
    {
      title: '⚠️ Avaliação baixa — 2★ de Carlos Mendes',
      body:  '★★☆☆☆ · "Houve problemas com o banheiro"',
      type:  'SURVEY_LOW_SCORE',
      data:  { score: 2 },
    },
    // ── Operational alerts ────────────────────────────────────────────────────
    {
      title: '⚠️ 1 alerta urgente — Sítio Recanto dos Ipês',
      body:  'Sem check-in confirmado para amanhã',
      type:  'IA_ALERTA_URGENTE',
      data:  { url: '/admin/ia-operacoes' },
    },
    {
      title: 'Pacote de conteúdo gerado ✨',
      body:  'Pacote de conteúdo gerado — RECANTO_DOS_IPES · 5 posts aguardando revisão',
      type:  'CONTENT_PACKAGE_READY',
      data:  { brand: 'RECANTO_DOS_IPES' },
    },
  ];

  const results = [];
  for (const notification of notifications) {
    const sent = await sendPushToRole('ADMIN', notification)
      .catch(err => { console.error(`[test-push] ${notification.type} failed:`, err.message); return 0; });
    results.push({ type: notification.type, sent });
    // Small delay to avoid overwhelming the push service
    await new Promise(r => setTimeout(r, 200));
  }

  const totalSent = results.reduce((sum, r) => sum + r.sent, 0);
  console.log(`[admin] test-push-all: sent ${totalSent} push(es) across ${notifications.length} types`);
  res.json({ ok: true, total: notifications.length, results });
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
app.get('/booking',            (_req, res) => res.sendFile(path.join(ROOT, 'public', 'booking.html')));
app.get('/login',              (_req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));
app.get('/dashboard',          (_req, res) => res.sendFile(path.join(ROOT, 'public', 'dashboard.html')));
app.get('/reserva-solicitada', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'reserva-solicitada.html')));

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

  // Seed default WhatsApp message templates (upsert — safe to re-run on every start)
  const { seedTemplates } = require('./lib/whatsapp');
  seedTemplates().catch(err => console.error('[startup] seedTemplates failed:', err.message));
});
