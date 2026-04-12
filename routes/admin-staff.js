'use strict';

/**
 * Staff management API — ADMIN only.
 * Mounted at: /api/admin/staff
 * All routes require a valid JWT (Authorization: Bearer <token>) with role ADMIN.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../lib/db');
const { sendStaffInvite } = require('../lib/mailer');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });

  let payload;
  try {
    payload = jwt.verify(auth.slice(7), process.env.STAFF_JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }

  if (payload.role !== 'ADMIN') return res.status(403).json({ error: 'Permissão insuficiente' });

  const staff = await prisma.staffMember.findUnique({
    where: { id: payload.sub },
    select: { id: true, role: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });

  req.staff = staff;
  next();
}

router.use(requireAdmin);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function serializeStaffMember(s) {
  return {
    id: s.id,
    name: s.name,
    email: s.email,
    phone: s.phone,
    role: s.role,
    active: s.active,
    firstLoginDone: s.firstLoginDone,
    invitePending: !!s.inviteToken,
    properties: (s.properties || []).map((p) => p.property),
    createdAt: s.createdAt,
  };
}

async function fetchStaffWithProperties(where) {
  return prisma.staffMember.findUnique({
    where,
    include: {
      properties: { include: { property: { select: { id: true, name: true, slug: true } } } },
    },
  });
}

// GET /api/admin/staff/properties — list all active properties (for invite form)
router.get('/properties', async (_req, res) => {
  const properties = await prisma.property.findMany({
    where: { active: true },
    select: { id: true, name: true, slug: true },
    orderBy: { name: 'asc' },
  });
  return res.json(properties);
});

// GET /api/admin/staff — list all staff members
router.get('/', async (_req, res) => {
  const staff = await prisma.staffMember.findMany({
    include: {
      properties: { include: { property: { select: { id: true, name: true, slug: true } } } },
    },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
  });
  return res.json(staff.map(serializeStaffMember));
});

// POST /api/admin/staff — create + send invite
router.post('/', async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().optional(),
    role: z.enum(['ADMIN', 'GUARDIA', 'PISCINEIRO']),
    propertyIds: z.array(z.string()).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.issues });

  const { name, email, phone, role, propertyIds } = parsed.data;

  // Check email not already taken
  const existing = await prisma.staffMember.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'Este e-mail já está cadastrado' });

  // Generate secure invite token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  // Create staff member
  const staff = await prisma.staffMember.create({
    data: {
      name,
      email,
      phone: phone || null,
      role,
      active: true,
      firstLoginDone: false,
      inviteToken: tokenHash,
      inviteTokenExpiry: tokenExpiry,
    },
  });

  // Link to properties
  await prisma.staffPropertyAssignment.createMany({
    data: propertyIds.map((propertyId) => ({ staffId: staff.id, propertyId })),
    skipDuplicates: true,
  });

  // Send invite email
  const inviteUrl = `${process.env.STAFF_APP_URL}/aceitar-convite?token=${rawToken}`;
  try {
    await sendStaffInvite({ to: email, name, inviteUrl });
  } catch (err) {
    console.error('[admin-staff] Invite email failed:', err.message);
    // Don't fail the request — admin can resend later
  }

  const full = await fetchStaffWithProperties({ id: staff.id });
  return res.status(201).json(serializeStaffMember(full));
});

// PATCH /api/admin/staff/:id — update name, role, active, properties
router.patch('/:id', async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    role: z.enum(['ADMIN', 'GUARDIA', 'PISCINEIRO']).optional(),
    active: z.boolean().optional(),
    propertyIds: z.array(z.string()).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { name, role, active, propertyIds } = parsed.data;
  const { id } = req.params;

  const existing = await prisma.staffMember.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Membro não encontrado' });

  // Update base fields
  await prisma.staffMember.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(role !== undefined && { role }),
      ...(active !== undefined && { active }),
    },
  });

  // Update property assignments if provided
  if (propertyIds !== undefined) {
    await prisma.staffPropertyAssignment.deleteMany({ where: { staffId: id } });
    if (propertyIds.length > 0) {
      await prisma.staffPropertyAssignment.createMany({
        data: propertyIds.map((propertyId) => ({ staffId: id, propertyId })),
        skipDuplicates: true,
      });
    }
  }

  const updated = await fetchStaffWithProperties({ id });
  return res.json(serializeStaffMember(updated));
});

// POST /api/admin/staff/:id/reinvite — resend invite
router.post('/:id/reinvite', async (req, res) => {
  const { id } = req.params;

  const staff = await prisma.staffMember.findUnique({ where: { id } });
  if (!staff || !staff.email) return res.status(404).json({ error: 'Membro não encontrado' });

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(rawToken);
  const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.staffMember.update({
    where: { id },
    data: { inviteToken: tokenHash, inviteTokenExpiry: tokenExpiry },
  });

  const inviteUrl = `${process.env.STAFF_APP_URL}/aceitar-convite?token=${rawToken}`;
  try {
    await sendStaffInvite({ to: staff.email, name: staff.name, inviteUrl });
  } catch (err) {
    console.error('[admin-staff] Reinvite email failed:', err.message);
    return res.status(500).json({ error: 'Erro ao enviar e-mail. Tente novamente.' });
  }

  return res.json({ ok: true });
});

module.exports = router;
