'use strict';

/**
 * Staff Portal API — endpoints for the "Central da Equipe" Next.js PWA
 * All routes require x-staff-id header (validated against StaffMember.id)
 * Mounted at: /api/staff
 */

const express = require('express');
const { z } = require('zod');
const prisma = require('../lib/db');

const router = express.Router();

// ── Auth middleware ─────────────────────────────────────────────────────────
async function requireStaff(req, res, next) {
  const staffId = req.headers['x-staff-id'];
  if (!staffId) return res.status(401).json({ error: 'Não autenticado' });

  const staff = await prisma.staffMember.findUnique({
    where: { id: staffId },
    select: { id: true, role: true, active: true },
  });
  if (!staff || !staff.active) return res.status(401).json({ error: 'Acesso negado' });

  req.staff = staff;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.staff?.role)) {
      return res.status(403).json({ error: 'Permissão insuficiente' });
    }
    next();
  };
}

router.use(requireStaff);

// Helper: serialize booking for front-end consumption
function serializeBooking(b) {
  const sourceMap = { BOOKING_COM: 'BOOKING', AIRBNB: 'AIRBNB', DIRECT: 'DIRECT' };
  return {
    id: b.id,
    guestName: b.user?.name || b.guestName || 'Hóspede',
    checkIn: b.checkIn.toISOString(),
    checkOut: b.checkOut.toISOString(),
    guests: b.guestCount,
    totalPrice: parseFloat(b.totalAmount?.toString() || '0'),
    status: b.status,
    source: sourceMap[b.source] || 'DIRECT',
  };
}

// ── GET /api/staff/reservas ─────────────────────────────────────────────────
router.get('/reservas', requireRole('ADMIN'), async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      orderBy: { checkIn: 'desc' },
      take: 100,
      include: { user: { select: { name: true } } },
    });
    res.json(bookings.map(serializeBooking));
  } catch (err) {
    console.error('[staff-portal] reservas error:', err);
    res.status(500).json({ error: 'Erro ao buscar reservas' });
  }
});

// ── GET /api/staff/reservas/:id ─────────────────────────────────────────────
router.get('/reservas/:id', async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { name: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    res.json(serializeBooking(booking));
  } catch (err) {
    console.error('[staff-portal] reserva/:id error:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva' });
  }
});

// ── GET /api/staff/financeiro ────────────────────────────────────────────────
router.get('/financeiro', requireRole('ADMIN'), async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED'] },
        checkIn: { gte: start, lte: end },
      },
    });

    const totalDias = end.getDate();
    const faturamentoTotal = bookings.reduce(
      (sum, b) => sum + parseFloat(b.totalAmount?.toString() || '0'),
      0
    );
    const qtdReservas = bookings.length;

    const diariamedia = qtdReservas > 0
      ? bookings.reduce((sum, b) => {
          const n = Math.round((new Date(b.checkOut) - new Date(b.checkIn)) / (1000 * 60 * 60 * 24));
          return sum + parseFloat(b.totalAmount?.toString() || '0') / Math.max(n, 1);
        }, 0) / qtdReservas
      : 0;

    const occupied = new Set();
    for (const b of bookings) {
      const cur = new Date(b.checkIn);
      while (cur < new Date(b.checkOut)) {
        if (cur >= start && cur <= end) occupied.add(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
      }
    }
    const taxaOcupacao = (occupied.size / totalDias) * 100;
    const ticketMedio = qtdReservas > 0 ? faturamentoTotal / qtdReservas : 0;

    const sourceMap = {};
    const LABELS = { DIRECT: 'Direto', AIRBNB: 'Airbnb', BOOKING_COM: 'Booking.com' };
    for (const b of bookings) {
      const src = b.source || 'DIRECT';
      if (!sourceMap[src]) sourceMap[src] = { total: 0, qtd: 0 };
      sourceMap[src].total += parseFloat(b.totalAmount?.toString() || '0');
      sourceMap[src].qtd += 1;
    }
    const porOrigem = Object.entries(sourceMap).map(([origem, data]) => ({
      origem: LABELS[origem] || origem,
      total: data.total,
      qtd: data.qtd,
    }));

    const porMes = [];
    for (let i = 5; i >= 0; i--) {
      const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const mBookings = await prisma.booking.findMany({
        where: { status: { in: ['CONFIRMED'] }, checkIn: { gte: ms, lte: me } },
        select: { totalAmount: true },
      });
      const total = mBookings.reduce((s, b) => s + parseFloat(b.totalAmount?.toString() || '0'), 0);
      porMes.push({ mes: ms.toLocaleDateString('pt-BR', { month: 'short' }), total });
    }

    res.json({
      periodo: start.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }),
      faturamentoTotal,
      variacaoPct: null,
      qtdReservas,
      diariamedia,
      taxaOcupacao,
      ticketMedio,
      porOrigem,
      porMes,
    });
  } catch (err) {
    console.error('[staff-portal] financeiro error:', err);
    res.status(500).json({ error: 'Erro ao buscar dados financeiros' });
  }
});

// ── GET /api/staff/casa/proximas ─────────────────────────────────────────────
router.get('/casa/proximas', async (req, res) => {
  try {
    const start = new Date();
    const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: { status: { in: ['CONFIRMED', 'PENDING'] }, checkIn: { gte: start, lte: end } },
      orderBy: { checkIn: 'asc' },
      include: {
        user: { select: { name: true } },
        inspections: { where: { type: 'PRE_CHECKIN' }, select: { id: true, status: true } },
      },
    });

    res.json(bookings.map((b) => ({
      bookingId: b.id,
      guestName: b.user?.name || b.guestName || 'Hóspede',
      checkIn: b.checkIn.toISOString(),
      checkOut: b.checkOut.toISOString(),
      guests: b.guestCount,
      inspectionId: b.inspections?.[0]?.id || null,
      inspectionStatus: b.inspections?.[0]?.status || null,
    })));
  } catch (err) {
    console.error('[staff-portal] casa/proximas error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas entradas' });
  }
});

// ── GET /api/staff/casa/calendario ──────────────────────────────────────────
router.get('/casa/calendario', async (req, res) => {
  try {
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: {
        status: { in: ['CONFIRMED', 'PENDING'] },
        checkIn: { gte: past },
        checkOut: { lte: future },
      },
      orderBy: { checkIn: 'asc' },
      include: {
        user: { select: { name: true } },
        inspections: { select: { id: true, type: true } },
      },
    });

    res.json(bookings.map((b) => {
      const pre = b.inspections?.find((i) => i.type === 'PRE_CHECKIN');
      const chk = b.inspections?.find((i) => i.type === 'CHECKOUT');
      return {
        id: b.id,
        guestName: b.user?.name || b.guestName || 'Hóspede',
        checkIn: b.checkIn.toISOString(),
        checkOut: b.checkOut.toISOString(),
        guests: b.guestCount,
        status: b.status,
        inspectionPreCheckin: pre?.id || null,
        inspectionCheckout: chk?.id || null,
      };
    }));
  } catch (err) {
    console.error('[staff-portal] casa/calendario error:', err);
    res.status(500).json({ error: 'Erro ao buscar calendário' });
  }
});

// ── POST /api/staff/vistorias ────────────────────────────────────────────────
router.post('/vistorias', async (req, res) => {
  const schema = z.object({
    bookingId: z.string(),
    tipo: z.enum(['PRE_CHECKIN', 'CHECKOUT']),
    checklist: z.array(z.object({
      label: z.string(),
      status: z.enum(['OK', 'PENDENTE', 'PROBLEMA', 'NAO_VERIFICADO']),
      observacao: z.string(),
    })),
    photos: z.array(z.object({ publicId: z.string(), url: z.string() })).optional().default([]),
    observacaoGeral: z.string().optional().default(''),
    assinaturaDataUrl: z.string().nullable().optional(),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { bookingId, tipo, checklist, photos, observacaoGeral, assinaturaDataUrl, timestamp } = parsed.data;

  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const existing = await prisma.inspectionReport.findFirst({
      where: { bookingId, type: tipo },
    });
    if (existing) return res.status(409).json({ error: 'Vistoria já registrada para esta reserva' });

    // property is required — find the active one
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa configurada' });

    const report = await prisma.inspectionReport.create({
      data: {
        bookingId,
        propertyId: property.id,
        staffId: req.staff.id,
        type: tipo,
        status: 'SUBMITTED',
        signatureDataUrl: assinaturaDataUrl || null,
        submittedAt: new Date(timestamp),
        notes: observacaoGeral || null,
        items: {
          create: checklist.map((item) => ({
            category: 'Checklist',
            description: item.label,
            // PENDENTE from form → NAO_VERIFICADO in DB
            status: item.status === 'PENDENTE' ? 'NAO_VERIFICADO' : item.status,
            problemDescription: item.observacao || null,
          })),
        },
        photos: {
          create: photos.map((p) => ({
            cloudinaryPublicId: p.publicId,
            cloudinaryUrl: p.url,
          })),
        },
      },
    });

    res.json({ id: report.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] vistorias POST error:', err);
    res.status(500).json({ error: 'Erro ao salvar vistoria' });
  }
});

// ── GET /api/staff/vistorias/:id ─────────────────────────────────────────────
router.get('/vistorias/:id', async (req, res) => {
  try {
    const report = await prisma.inspectionReport.findUnique({
      where: { id: req.params.id },
      include: {
        staff: { select: { name: true } },
        booking: { include: { user: { select: { name: true } } } },
        items: true,
        photos: true,
      },
    });
    if (!report) return res.status(404).json({ error: 'Vistoria não encontrada' });

    res.json({
      id: report.id,
      tipo: report.type,
      status: report.status,
      submittedAt: report.submittedAt?.toISOString() || report.createdAt.toISOString(),
      staffName: report.staff?.name || 'Equipe',
      guestName: report.booking?.user?.name || report.booking?.guestName || 'Hóspede',
      observacaoGeral: report.notes || '',
      checklist: report.items.map((i) => ({
        label: i.description,
        status: i.status === 'NAO_VERIFICADO' ? 'PENDENTE' : i.status,
        observacao: i.problemDescription || '',
      })),
      photos: report.photos.map((p) => ({ url: p.cloudinaryUrl })),
    });
  } catch (err) {
    console.error('[staff-portal] vistorias/:id error:', err);
    res.status(500).json({ error: 'Erro ao buscar vistoria' });
  }
});

// ── GET /api/staff/piscina/proximas ──────────────────────────────────────────
router.get('/piscina/proximas', async (req, res) => {
  try {
    const start = new Date();
    const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: { status: { in: ['CONFIRMED', 'PENDING'] }, checkIn: { gte: start, lte: end } },
      orderBy: { checkIn: 'asc' },
      include: {
        user: { select: { name: true } },
        maintenanceLogs: {
          where: { logType: 'PRE_CHECKIN' },
          select: { id: true },
          take: 1,
        },
      },
    });

    res.json(bookings.map((b) => ({
      bookingId: b.id,
      guestName: b.user?.name || b.guestName || 'Hóspede',
      checkIn: b.checkIn.toISOString(),
      guests: b.guestCount,
      logId: b.maintenanceLogs?.[0]?.id || null,
    })));
  } catch (err) {
    console.error('[staff-portal] piscina/proximas error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas visitas' });
  }
});

// ── POST /api/staff/piscina/manutencao ──────────────────────────────────────
router.post('/piscina/manutencao', async (req, res) => {
  const schema = z.object({
    bookingId: z.string().optional(),
    checklist: z.array(z.object({
      label: z.string(),
      value: z.string(),
      ok: z.boolean().nullable(),
    })),
    observacoes: z.string().optional().default(''),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { bookingId, checklist, observacoes, timestamp } = parsed.data;

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    // Derive boolean fields from checklist for backward compatibility
    const getOk = (id) => checklist.find((i) => i.label.toLowerCase().includes(id))?.ok ?? false;

    const log = await prisma.maintenanceLog.create({
      data: {
        propertyId: property.id,
        staffId: req.staff.id,
        bookingId: bookingId || null,
        logType: bookingId ? 'PRE_CHECKIN' : 'ROUTINE',
        visitDate: new Date(timestamp),
        vacuumed: getOk('fundo') || getOk('aspira'),
        borderCleaned: getOk('parede') || getOk('borda'),
        filterCleaned: getOk('filtro') || getOk('skimmer'),
        waterTreated: getOk('quim') || getOk('trat'),
        checklistJson: checklist,
        notes: observacoes || null,
      },
    });

    res.json({ id: log.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] piscina/manutencao error:', err);
    res.status(500).json({ error: 'Erro ao salvar manutenção' });
  }
});

// ── POST /api/staff/chamados ─────────────────────────────────────────────────
router.post('/chamados', async (req, res) => {
  const schema = z.object({
    titulo: z.string().min(5),
    descricao: z.string().min(10),
    prioridade: z.enum(['BAIXA', 'NORMAL', 'ALTA', 'URGENTE']),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { titulo, descricao, prioridade, timestamp } = parsed.data;

  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    const ticket = await prisma.serviceTicket.create({
      data: {
        propertyId: property.id,
        openedById: req.staff.id,
        title: titulo,
        description: descricao,
        priority: prioridade,
        status: 'ABERTO',
        createdAt: new Date(timestamp),
      },
    });

    res.json({ id: ticket.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] chamados error:', err);
    res.status(500).json({ error: 'Erro ao abrir chamado' });
  }
});

module.exports = router;
