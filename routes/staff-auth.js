const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const prisma = require('../lib/db');
const { sendAdminNotification, sendPasswordResetEmail } = require('../lib/mailer');
const { sendPushToRole } = require('../lib/push');
const { sendWhatsAppMessage } = require('../lib/ghl-webhook');
const { toE164 } = require('../lib/phone');

const router = express.Router();

if (!process.env.STAFF_JWT_SECRET) {
  throw new Error('[staff-auth] STAFF_JWT_SECRET env var not set');
}

// Rate limiter for auth endpoints — 10 attempts per 15 minutes per IP
// express-rate-limit v8 handles IPv6 + X-Forwarded-For natively when
// Express has trust proxy set (see server.js: app.set('trust proxy', 1))
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
});

function signStaffToken(staff) {
  return jwt.sign(
    { sub: staff.id, role: staff.role },
    process.env.STAFF_JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Helper: serialize staff member for response
function serializeStaff(staff) {
  return {
    id: staff.id,
    name: staff.name,
    email: staff.email,
    phone: staff.phone,
    role: staff.role,
    fontSizePreference: staff.fontSizePreference,
    firstLoginDone: staff.firstLoginDone,
    properties: (staff.properties || []).map((p) => p.property),
  };
}

// Helper: fetch staff with properties. Takes an optional prisma client so
// tests can inject a stub (sibling tests follow the same DI pattern — see
// lib/content-history.js).
//
// Production callers use the default export (no argument) which binds to
// the real singleton.
function makeFindStaffWithProperties(prismaClient) {
  return async function findStaffWithProperties(where) {
    return prismaClient.staffMember.findUnique({
      where,
      include: {
        properties: {
          // Exclude assignments pointing to inactive properties (e.g.
          // legacy duplicates soft-deleted during the 2026-04-21
          // consolidation). Without this filter the PropertyPicker
          // renders duplicate rows (2× RDI, 2× CDS) because legacy slugs
          // shared display names with their canonical replacements.
          where:   { property: { active: true } },
          include: { property: { select: { id: true, name: true, slug: true } } },
        },
      },
    });
  };
}

const findStaffWithProperties = makeFindStaffWithProperties(prisma);

// POST /api/staff/auth/login — email + senha
router.post('/login', authLimiter, async (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { email, password } = parsed.data;
  const staff = await findStaffWithProperties({ email });

  if (!staff || !staff.active) return res.status(401).json({ error: 'Credenciais inválidas' });
  if (!staff.passwordHash) return res.status(401).json({ error: 'Use outro método de login' });

  const valid = await bcrypt.compare(password, staff.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Credenciais inválidas' });

  return res.json({ ...serializeStaff(staff), staffToken: signStaffToken(staff) });
});

// POST /api/staff/auth/send-sms — gera OTP e envia via WhatsApp (GHL)
router.post('/send-sms', authLimiter, async (req, res) => {
  const schema = z.object({ phone: z.string().min(10) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Telefone inválido' });

  const phone = toE164(parsed.data.phone);

  // Verificar se o staff existe (sem revelar ao cliente).
  // Try E.164 first; also try raw-digits variants to handle legacy records
  // that were stored without normalization.
  const rawDigits = phone.replace(/\D/g, '');
  const phoneCandidates = [phone, rawDigits];
  // US number without +1 (11 digits starting with 1 → also try 10 digits)
  if (rawDigits.startsWith('1') && rawDigits.length === 11) phoneCandidates.push(rawDigits.slice(1));
  // Brazilian number without +55 (13 digits starting with 55 → also try 11 digits)
  if (rawDigits.startsWith('55') && rawDigits.length === 13) phoneCandidates.push(rawDigits.slice(2));

  const staff = await prisma.staffMember.findFirst({
    where: { phone: { in: phoneCandidates }, active: true },
  });
  if (!staff) {
    console.log(`[staff-auth] send-sms: ${phone} not found in staff DB`);
    return res.json({ sent: true }); // silent — don't reveal existence
  }

  // Gerar código de 6 dígitos
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

  // Invalidar códigos anteriores não utilizados para este telefone
  await prisma.verificationCode.updateMany({
    where: { phone, purpose: 'STAFF_LOGIN', usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.verificationCode.create({
    data: { phone, code, purpose: 'STAFF_LOGIN', expiresAt },
  });

  try {
    await sendWhatsAppMessage(
      phone,
      `🔐 Seu código de acesso à Central Recantos: *${code}*\n\nVálido por 15 minutos. Não compartilhe este código.`,
    );
  } catch (err) {
    console.error('[staff-auth] GHL WhatsApp send error:', err.message);
    return res.status(500).json({ error: 'Erro ao enviar código. Tente novamente.' });
  }

  return res.json({ sent: true });
});

// POST /api/staff/auth/verify-sms — valida código e autentica
router.post('/verify-sms', authLimiter, async (req, res) => {
  const schema = z.object({
    phone: z.string().min(10),
    code: z.string().length(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const phone = toE164(parsed.data.phone);
  const { code } = parsed.data;

  const record = await prisma.verificationCode.findFirst({
    where: {
      phone,
      code,
      purpose: 'STAFF_LOGIN',
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    return res.status(401).json({ error: 'Código inválido ou expirado' });
  }

  // Marcar como usado
  await prisma.verificationCode.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  // Look up staff with tolerant phone matching (same logic as send-sms)
  const rawDigitsV = phone.replace(/\D/g, '');
  const candidatesV = [phone, rawDigitsV];
  if (rawDigitsV.startsWith('1') && rawDigitsV.length === 11) candidatesV.push(rawDigitsV.slice(1));
  if (rawDigitsV.startsWith('55') && rawDigitsV.length === 13) candidatesV.push(rawDigitsV.slice(2));

  const staffBasic = await prisma.staffMember.findFirst({
    where: { phone: { in: candidatesV }, active: true },
    select: { id: true },
  });
  if (!staffBasic) return res.status(401).json({ error: 'Acesso não autorizado' });

  const staff = await findStaffWithProperties({ id: staffBasic.id });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso não autorizado' });

  return res.json({ ...serializeStaff(staff), staffToken: signStaffToken(staff) });
});

// POST /api/staff/auth/google-verify — internal: exchange a verified Google email for a staffToken
// Called server-side by the Next.js frontend jwt callback; requires x-internal-secret header.
router.post('/google-verify', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.STAFF_INTERNAL_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const staff = await findStaffWithProperties({ email });
  if (!staff || !staff.active) return res.status(404).json({ error: 'Staff member not found' });

  return res.json({ ...serializeStaff(staff), staffToken: signStaffToken(staff) });
});

// GET /api/staff/auth/me — dados do staff autenticado (JWT via Authorization header)
router.get('/me', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  const staff = await findStaffWithProperties({ id: payload.sub });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Não autenticado' });

  return res.json({ ...serializeStaff(staff), staffToken: signStaffToken(staff) });
});

// PATCH /api/staff/auth/font-size — salva preferência de fonte (primeiro acesso)
router.patch('/font-size', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  const staffId = payload.sub;

  const schema = z.object({ fontSize: z.enum(['SM', 'MD', 'LG', 'XL']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Tamanho inválido' });

  await prisma.staffMember.update({
    where: { id: staffId },
    data: { fontSizePreference: parsed.data.fontSize, firstLoginDone: true },
  });

  return res.json({ ok: true });
});

// POST /api/staff/auth/accept-invite — validate invite token, set password
router.post('/accept-invite', async (req, res) => {
  const schema = z.object({
    token: z.string().min(64),
    password: z.string().min(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { token, password } = parsed.data;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const staff = await prisma.staffMember.findFirst({
    where: {
      inviteToken: tokenHash,
      inviteTokenExpiry: { gt: new Date() },
    },
  });

  if (!staff) return res.status(400).json({ error: 'Convite inválido ou expirado' });

  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.staffMember.update({
    where: { id: staff.id },
    data: {
      passwordHash,
      inviteToken: null,
      inviteTokenExpiry: null,
      // firstLoginDone stays false — they'll pick font size on next login
    },
  });

  return res.json({ ok: true });
});

// POST /api/staff/auth/change-password — authenticated password change
router.post('/change-password', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { currentPassword, newPassword } = parsed.data;

  const staff = await prisma.staffMember.findUnique({ where: { id: payload.sub } });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });
  if (!staff.passwordHash) return res.status(400).json({ error: 'Use outro método de autenticação' });

  const valid = await bcrypt.compare(currentPassword, staff.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.staffMember.update({ where: { id: staff.id }, data: { passwordHash } });

  return res.json({ ok: true });
});

// ── Rate limit for password reset (3 per email per hour) ─────────────────────
const { checkLimit: checkResetLimit } = require('../lib/redis-rate-limit');

// POST /api/staff/auth/forgot-password — staff requests a self-service reset link
router.post('/forgot-password', async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'E-mail inválido' });

  const { email } = parsed.data;

  if (!(await checkResetLimit('reset:' + email, 3, 60 * 60 * 1000)).ok) {
    // Return ok to prevent enumeration — client shows success regardless
    return res.json({ ok: true });
  }

  try {
    const staff = await prisma.staffMember.findUnique({ where: { email } });
    if (staff && staff.active) {
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const expiry    = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.staffMember.update({
        where: { id: staff.id },
        data:  { passwordResetToken: tokenHash, passwordResetExpiry: expiry },
      });

      const appUrl  = process.env.STAFF_APP_URL || 'https://app.recantosdaserra.com';
      const resetUrl = `${appUrl}/redefinir-senha?token=${rawToken}`;

      await sendPasswordResetEmail({ to: email, name: staff.name, resetUrl })
        .catch(e => console.error('[staff-auth] forgot-password email error:', e.message));
    }
  } catch (e) {
    console.error('[staff-auth] forgot-password error:', e.message);
  }

  // Always return ok — no email enumeration
  return res.json({ ok: true });
});

// POST /api/staff/auth/reset-password — validates token and sets new password
router.post('/reset-password', async (req, res) => {
  const parsed = z.object({
    token:       z.string().min(64),
    newPassword: z.string().min(8),
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { token, newPassword } = parsed.data;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const staff = await prisma.staffMember.findFirst({
      where: {
        passwordResetToken:  tokenHash,
        passwordResetExpiry: { gt: new Date() },
        active:              true,
      },
    });

    if (!staff) {
      return res.status(400).json({ error: 'Link inválido ou expirado' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await prisma.staffMember.update({
      where: { id: staff.id },
      data:  {
        passwordHash,
        passwordResetToken:  null,
        passwordResetExpiry: null,
      },
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('[staff-auth] reset-password error:', e.message);
    return res.status(500).json({ error: 'Erro ao redefinir senha' });
  }
});

// POST /api/staff/auth/request-recovery — staff asks admin to reset their password
router.post('/request-recovery', async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'E-mail inválido' });

  try {
    const staff = await prisma.staffMember.findUnique({ where: { email: parsed.data.email } });
    if (staff && staff.active) {
      await sendAdminNotification({
        subject: `Solicitação de recuperação de senha — ${staff.name}`,
        text: `O membro ${staff.name} (${staff.email}) solicita redefinição de senha.\n\nAcesse /admin/equipe → Editar → Reenviar convite para gerar um novo link de acesso.`,
      }).catch(e => console.error('[staff-auth] recovery email error:', e.message));

      sendPushToRole('ADMIN', {
        title: 'Solicitação de recuperação de senha',
        body:  `${staff.name} precisa redefinir o acesso`,
        type:  'STAFF_RECOVERY_REQUEST',
        data:  {},
      }).catch(e => console.error('[staff-auth] recovery push error:', e.message));
    }
  } catch (e) {
    console.error('[staff-auth] request-recovery error:', e.message);
  }

  // Always return ok — no email enumeration
  return res.json({ ok: true });
});

// POST /api/staff/auth/request-access — new person requests to be added to the system
//
// Persistence contract: writes to AccessRequest BEFORE firing notifications
// so admins can review the request via /admin/equipe/solicitacoes even if
// Gmail OAuth is broken (Sthefane Souza's 2026-04-21 request was silently
// dropped because the notification email was the only record).
//
// Factored into a DI-friendly factory so the persistence contract can be
// unit-tested with a stub Prisma client (see
// __tests__/access-request.persistence.test.mjs).
function makeRequestAccessHandler(deps) {
  const {
    prisma: prismaDep = prisma,
    sendAdminNotification: sendAdminNotificationDep = sendAdminNotification,
    sendPushToRole: sendPushToRoleDep = sendPushToRole,
  } = deps || {};

  return async function requestAccessHandler(req, res) {
    const parsed = z.object({
      name:    z.string().min(2),
      email:   z.string().email(),
      phone:   z.string().optional(),
      message: z.string().max(500).optional(),
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

    const { name, email, phone, message } = parsed.data;

    // Persist FIRST so the request survives even if the email helper throws.
    try {
      await prismaDep.accessRequest.create({
        data: { name, email, phone: phone ?? null, message: message ?? null },
      });
    } catch (e) {
      console.error('[staff-auth] request-access persist error:', e.message);
      // Continue — the notification email/push is a best-effort fallback.
    }

    // Notification status reporting (2026-04-21): callers get back a
    // concrete {email, push} status so the flakiness is visible without
    // having to tail logs. 'sent' on success, 'failed' on thrown error,
    // 'skipped' is reserved for a future "intentionally suppressed" case.
    const notifications = { email: 'skipped', push: 'skipped' };

    const lines = [
      `Nome: ${name}`,
      `E-mail: ${email}`,
      phone ? `Telefone: ${phone}` : null,
      message ? `\nMensagem: ${message}` : null,
      `\nAcesse /admin/equipe para criar a conta e enviar o convite.`,
    ].filter(Boolean).join('\n');

    try {
      await sendAdminNotificationDep({
        subject: `Nova solicitação de acesso à Central da Equipe — ${name}`,
        text: lines,
      });
      notifications.email = 'sent';
    } catch (e) {
      notifications.email = 'failed';
      // Gmail OAuth staleness is the recurring root cause — log a grep
      // target so on-call finds the fix link without spelunking.
      console.error(
        '[staff-auth] access-request email skipped (Gmail OAuth stale — refresh at https://console.cloud.google.com):',
        e.message,
      );
    }

    // Push is non-blocking and the more reliable surface (web-push does
    // not depend on Gmail OAuth). Awaited here so we can report its
    // outcome back to the caller.
    try {
      await sendPushToRoleDep('ADMIN', {
        title: 'Nova solicitação de acesso',
        body:  `${name} quer entrar na Central da Equipe`,
        type:  'STAFF_ACCESS_REQUEST',
        data:  { name, email },
      });
      notifications.push = 'sent';
    } catch (e) {
      notifications.push = 'failed';
      console.error('[staff-auth] request-access push error:', e.message);
    }

    return res.json({ ok: true, notifications });
  };
}

router.post('/request-access', makeRequestAccessHandler());

// PATCH /api/staff/auth/inbox-settings — save email signature and push toggle
router.patch('/inbox-settings', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  const staffId = payload.sub;

  const schema = z.object({
    emailSignature:   z.string().max(500).nullable().optional(),
    inboxPushEnabled: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const data = {};
  if (parsed.data.emailSignature !== undefined) data.emailSignature   = parsed.data.emailSignature;
  if (parsed.data.inboxPushEnabled !== undefined) data.inboxPushEnabled = parsed.data.inboxPushEnabled;

  const updated = await prisma.staffMember.update({
    where:  { id: staffId },
    data,
    select: { emailSignature: true, inboxPushEnabled: true },
  });

  return res.json(updated);
});

// GET /api/staff/auth/inbox-settings — retrieve email signature and push toggle
router.get('/inbox-settings', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
  const staffId = payload.sub;

  const staff = await prisma.staffMember.findUnique({
    where:  { id: staffId },
    select: { emailSignature: true, inboxPushEnabled: true },
  });

  if (!staff) return res.status(404).json({ error: 'Não encontrado' });
  return res.json(staff);
});

module.exports = router;
module.exports.findStaffWithProperties = findStaffWithProperties;
module.exports.makeFindStaffWithProperties = makeFindStaffWithProperties;
module.exports.makeRequestAccessHandler = makeRequestAccessHandler;
