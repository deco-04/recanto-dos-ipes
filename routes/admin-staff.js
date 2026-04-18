'use strict';

/**
 * Staff management API — ADMIN only.
 * Mounted at: /api/admin/staff
 * All routes require a valid JWT (Authorization: Bearer <token>) with role ADMIN.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { z } = require('zod');
const prisma = require('../lib/db');
const { sendStaffInvite } = require('../lib/mailer');
const { sendPushToRole, sendPushToStaff } = require('../lib/push');
const { deriveTierFromPrice } = require('../lib/pricing');
const { requireAdmin } = require('../lib/staff-auth-middleware');
const { toE164 } = require('../lib/phone');

const router = express.Router();

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
    role: z.enum(['ADMIN', 'GOVERNANTA', 'PISCINEIRO']),
    propertyIds: z.array(z.string()).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.issues });

  const { name, email, role, propertyIds } = parsed.data;
  const phone = parsed.data.phone ? toE164(parsed.data.phone) : null;

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
      phone,
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

  // Push to other admins so they know a new team member was added
  const roleLabel = role === 'GOVERNANTA' ? 'Governanta' : role === 'PISCINEIRO' ? 'Piscineiro' : 'Admin';
  sendPushToRole('ADMIN', {
    title: 'Novo membro da equipe adicionado 👤',
    body:  `${name} (${roleLabel}) foi adicionado(a) à equipe`,
    type:  'STAFF_MEMBER_ADDED',
    data:  { staffId: staff.id },
  }).catch(e => console.error('[push] staff created push failed:', e.message));

  return res.status(201).json(serializeStaffMember(full));
});

// PATCH /api/admin/staff/:id — update name, role, active, properties
router.patch('/:id', async (req, res) => {
  const schema = z.object({
    name: z.string().min(2).optional(),
    role: z.enum(['ADMIN', 'GOVERNANTA', 'PISCINEIRO']).optional(),
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

// ─────────────────────────────────────────────────────────────────────────────
// GUESTS (Hóspedes)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/hospedes — guest list with reputation
router.get('/hospedes', async (_req, res) => {
  const guests = await prisma.user.findMany({
    where: { bookings: { some: {} } }, // only guests who have at least one booking
    include: {
      reputation: true,
      bookings: {
        select: { id: true, status: true, totalAmount: true, checkIn: true, checkOut: true, source: true },
        orderBy: { checkIn: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json(guests.map((g) => ({
    id: g.id,
    name: g.name,
    email: g.email,
    phone: g.phone,
    cpf: g.cpf,
    createdAt: g.createdAt,
    totalStays: g.reputation?.totalStays ?? g.bookings.filter(b => b.status === 'CONFIRMED').length,
    totalSpent: parseFloat((g.reputation?.totalSpent ?? g.bookings
      .filter(b => b.status === 'CONFIRMED')
      .reduce((s, b) => s + parseFloat(b.totalAmount?.toString() || '0'), 0)).toString()),
    tier: g.reputation?.tier ?? 'VISITANTE',
    averageScore: g.reputation?.averageScore ?? null,
    lastStay: g.bookings[0]?.checkIn ?? null,
  })));
});

// GET /api/admin/staff/hospedes/:id — full guest profile
router.get('/hospedes/:id', async (req, res) => {
  const guest = await prisma.user.findUnique({
    where: { id: req.params.id },
    include: {
      reputation: true,
      bookings: {
        include: { property: { select: { name: true } } },
        orderBy: { checkIn: 'desc' },
      },
    },
  });
  if (!guest) return res.status(404).json({ error: 'Hóspede não encontrado' });

  const surveys = await prisma.survey.findMany({
    where: { booking: { userId: guest.id } },
    orderBy: { respondedAt: 'desc' },
  });

  return res.json({
    id: guest.id,
    name: guest.name,
    email: guest.email,
    phone: guest.phone,
    cpf: guest.cpf,
    createdAt: guest.createdAt,
    reputation: guest.reputation,
    bookings: guest.bookings.map(b => ({
      id: b.id,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      nights: b.nights,
      guests: b.guestCount,
      total: parseFloat(b.totalAmount?.toString() || '0'),
      status: b.status,
      source: b.source,
      property: b.property?.name ?? 'Sítio',
    })),
    surveys,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASKS (Tarefas)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/tarefas
router.get('/tarefas', async (_req, res) => {
  const tasks = await prisma.staffTask.findMany({
    include: {
      assignedTo: { select: { id: true, name: true, role: true } },
      assignedBy: { select: { id: true, name: true } },
    },
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
  });
  return res.json(tasks);
});

// POST /api/admin/staff/tarefas
router.post('/tarefas', async (req, res) => {
  const schema = z.object({
    title: z.string().min(2).max(200),
    description: z.string().optional(),
    dueDate: z.string().datetime({ offset: true }).optional(),
    assignedToId: z.string().optional(),
    bookingId: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.issues });

  const { title, description, dueDate, assignedToId, bookingId } = parsed.data;

  if (assignedToId) {
    const exists = await prisma.staffMember.findUnique({ where: { id: assignedToId }, select: { id: true } });
    if (!exists) return res.status(400).json({ error: 'Membro não encontrado' });
  }

  const task = await prisma.staffTask.create({
    data: {
      title,
      description: description ?? null,
      dueDate: dueDate ? new Date(dueDate) : null,
      assignedToId: assignedToId ?? null,
      assignedById: req.staff.id,
      bookingId: bookingId ?? null,
      status: 'PENDENTE',
    },
    include: {
      assignedTo: { select: { id: true, name: true, role: true } },
      assignedBy: { select: { id: true, name: true } },
    },
  });

  // Notify the assigned staff member about their new task
  if (assignedToId) {
    const dueDateLabel = dueDate
      ? ` · Prazo: ${new Date(dueDate).toLocaleDateString('pt-BR')}`
      : '';
    sendPushToStaff(assignedToId, {
      title: 'Nova tarefa atribuída a você 📋',
      body:  `${title}${dueDateLabel}`,
      type:  'TASK_ASSIGNED',
      data:  { taskId: task.id },
    }).catch(e => console.error('[push] task assigned push failed:', e.message));
  }

  return res.status(201).json(task);
});

// PATCH /api/admin/staff/tarefas/:id — toggle status or update fields
router.patch('/tarefas/:id', async (req, res) => {
  const schema = z.object({
    status: z.enum(['PENDENTE', 'FEITO']).optional(),
    title: z.string().min(2).max(200).optional(),
    dueDate: z.string().nullable().optional(),
    assignedToId: z.string().nullable().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const task = await prisma.staffTask.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: 'Tarefa não encontrada' });

  const { status, title, dueDate, assignedToId } = parsed.data;

  const updated = await prisma.staffTask.update({
    where: { id: req.params.id },
    data: {
      ...(status !== undefined && { status }),
      ...(status === 'FEITO' && { completedAt: new Date() }),
      ...(status === 'PENDENTE' && { completedAt: null }),
      ...(title !== undefined && { title }),
      ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
      ...(assignedToId !== undefined && { assignedToId }),
    },
    include: {
      assignedTo: { select: { id: true, name: true, role: true } },
      assignedBy: { select: { id: true, name: true } },
    },
  });

  // Notify new assignee when task is reassigned
  if (assignedToId && assignedToId !== task.assignedToId) {
    sendPushToStaff(assignedToId, {
      title: 'Tarefa atribuída a você 📋',
      body:  updated.title,
      type:  'TASK_ASSIGNED',
      data:  { taskId: updated.id },
    }).catch(e => console.error('[push] task reassigned push failed:', e.message));
  }

  // Notify ADMIN when task is marked done (non-blocking)
  if (status === 'FEITO') {
    const completedByName = updated.assignedTo?.name || 'Equipe';
    sendPushToRole('ADMIN', {
      title: 'Tarefa concluída ✅',
      body:  `${updated.title} — concluída por ${completedByName}`,
      type:  'TASK_COMPLETED',
      data:  { taskId: updated.id },
    }).catch(e => console.error('[push] task completed push failed:', e.message));
  }

  return res.json(updated);
});

// ─────────────────────────────────────────────────────────────────────────────
// INSPECTIONS (Vistorias) — admin overview
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/vistorias
router.get('/vistorias', async (_req, res) => {
  const reports = await prisma.inspectionReport.findMany({
    include: {
      booking: {
        select: { id: true, guestName: true, checkIn: true, checkOut: true },
      },
      staff: { select: { id: true, name: true } },
      items: { where: { status: 'PROBLEMA' }, select: { description: true, problemDescription: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return res.json(reports.map(r => ({
    id: r.id,
    type: r.type,
    status: r.status,
    submittedAt: r.submittedAt,
    createdAt: r.createdAt,
    booking: r.booking,
    staff: r.staff,
    problemCount: r.items.length,
    problems: r.items,
  })));
});

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK (Surveys)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/feedbacks
router.get('/feedbacks', async (_req, res) => {
  const surveys = await prisma.survey.findMany({
    include: {
      booking: {
        select: {
          id: true,
          guestName: true,
          guestEmail: true,
          checkIn: true,
          checkOut: true,
        },
      },
    },
    orderBy: { respondedAt: 'desc' },
    take: 200,
  });

  const responded = surveys.filter(s => s.respondedAt);
  const avg = responded.length > 0
    ? responded.reduce((s, x) => s + (x.score ?? 0), 0) / responded.length
    : null;

  return res.json({
    averageScore: avg ? Math.round(avg * 10) / 10 : null,
    total: responded.length,
    pending: surveys.filter(s => !s.respondedAt).length,
    surveys: surveys.map(s => ({
      id: s.id,
      score: s.score,
      comment: s.comment,
      sentAt: s.sentAt,
      respondedAt: s.respondedAt,
      googleReviewLinkSent: s.googleReviewLinkSent,
      booking: s.booking,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRICING (Preços sazonais)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/precos
router.get('/precos', async (_req, res) => {
  const pricing = await prisma.seasonalPricing.findMany({
    orderBy: { startDate: 'asc' },
  });
  return res.json(pricing);
});

// POST /api/admin/staff/precos
router.post('/precos', async (req, res) => {
  const schema = z.object({
    startDate: z.string(),
    endDate: z.string(),
    pricePerNight: z.number().positive(),
    minNights: z.number().int().min(1).default(1),
    tier: z.enum(['LOW', 'MID', 'HIGH_MID', 'PEAK']).default('MID'),
    propertyId: z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.issues });

  const rule = await prisma.seasonalPricing.create({
    data: {
      ...parsed.data,
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
    },
  });
  return res.status(201).json(rule);
});

// PUT /api/admin/staff/precos/:id
router.put('/precos/:id', async (req, res) => {
  const schema = z.object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    pricePerNight: z.number().positive().optional(),
    minNights: z.number().int().min(1).optional(),
    tier: z.enum(['LOW', 'MID', 'HIGH_MID', 'PEAK']).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const existing = await prisma.seasonalPricing.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Regra não encontrada' });

  const data = { ...parsed.data };
  if (data.startDate) data.startDate = new Date(data.startDate);
  if (data.endDate) data.endDate = new Date(data.endDate);

  const updated = await prisma.seasonalPricing.update({ where: { id: req.params.id }, data });
  return res.json(updated);
});

// DELETE /api/admin/staff/precos/:id
router.delete('/precos/:id', async (req, res) => {
  const existing = await prisma.seasonalPricing.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Regra não encontrada' });
  await prisma.seasonalPricing.delete({ where: { id: req.params.id } });
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR (Calendário admin)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/calendario?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/calendario', async (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to   = req.query.to   ? new Date(req.query.to)   : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  const [bookings, blocked] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PENDING'] },
        checkIn: { lte: to },
        checkOut: { gte: from },
      },
      select: {
        id: true,
        guestName: true,
        checkIn: true,
        checkOut: true,
        nights: true,
        guestCount: true,
        status: true,
        source: true,
        totalAmount: true,
      },
      orderBy: { checkIn: 'asc' },
    }),
    prisma.blockedDate.findMany({
      where: {
        date: { gte: from, lte: to },
      },
      select: { date: true, source: true, summary: true },
      orderBy: { date: 'asc' },
    }),
  ]);

  return res.json({
    bookings: bookings.map(b => ({
      ...b,
      totalAmount: parseFloat(b.totalAmount?.toString() || '0'),
    })),
    blocked,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI PRICING SUGGESTIONS (Sugestões de precificação)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/admin/staff/ia/precos — optional ?propertyId= filter
router.get('/ia/precos', async (req, res) => {
  const { propertyId } = req.query;
  const where = propertyId && propertyId !== 'all' ? { propertyId } : {};
  const suggestions = await prisma.pricingSuggestion.findMany({
    where,
    include: {
      acceptedBy: { select: { id: true, name: true } },
      property:   { select: { id: true, name: true } },
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  return res.json(suggestions.map(s => ({
    id: s.id,
    propertyId: s.propertyId,
    propertyName: s.property?.name ?? null,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    currentPrice: parseFloat(s.currentPrice?.toString() || '0'),
    suggestedPrice: parseFloat(s.suggestedPrice?.toString() || '0'),
    reason: s.reason,
    status: s.status,
    acceptedBy: s.acceptedBy,
    acceptedAt: s.acceptedAt,
    createdAt: s.createdAt,
  })));
});

// PATCH /api/admin/staff/ia/precos/:id — accept or reject
// On ACEITA: deletes any overlapping SeasonalPricing rows and creates a new one.
router.patch('/ia/precos/:id', async (req, res) => {
  const schema = z.object({
    status: z.enum(['ACEITA', 'REJEITADA']),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const suggestion = await prisma.pricingSuggestion.findUnique({ where: { id: req.params.id } });
  if (!suggestion) return res.status(404).json({ error: 'Sugestão não encontrada' });
  if (suggestion.status !== 'PENDENTE') return res.status(409).json({ error: 'Sugestão já processada' });

  if (parsed.data.status === 'ACEITA') {
    const tier = deriveTierFromPrice(suggestion.suggestedPrice);

    // Format date range for name: "DD/MM a DD/MM/YYYY"
    const startFmt = new Date(suggestion.periodStart).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', timeZone: 'UTC',
    });
    const endFmt = new Date(suggestion.periodEnd).toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
    });
    const name = `Sugestão IA — ${startFmt} a ${endFmt}`;

    // Run everything in a transaction: update suggestion + replace overlapping rows
    const [updated] = await prisma.$transaction([
      prisma.pricingSuggestion.update({
        where: { id: req.params.id },
        data: {
          status:        'ACEITA',
          acceptedById:  req.staff.id,
          acceptedAt:    new Date(),
        },
      }),
      // Delete all SeasonalPricing rows that overlap the accepted period
      prisma.seasonalPricing.deleteMany({
        where: {
          propertyId: suggestion.propertyId,
          startDate:  { lte: suggestion.periodEnd },
          endDate:    { gte: suggestion.periodStart },
        },
      }),
      prisma.seasonalPricing.create({
        data: {
          name,
          tier,
          startDate:     suggestion.periodStart,
          endDate:       suggestion.periodEnd,
          pricePerNight: suggestion.suggestedPrice,
          minNights:     2,
          propertyId:    suggestion.propertyId,
        },
      }),
    ]);

    return res.json(updated);
  }

  // REJEITADA — just mark as rejected
  const updated = await prisma.pricingSuggestion.update({
    where: { id: req.params.id },
    data: { status: 'REJEITADA' },
  });

  return res.json(updated);
});

// ── GET /api/admin/staff/properties/:id/pricing ───────────────────────────────
router.get('/properties/:id/pricing', async (req, res) => {
  try {
    const prop = await prisma.property.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, pricingConfig: true },
    });
    if (!prop) return res.status(404).json({ error: 'Propriedade não encontrada' });

    // Return stored config or defaults
    const defaults = {
      tiers: { LOW: 720, MID: 850, HIGH_MID: 1050, PEAK: 1300 },
      extraGuestPerNight: 50,
      cleaningFee: 270,
      baseGuests: 11,
    };
    res.json({ id: prop.id, name: prop.name, pricing: prop.pricingConfig || defaults });
  } catch (err) {
    console.error('[admin-staff] GET pricing error:', err);
    res.status(500).json({ error: 'Erro ao buscar configuração de preços' });
  }
});

// ── PATCH /api/admin/staff/properties/:id/pricing ─────────────────────────────
router.patch('/properties/:id/pricing', async (req, res) => {
  const schema = z.object({
    tiers: z.object({
      LOW:      z.number().min(0),
      MID:      z.number().min(0),
      HIGH_MID: z.number().min(0),
      PEAK:     z.number().min(0),
    }),
    extraGuestPerNight: z.number().min(0),
    cleaningFee:        z.number().min(0),
    baseGuests:         z.number().int().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });

  try {
    const prop = await prisma.property.update({
      where: { id: req.params.id },
      data:  { pricingConfig: parsed.data },
      select: { id: true, name: true, pricingConfig: true },
    });
    res.json({ id: prop.id, name: prop.name, pricing: prop.pricingConfig });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Propriedade não encontrada' });
    console.error('[admin-staff] PATCH pricing error:', err);
    res.status(500).json({ error: 'Erro ao salvar configuração de preços' });
  }
});

module.exports = router;
