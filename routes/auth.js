'use strict';

const express  = require('express');
const crypto   = require('crypto');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { z }    = require('zod');
const prisma   = require('../lib/db');
const { sendOtpEmail } = require('../lib/mailer');
const { notifyContactCreated } = require('../lib/ghl-webhook');
const { CookieStateStore } = require('../lib/oauth-state-store');

const router = express.Router();

// ── In-memory rate limiting ───────────────────────────────────────────────────
// send-code: max 3 OTPs per email per hour (prevents OTP spam)
const otpRateLimit = new Map(); // email → { count, resetAt }

function checkOtpRateLimit(email) {
  const now   = Date.now();
  const entry = otpRateLimit.get(email);

  if (!entry || entry.resetAt < now) {
    otpRateLimit.set(email, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true; // allowed
  }

  if (entry.count >= 3) return false; // rate-limited

  entry.count++;
  return true;
}

// verify-code: max 5 failed attempts per email → 15-min lockout (prevents OTP brute-force)
const verifyFailures = new Map(); // email → { failures, lockedUntil }

function isVerifyLocked(email) {
  const entry = verifyFailures.get(email);
  if (!entry) return false;
  return entry.lockedUntil > Date.now();
}

function recordVerifyFailure(email) {
  const now   = Date.now();
  const entry = verifyFailures.get(email) || { failures: 0, lockedUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= 5) {
    entry.lockedUntil = now + 15 * 60 * 1000; // 15-min lockout
    entry.failures    = 0;                     // reset counter after lockout
  }
  verifyFailures.set(email, entry);
}

function clearVerifyFailures(email) {
  verifyFailures.delete(email);
}

// ── Google OAuth strategy (only when credentials are configured) ───────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.GOOGLE_CALLBACK_URL,
  store:        new CookieStateStore(),
}, async (_accessToken, _refreshToken, profile, done) => {
  try {
    const email    = profile.emails?.[0]?.value;
    const googleId = profile.id;
    const name     = profile.displayName;
    const avatar   = profile.photos?.[0]?.value;

    if (!email) return done(new Error('Google account has no email'));

    const user = await prisma.user.upsert({
      where:  { googleId },
      update: { name, avatarUrl: avatar, email },
      create: { email, googleId, name, avatarUrl: avatar },
    });

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));
} // end if GOOGLE_CLIENT_ID

passport.serializeUser((user, done)   => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// ── POST /api/auth/send-code ─────────────────────────────────────────────────
router.post('/send-code', async (req, res) => {
  try {
    const { email, purpose = 'LOGIN' } = z.object({
      email:   z.string().email(),
      purpose: z.enum(['LOGIN', 'LINK_BOOKING']).optional().default('LOGIN'),
    }).parse(req.body);

    if (!checkOtpRateLimit(email)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 hora antes de tentar novamente.' });
    }

    // Invalidate previous codes for this email + purpose
    await prisma.verificationCode.updateMany({
      where:  { email, purpose, usedAt: null },
      data:   { usedAt: new Date() },
    });

    const code      = String(crypto.randomInt(100000, 999999));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await prisma.verificationCode.create({
      data: { email, code, purpose, expiresAt },
    });

    await sendOtpEmail({ to: email, code, purpose });

    res.json({ success: true, message: 'Código enviado. Verifique seu e-mail.' });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'E-mail inválido' });
    }
    console.error('[auth] send-code error:', err);
    res.status(500).json({ error: 'Erro ao enviar código. Tente novamente.' });
  }
});

// ── POST /api/auth/verify-code ────────────────────────────────────────────────
router.post('/verify-code', async (req, res) => {
  try {
    const { email, code, purpose = 'LOGIN' } = z.object({
      email:   z.string().email(),
      code:    z.string().length(6).regex(/^\d{6}$/),
      purpose: z.enum(['LOGIN', 'LINK_BOOKING']).optional().default('LOGIN'),
    }).parse(req.body);

    // Brute-force guard: 5 failed attempts → 15-min lockout
    if (isVerifyLocked(email)) {
      return res.status(429).json({ error: 'Muitas tentativas incorretas. Aguarde 15 minutos e solicite um novo código.' });
    }

    const record = await prisma.verificationCode.findFirst({
      where: {
        email,
        code,
        purpose,
        usedAt:    null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      recordVerifyFailure(email);
      return res.status(401).json({ error: 'Código inválido ou expirado.' });
    }

    // Successful verification — clear failure counter
    clearVerifyFailures(email);

    // Mark used
    await prisma.verificationCode.update({
      where: { id: record.id },
      data:  { usedAt: new Date() },
    });

    // Upsert user by email
    const isNew = !(await prisma.user.findUnique({ where: { email } }));
    const user  = await prisma.user.upsert({
      where:  { email },
      update: {},
      create: { email },
    });

    // Auto-link any anonymous bookings made with this email
    await prisma.booking.updateMany({
      where: { guestEmail: email, userId: null },
      data:  { userId: user.id },
    }).catch(e => console.error('[auth] auto-link bookings error:', e.message));

    // Notify GHL on first registration (non-blocking)
    if (isNew) {
      notifyContactCreated({ user }).catch(e =>
        console.error('[auth] GHL notify error:', e.message)
      );
    }

    // Set session — explicit save required with resave:false + saveUninitialized:false
    req.session.userId    = user.id;
    req.session.userEmail = user.email;

    req.session.save((err) => {
      if (err) {
        console.error('[auth] session save error:', err);
        return res.status(500).json({ error: 'Erro interno ao salvar sessão' });
      }
      res.json({ success: true, user: sanitizeUser(user) });
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'Dados inválidos' });
    }
    console.error('[auth] verify-code error:', err);
    res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

// ── POST /api/auth/resend-code ────────────────────────────────────────────────
// Alias for send-code — identical behaviour, separate endpoint for UX clarity
router.post('/resend-code', async (req, res) => {
  req.url = '/send-code';
  router.handle(req, res, () => {});
});

// ── GET /api/auth/google ──────────────────────────────────────────────────────
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

// ── GET /api/auth/google/callback ─────────────────────────────────────────────
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=google', session: false }),
  async (req, res) => {
    try {
      req.session.userId    = req.user.id;
      req.session.userEmail = req.user.email;

      // Auto-link any anonymous bookings made with this Google account's email
      await prisma.booking.updateMany({
        where: { guestEmail: req.user.email, userId: null },
        data:  { userId: req.user.id },
      }).catch(e => console.error('[auth] auto-link bookings (google) error:', e.message));

      const next = req.session.returnTo || '/dashboard';
      delete req.session.returnTo;

      // Explicit save required with resave:false + saveUninitialized:false
      req.session.save((err) => {
        if (err) {
          console.error('[auth] session save error (google):', err);
          return res.redirect('/login?error=google');
        }
        res.redirect(next);
      });
    } catch (err) {
      console.error('[auth] google callback error:', err);
      res.redirect('/login?error=google');
    }
  }
);

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('[auth] logout error:', err);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

// ── POST /api/auth/confirm-guest-invite ──────────────────────────────────────
router.post('/confirm-guest-invite', async (req, res) => {
  try {
    const { token, name, phone } = z.object({
      token: z.string().min(64),
      name:  z.string().min(2).max(100).optional(),
      phone: z.string().max(20).optional(),
    }).parse(req.body);

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invite = await prisma.bookingGuest.findFirst({
      where: {
        inviteToken:  tokenHash,
        inviteExpiry: { gt: new Date() },
        status:       'PENDENTE',
      },
    });

    if (!invite) return res.status(400).json({ error: 'Convite inválido ou expirado' });

    // Upsert guest user
    const updateData = {};
    if (name)  updateData.name  = name;
    if (phone) updateData.phone = phone;

    const user = await prisma.user.upsert({
      where:  { email: invite.email },
      update: updateData,
      create: { email: invite.email, name: name || invite.name, phone: phone || null },
    });

    // Mark invite confirmed
    await prisma.bookingGuest.update({
      where: { id: invite.id },
      data:  { status: 'CONFIRMADO', userId: user.id, inviteToken: null, inviteExpiry: null },
    });

    // Auto-link any bookings by email
    await prisma.booking.updateMany({
      where: { guestEmail: user.email, userId: null },
      data:  { userId: user.id },
    }).catch(e => console.error('[auth] confirm-guest auto-link error:', e.message));

    // Log in
    req.session.userId    = user.id;
    req.session.userEmail = user.email;

    req.session.save((err) => {
      if (err) {
        console.error('[auth] confirm-guest session save error:', err);
        return res.status(500).json({ error: 'Erro interno' });
      }
      res.json({ success: true, user: sanitizeUser(user) });
    });
  } catch (err) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Dados inválidos' });
    console.error('[auth] confirm-guest-invite error:', err);
    res.status(500).json({ error: 'Erro ao confirmar convite' });
  }
});

// ── PATCH /api/auth/profile ───────────────────────────────────────────────────
router.patch('/profile', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Não autenticado' });

  try {
    const { name, phone, cpf } = z.object({
      name:  z.string().min(2).max(100).optional(),
      phone: z.string().max(20).optional(),
      cpf:   z.string().regex(/^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/).optional().or(z.literal('')),
    }).parse(req.body);

    const data = {};
    if (name  !== undefined) data.name  = name;
    if (phone !== undefined) data.phone = phone || null;
    if (cpf   !== undefined) data.cpf   = cpf ? cpf.replace(/\D/g, '') : null;

    const user = await prisma.user.update({
      where: { id: req.session.userId },
      data,
    });

    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'Dados inválidos' });
    if (err?.code === 'P2002') return res.status(409).json({ error: 'CPF já cadastrado' });
    console.error('[auth] profile update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

function sanitizeUser(u) {
  return { id: u.id, email: u.email, name: u.name, phone: u.phone, cpf: u.cpf, avatarUrl: u.avatarUrl };
}

module.exports = router;
module.exports.passport = passport;
