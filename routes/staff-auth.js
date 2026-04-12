const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../lib/db');

const router = express.Router();

// Lazy-load Twilio only if credentials are present
function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  const twilio = require('twilio');
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Normalize phone to E.164 — strips all non-digits, prepends +
// Works for both US (+1...) and Brazilian (+55...) numbers
function toE164(raw) {
  const digits = raw.replace(/\D/g, '');
  if (raw.trimStart().startsWith('+')) return '+' + digits;
  // 10 digits = US without country code
  if (digits.length === 10) return '+1' + digits;
  // Already has country code (11+ digits)
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

  return res.json(serializeStaff(staff));
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

  return res.json(serializeStaff(staff));
});

// GET /api/staff/auth/me — dados do staff autenticado (ID via header)
router.get('/me', async (req, res) => {
  const staffId = req.headers['x-staff-id'];
  if (!staffId) return res.status(401).json({ error: 'Não autenticado' });

  const staff = await findStaffWithProperties({ id: staffId });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Não autenticado' });

  return res.json(serializeStaff(staff));
});

// PATCH /api/staff/auth/font-size — salva preferência de fonte (primeiro acesso)
router.patch('/font-size', async (req, res) => {
  const staffId = req.headers['x-staff-id'];
  if (!staffId) return res.status(401).json({ error: 'Não autenticado' });

  const schema = z.object({ fontSize: z.enum(['SM', 'MD', 'LG', 'XL']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Tamanho inválido' });

  await prisma.staffMember.update({
    where: { id: staffId },
    data: { fontSizePreference: parsed.data.fontSize, firstLoginDone: true },
  });

  return res.json({ ok: true });
});

module.exports = router;
