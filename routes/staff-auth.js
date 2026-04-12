const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../lib/db');
const { sendAdminNotification, sendPasswordResetEmail } = require('../lib/mailer');

const router = express.Router();

if (!process.env.STAFF_JWT_SECRET) {
  throw new Error('[staff-auth] STAFF_JWT_SECRET env var not set');
}

function signStaffToken(staff) {
  return jwt.sign(
    { sub: staff.id, role: staff.role },
    process.env.STAFF_JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// Lazy-load Twilio only if credentials are present
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  const twilio = require('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Normalize phone to E.164 — strips all non-digits, prepends country code.
// Brazilian numbers: 10 digits (DDD + 8) or 11 digits (DDD + 9) → +55
// Numbers already with + prefix: use as-is
function toE164(raw) {
  const digits = raw.replace(/\D/g, '');
  if (raw.trimStart().startsWith('+')) return '+' + digits;
  // 10 or 11 digits without + → Brazilian number (DDD + number)
  if (digits.length === 10 || digits.length === 11) return '+55' + digits;
  // Otherwise assume full international digits provided
  return '+' + digits;
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

// Helper: fetch staff with properties
async function findStaffWithProperties(where) {
  return prisma.staffMember.findUnique({
    where,
    include: {
      properties: {
        include: { property: { select: { id: true, name: true, slug: true } } },
      },
    },
  });
}

// POST /api/staff/auth/login — email + senha
router.post('/login', async (req, res) => {
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

// POST /api/staff/auth/send-sms — solicita código via Twilio Verify
router.post('/send-sms', async (req, res) => {
  const schema = z.object({ phone: z.string().min(10) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Telefone inválido' });

  const phone = toE164(parsed.data.phone);

  const twilioClient = getTwilioClient();
  if (!twilioClient || !process.env.TWILIO_VERIFY_SID) {
    console.error('[staff-auth] Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID');
    return res.status(503).json({ error: 'WhatsApp não configurado. Use o login por e-mail.' });
  }

  // Verificar se o staff existe (sem revelar ao cliente)
  const staff = await prisma.staffMember.findUnique({ where: { phone } });
  if (!staff || !staff.active) {
    console.log(`[staff-auth] send-sms: ${phone} not found in staff DB`);
    return res.json({ sent: true }); // silent — don't reveal existence
  }

  try {
    await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verifications.create({ to: phone, channel: 'whatsapp' });
    return res.json({ sent: true });
  } catch (err) {
    console.error('[staff-auth] Twilio send-sms error:', err.message);
    return res.status(500).json({ error: 'Erro ao enviar SMS. Tente novamente.' });
  }
});

// POST /api/staff/auth/verify-sms — valida código e autentica
router.post('/verify-sms', async (req, res) => {
  const schema = z.object({
    phone: z.string().min(10),
    code: z.string().length(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const phone = toE164(parsed.data.phone);
  const { code } = parsed.data;

  const twilioClient = getTwilioClient();
  if (!twilioClient || !process.env.TWILIO_VERIFY_SID) {
    return res.status(503).json({ error: 'SMS não configurado' });
  }

  try {
    const check = await twilioClient.verify.v2
      .services(process.env.TWILIO_VERIFY_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== 'approved') {
      return res.status(401).json({ error: 'Código inválido ou expirado' });
    }
  } catch (err) {
    console.error('[staff-auth] Twilio verify-sms error:', err.message);
    return res.status(500).json({ error: 'Erro ao verificar código. Tente novamente.' });
  }

  const staff = await findStaffWithProperties({ phone });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso não autorizado' });

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
const resetRateLimit = new Map(); // email → { count, resetAt }

function checkResetRateLimit(email) {
  const now   = Date.now();
  const entry = resetRateLimit.get(email);
  if (!entry || entry.resetAt < now) {
    resetRateLimit.set(email, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

// POST /api/staff/auth/forgot-password — staff requests a self-service reset link
router.post('/forgot-password', async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'E-mail inválido' });

  const { email } = parsed.data;

  if (!checkResetRateLimit(email)) {
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
    }
  } catch (e) {
    console.error('[staff-auth] request-recovery error:', e.message);
  }

  // Always return ok — no email enumeration
  return res.json({ ok: true });
});

// POST /api/staff/auth/request-access — new person requests to be added to the system
router.post('/request-access', async (req, res) => {
  const parsed = z.object({
    name:    z.string().min(2),
    email:   z.string().email(),
    phone:   z.string().optional(),
    message: z.string().max(500).optional(),
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { name, email, phone, message } = parsed.data;

  try {
    const lines = [
      `Nome: ${name}`,
      `E-mail: ${email}`,
      phone ? `Telefone: ${phone}` : null,
      message ? `\nMensagem: ${message}` : null,
      `\nAcesse /admin/equipe para criar a conta e enviar o convite.`,
    ].filter(Boolean).join('\n');

    await sendAdminNotification({
      subject: `Nova solicitação de acesso à Central da Equipe — ${name}`,
      text: lines,
    }).catch(e => console.error('[staff-auth] request-access email error:', e.message));
  } catch (e) {
    console.error('[staff-auth] request-access error:', e.message);
  }

  return res.json({ ok: true });
});

module.exports = router;
