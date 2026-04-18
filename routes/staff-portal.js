'use strict';

/**
 * Staff Portal API — endpoints for the "Central da Equipe" Next.js PWA
 * All routes require x-staff-id header (validated against StaffMember.id)
 * Mounted at: /api/staff
 */

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { z }      = require('zod');
const prisma     = require('../lib/db');
const { maybeCompleteOtaTask } = require('../lib/tasks');
const { sendPorteiroMessage }  = require('../lib/ghl-webhook');
const { sendPushToRole, sendPushToStaff } = require('../lib/push');
const { requireStaff, requireRole } = require('../lib/staff-auth-middleware');
const { toE164 } = require('../lib/phone');
const ghlClient  = require('../lib/ghl-client');

const router = express.Router();

// ── Rate limiting ─────────────────────────────────────────────────────────────
// 120 requests/min per authenticated staff member.
// requireStaff runs before this limiter so req.staff.id is always set.
// 'anon' is a shared bucket for any hypothetical unauthenticated call (blocked by requireStaff anyway).
const portalLimiter = rateLimit({
  windowMs:      60 * 1000,
  max:           120,
  keyGenerator:  (req) => req.staff?.id ?? 'anon',
  standardHeaders: true,
  legacyHeaders:   false,
  message:       { error: 'Muitas requisições. Aguarde um momento.' },
});

// Returns true if the staff member belongs to the given property (ADMINs always pass)
async function hasPropertyAccess(staffId, staffRole, propertyId) {
  if (staffRole === 'ADMIN') return true;
  const membership = await prisma.staffPropertyAssignment.findFirst({
    where: { staffId, propertyId },
  });
  return membership !== null;
}

router.use(requireStaff);
router.use(portalLimiter);

// GET /api/staff/me — returns full staff profile (used by WebAuthn + token exchange)
router.get('/me', async (req, res) => {
  try {
    const staff = await prisma.staffMember.findUnique({
      where:  { id: req.staff.id },
      select: {
        id: true, name: true, email: true, phone: true,
        role: true, fontSizePreference: true, firstLoginDone: true,
        properties: { select: { property: { select: { id: true, name: true, slug: true } } } },
      },
    });
    if (!staff) return res.status(404).json({ error: 'Não encontrado' });
    res.json({
      id:                 staff.id,
      name:               staff.name,
      email:              staff.email,
      phone:              staff.phone,
      role:               staff.role,
      fontSizePreference: staff.fontSizePreference,
      firstLoginDone:     staff.firstLoginDone,
      properties:         staff.properties.map(p => p.property),
    });
  } catch (err) {
    console.error('[staff-portal] GET /me error:', err);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

// ── PATCH /api/staff/me — update own name / email / phone ────────────────────
router.patch('/me', async (req, res) => {
  const schema = z.object({
    name:  z.string().min(2).max(100).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(8).max(20).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { name, email, phone } = parsed.data;
  if (!name && !email && !phone) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

  try {
    // Check uniqueness for email/phone
    if (email) {
      const existing = await prisma.staffMember.findUnique({ where: { email } });
      if (existing && existing.id !== req.staff.id) {
        return res.status(409).json({ error: 'Este e-mail já está em uso' });
      }
    }
    if (phone) {
      const normalizedPhone = toE164(phone);
      const existing = await prisma.staffMember.findUnique({ where: { phone: normalizedPhone } });
      if (existing && existing.id !== req.staff.id) {
        return res.status(409).json({ error: 'Este telefone já está em uso' });
      }
    }

    const normalizedPhone = phone ? toE164(phone) : undefined;

    const updated = await prisma.staffMember.update({
      where: { id: req.staff.id },
      data: {
        ...(name              && { name }),
        ...(email             && { email }),
        ...(normalizedPhone   && { phone: normalizedPhone }),
      },
      select: { id: true, name: true, email: true, phone: true, role: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('[staff-portal] PATCH /me error:', err);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

// Helper: serialize booking for front-end consumption
function serializeBooking(b) {
  const sourceMap = { BOOKING_COM: 'BOOKING', AIRBNB: 'AIRBNB', DIRECT: 'DIRECT' };
  const net   = parseFloat(b.totalAmount?.toString() || '0');
  const gross = b.grossAmount      ? parseFloat(b.grossAmount.toString())      : null;
  const comm  = b.commissionAmount ? parseFloat(b.commissionAmount.toString()) : null;
  const upsellTotal = (b.upsells || []).reduce((s, u) => s + parseFloat(u.amount.toString()), 0);
  return {
    id: b.id,
    guestName: b.user?.name || b.guestName || 'Hóspede',
    guestEmail: b.guestEmail || null,
    guestPhone: b.guestPhone || null,
    checkIn: b.checkIn.toISOString(),
    checkOut: b.checkOut.toISOString(),
    nights: b.nights || 0,
    guests: b.guestCount,
    totalPrice: net,
    grossAmount: gross,
    commissionAmount: comm,
    upsellTotal: upsellTotal || null,
    upsells: (b.upsells || []).map(u => ({
      id: u.id,
      description: u.description,
      amount: parseFloat(u.amount.toString()),
      receivedAt: u.receivedAt?.toISOString() || null,
      notes: u.notes || null,
    })),
    status: b.status,
    source: sourceMap[b.source] || 'DIRECT',
    notes: b.notes || null,
    hasPet: b.hasPet || false,
    petDescription: b.petDescription || null,
    childrenUnder3: b.childrenUnder3 ?? 0,
    children3to5:   b.children3to5   ?? 0,
    childrenOver6:  b.childrenOver6  ?? 0,
    childrenFee:    b.childrenFee != null ? Number(b.childrenFee) : 0,
    appFee:         b.appFee != null ? Number(b.appFee) : 0,
    isInvoiceAggregate: b.isInvoiceAggregate || false,
    otaTaskId: b.otaTaskId || null,
    createdAt: b.createdAt?.toISOString() || null,
  };
}

// ── GET /api/staff/reservas ─────────────────────────────────────────────────
router.get('/reservas', requireRole('ADMIN'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip  = (page - 1) * limit;

    const [bookings, total] = await Promise.all([
      prisma.booking.findMany({
        orderBy: { checkIn: 'desc' },
        skip,
        take: limit,
        include: { user: { select: { name: true } }, upsells: true },
      }),
      prisma.booking.count(),
    ]);

    res.json({
      bookings: bookings.map(serializeBooking),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('[staff-portal] reservas error:', err);
    res.status(500).json({ error: 'Erro ao buscar reservas' });
  }
});

// ── GET /api/staff/reservas/:id ─────────────────────────────────────────────
router.get('/reservas/:id', requireRole('ADMIN', 'GOVERNANTA'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { name: true } }, upsells: true },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    const data = serializeBooking(booking);
    // Strip PII for non-admin roles (GOVERNANTA needs check-in info but not contact/financial data)
    if (req.staff.role !== 'ADMIN') {
      delete data.guestEmail;
      delete data.guestPhone;
      delete data.totalPrice;
    }
    res.json(data);
  } catch (err) {
    console.error('[staff-portal] reserva/:id error:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva' });
  }
});

// ── PATCH /api/staff/reservas/:id ──────────────────────────────────────────
// Accepts: { source?, status?, notes?, guestName?, guestEmail?, guestPhone?,
//            checkIn?, checkOut?, guestCount?, totalAmount?, hasPet? }
router.patch('/reservas/:id', requireRole('ADMIN'), async (req, res) => {
  const sourceReverseMap = { DIRECT: 'DIRECT', AIRBNB: 'AIRBNB', BOOKING: 'BOOKING_COM' };

  const schema = z.object({
    source:      z.enum(['DIRECT', 'AIRBNB', 'BOOKING']).optional(),
    status:      z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED', 'COMPLETED', 'REQUESTED']).optional(),
    notes:       z.string().optional(),
    guestName:   z.string().min(1).optional(),
    guestEmail:  z.string().email().optional().or(z.literal('')),
    guestPhone:  z.string().optional(),
    checkIn:     z.string().optional(),
    checkOut:    z.string().optional(),
    guestCount:       z.number().int().min(1).optional(),
    totalAmount:      z.number().min(0).optional(),
    appFee:           z.number().min(0).optional(),
    hasPet:           z.boolean().optional(),
    childrenUnder3:   z.number().int().min(0).optional(),
    children3to5:     z.number().int().min(0).optional(),
    childrenOver6:    z.number().int().min(0).optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });

  const { source, status, notes, guestName, guestEmail, guestPhone,
          checkIn, checkOut, guestCount, totalAmount, appFee, hasPet,
          childrenUnder3, children3to5, childrenOver6 } = parsed.data;

  const updates = {};
  if (source      !== undefined) updates.source      = sourceReverseMap[source];
  if (status      !== undefined) updates.status      = status;
  if (notes       !== undefined) updates.notes       = notes;
  if (guestName   !== undefined) updates.guestName   = guestName;
  if (guestEmail  !== undefined) updates.guestEmail  = guestEmail || null;
  if (guestPhone  !== undefined) updates.guestPhone  = guestPhone;
  if (guestCount  !== undefined) updates.guestCount  = guestCount;
  if (totalAmount !== undefined) updates.totalAmount = totalAmount;
  if (appFee      !== undefined) updates.appFee      = appFee;
  if (hasPet           !== undefined) updates.hasPet           = hasPet;
  if (childrenUnder3   !== undefined) updates.childrenUnder3   = childrenUnder3;
  if (children3to5     !== undefined) updates.children3to5     = children3to5;
  if (childrenOver6    !== undefined) updates.childrenOver6    = childrenOver6;

  if (checkIn !== undefined) {
    const d = new Date(checkIn);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'checkIn inválido' });
    updates.checkIn = d;
  }
  if (checkOut !== undefined) {
    const d = new Date(checkOut);
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'checkOut inválido' });
    updates.checkOut = d;
  }
  if (updates.checkIn && updates.checkOut && updates.checkIn >= updates.checkOut) {
    return res.status(400).json({ error: 'Check-out deve ser após check-in' });
  }
  if (updates.checkIn || updates.checkOut) {
    // Recalculate nights
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, select: { checkIn: true, checkOut: true } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    const ci = updates.checkIn  || booking.checkIn;
    const co = updates.checkOut || booking.checkOut;
    updates.nights = Math.round((co - ci) / (1000 * 60 * 60 * 24));
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  // Recompute childrenFee if any children count changed
  if (updates.childrenUnder3 !== undefined || updates.children3to5 !== undefined || updates.childrenOver6 !== undefined) {
    const current = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: {
        nights: true, baseRatePerNight: true,
        childrenUnder3: true, children3to5: true, childrenOver6: true,
        property: { include: { childPricingTiers: true } },
      },
    });
    if (current) {
      const nights = current.nights || 1;
      const c3to5  = updates.children3to5  ?? current.children3to5;
      const cOver6 = updates.childrenOver6 ?? current.childrenOver6;
      const tier3to5  = current.property?.childPricingTiers?.find(t => t.rateType === 'FIXED' && t.ageMin === 3 && t.ageMax === 5);
      const fixedRate = tier3to5?.fixedRate ? Number(tier3to5.fixedRate) : 25;
      const baseRate  = current.baseRatePerNight ? Number(current.baseRatePerNight) : 0;
      updates.childrenFee = (c3to5 * fixedRate * nights) + (cOver6 * baseRate * nights);
    }
  }

  try {
    const booking = await prisma.booking.update({
      where: { id: req.params.id },
      data: updates,
      include: { user: { select: { name: true } }, upsells: true },
    });

    // Fire-and-forget: if guest name was updated and the booking has a phone,
    // try to update the matching GHL contact's name. Errors are logged, never block the response.
    if (guestName !== undefined && booking.guestPhone) {
      ghlClient.findContactByPhone(booking.guestPhone)
        .then(c => c ? ghlClient.updateContact(c.id, { name: guestName }) : null)
        .catch(e => console.error('[staff-portal] PATCH reservas GHL sync error:', e.message));
    }

    res.json(serializeBooking(booking));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Reserva não encontrada' });
    console.error('[staff-portal] PATCH reservas/:id error:', err);
    res.status(500).json({ error: 'Erro ao atualizar reserva' });
  }
});

// ── POST /api/staff/reservas ────────────────────────────────────────────────
router.post('/reservas', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    guestName:   z.string().min(1),
    guestEmail:  z.string().email(),
    guestPhone:  z.string().min(1),
    checkIn:     z.string(),
    checkOut:    z.string(),
    guestCount:  z.number().int().min(1),
    totalAmount: z.number().min(0),
    source:      z.enum(['DIRECT', 'AIRBNB', 'BOOKING']).default('DIRECT'),
    notes:       z.string().optional(),
    hasPet:      z.boolean().default(false),
    propertyId:  z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });

  const { guestName, guestEmail, guestPhone, checkIn, checkOut, guestCount, totalAmount, source, notes, hasPet, propertyId } = parsed.data;
  const sourceMap = { DIRECT: 'DIRECT', AIRBNB: 'AIRBNB', BOOKING: 'BOOKING_COM' };

  const checkInDate  = new Date(checkIn);
  const checkOutDate = new Date(checkOut);
  const nights = Math.round((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));

  if (nights <= 0) return res.status(400).json({ error: 'Check-out deve ser após o check-in' });

  try {
    const booking = await prisma.booking.create({
      data: {
        guestName,
        guestEmail,
        guestPhone,
        checkIn:          checkInDate,
        checkOut:         checkOutDate,
        nights,
        guestCount,
        totalAmount,
        baseRatePerNight: 0,
        extraGuestFee:    0,
        petFee:           0,
        source:           sourceMap[source],
        status:           source === 'DIRECT' ? 'REQUESTED' : 'CONFIRMED',
        notes,
        hasPet,
        propertyId:       propertyId || null,
      },
      include: { user: { select: { name: true } }, upsells: true },
    });
    res.status(201).json(serializeBooking(booking));
  } catch (err) {
    console.error('[staff-portal] POST reservas error:', err);
    res.status(500).json({ error: 'Erro ao criar reserva' });
  }
});

// ── GET /api/staff/financeiro ────────────────────────────────────────────────
// period: 'today' | 'week' | 'month' (default: 'month')
router.get('/financeiro', requireRole('ADMIN'), async (req, res) => {
  try {
    const now = new Date();
    const period = req.query.period || 'month';

    let start, end, periodoLabel;
    if (period === 'today') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      end   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      periodoLabel = 'Hoje';
    } else if (period === 'week') {
      const dow = now.getDay(); // 0=Sun
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow, 0, 0, 0);
      end   = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59);
      periodoLabel = 'Esta Semana';
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      periodoLabel = start.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    }

    // Previous equivalent period for variacaoPct
    const diffMs = end - start;
    const prevStart = new Date(start - diffMs - 86400000);
    const prevEnd   = new Date(start - 86400000);

    // Month boundaries for occupancy (always full month)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const totalDias  = monthEnd.getDate();

    const [bookings, prevBookings, upsells] = await Promise.all([
      prisma.booking.findMany({
        where: { status: 'CONFIRMED', checkIn: { gte: start, lte: end } },
        select: { totalAmount: true, source: true, checkIn: true, checkOut: true, nights: true, isInvoiceAggregate: true },
      }),
      prisma.booking.findMany({
        where: { status: 'CONFIRMED', checkIn: { gte: prevStart, lte: prevEnd } },
        select: { totalAmount: true },
      }),
      // Include upsell revenue in faturamento
      prisma.bookingUpsell.findMany({
        where: { booking: { status: 'CONFIRMED', checkIn: { gte: start, lte: end } } },
        select: { amount: true },
      }),
    ]);

    const upsellRevenue = upsells.reduce((s, u) => s + parseFloat(u.amount.toString()), 0);
    const faturamentoBase = bookings.reduce((s, b) => s + parseFloat(b.totalAmount?.toString() || '0'), 0);
    const faturamentoTotal = faturamentoBase + upsellRevenue;
    const prevTotal = prevBookings.reduce((s, b) => s + parseFloat(b.totalAmount?.toString() || '0'), 0);
    const variacaoPct = prevTotal > 0 ? Math.round((faturamentoBase - prevTotal) / prevTotal * 1000) / 10 : null;

    const realBookings = bookings.filter(b => !b.isInvoiceAggregate);
    const qtdReservas = realBookings.length;
    const diariamedia = qtdReservas > 0
      ? realBookings.reduce((s, b) => s + parseFloat(b.totalAmount?.toString() || '0') / Math.max(b.nights || 1, 1), 0) / qtdReservas
      : 0;
    const ticketMedio = qtdReservas > 0 ? faturamentoTotal / qtdReservas : 0;

    // Occupancy always based on current calendar month
    const monthBookings = period === 'month' ? bookings : await prisma.booking.findMany({
      where: { status: 'CONFIRMED', checkIn: { gte: monthStart, lte: monthEnd } },
      select: { checkIn: true, checkOut: true },
    });
    const occupied = new Set();
    for (const b of monthBookings) {
      const cur = new Date(b.checkIn);
      while (cur < new Date(b.checkOut)) {
        const d = cur.toISOString().split('T')[0];
        if (cur >= monthStart && cur <= monthEnd) occupied.add(d);
        cur.setDate(cur.getDate() + 1);
      }
    }
    const taxaOcupacao = Math.round((occupied.size / totalDias) * 1000) / 10;

    const LABELS = { DIRECT: 'Direto', AIRBNB: 'Airbnb', BOOKING_COM: 'Booking.com' };
    const sourceMap = {};
    for (const b of bookings) {
      const src = b.source || 'DIRECT';
      if (!sourceMap[src]) sourceMap[src] = { total: 0, qtd: 0 };
      sourceMap[src].total += parseFloat(b.totalAmount?.toString() || '0');
      sourceMap[src].qtd += 1;
    }
    const porOrigem = Object.entries(sourceMap).map(([origem, data]) => ({
      origem: LABELS[origem] || origem, total: data.total, qtd: data.qtd,
    }));

    // 6-month history: single batch query then group in-memory
    const histStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const histBookings = await prisma.booking.findMany({
      where: { status: 'CONFIRMED', checkIn: { gte: histStart, lte: monthEnd } },
      select: { totalAmount: true, checkIn: true },
    });
    const monthMap = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthMap[`${d.getFullYear()}-${d.getMonth()}`] = {
        mes: d.toLocaleDateString('pt-BR', { month: 'short' }),
        total: 0,
      };
    }
    for (const b of histBookings) {
      const d = new Date(b.checkIn);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (monthMap[key]) monthMap[key].total += parseFloat(b.totalAmount?.toString() || '0');
    }
    const porMes = Object.values(monthMap);

    res.json({
      periodo: periodoLabel,
      faturamentoTotal,
      upsellRevenue: upsellRevenue || null,
      variacaoPct,
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

// ── GET /api/staff/casa/proximas-saidas ─────────────────────────────────────
// Returns confirmed bookings with checkout within the next N days (default 2)
router.get('/casa/proximas-saidas', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 2;
    const start = new Date();
    const end   = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: { status: { in: ['CONFIRMED', 'PENDING'] }, checkOut: { gte: start, lte: end } },
      orderBy: { checkOut: 'asc' },
      include: {
        user: { select: { name: true } },
        inspections: { where: { type: 'CHECKOUT' }, select: { id: true, status: true } },
      },
    });

    res.json(bookings.map((b) => ({
      bookingId: b.id,
      guestName: b.user?.name || b.guestName || 'Hóspede',
      checkIn:   b.checkIn.toISOString(),
      checkOut:  b.checkOut.toISOString(),
      guests:    b.guestCount,
      inspectionId:     b.inspections?.[0]?.id   || null,
      inspectionStatus: b.inspections?.[0]?.status || null,
    })));
  } catch (err) {
    console.error('[staff-portal] casa/proximas-saidas error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas saídas' });
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
    cabinId: z.string().optional(),
    checklist: z.array(z.object({
      label: z.string(),
      status: z.enum(['OK', 'PENDENTE', 'PROBLEMA', 'NAO_VERIFICADO']),
      observacao: z.string(),
    })),
    photos: z.array(z.object({ publicId: z.string(), url: z.string() })).optional().default([]),
    videoId: z.string().optional(),
    observacaoGeral: z.string().optional().default(''),
    assinaturaDataUrl: z.string().nullable().optional(),
    timestamp: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  const { bookingId, tipo, cabinId, checklist, photos, videoId, observacaoGeral, assinaturaDataUrl, timestamp } = parsed.data;

  try {
    const booking = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const existing = await prisma.inspectionReport.findFirst({
      where: { bookingId, type: tipo },
    });
    if (existing) return res.status(409).json({ error: 'Vistoria já registrada para esta reserva' });

    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa configurada' });

    // Verify staff belongs to this property
    if (!await hasPropertyAccess(req.staff.id, req.staff.role, property.id)) {
      return res.status(403).json({ error: 'Sem acesso a esta propriedade' });
    }

    // Save signature as a file instead of storing base64 in the DB
    let signatureUrl = null;
    if (assinaturaDataUrl) {
      try {
        const PNG_PREFIX = 'data:image/png;base64,';
        if (!assinaturaDataUrl.startsWith(PNG_PREFIX)) throw new Error('Invalid signature format');
        const base64Data = assinaturaDataUrl.slice(PNG_PREFIX.length);
        // Decoded size guard: base64 is ~4/3 raw bytes; 200 KB decoded ≈ 267 KB base64
        if (base64Data.length > 270_000) throw new Error('Signature too large');
        const sigBuffer = Buffer.from(base64Data, 'base64');
        const { saveFile } = require('../lib/storage');
        const sigPath = `signatures/${property.slug}/${bookingId}-${tipo.toLowerCase()}.png`;
        const result = await saveFile(sigBuffer, sigPath);
        signatureUrl = result.url;
      } catch (sigErr) {
        console.error('[staff-portal] signature save error (non-fatal):', sigErr.message);
        // Fall through — report is still saved, signature just won't be stored
      }
    }

    const report = await prisma.inspectionReport.create({
      data: {
        bookingId,
        propertyId: property.id,
        staffId: req.staff.id,
        type: tipo,
        status: 'SUBMITTED',
        signatureDataUrl: null,          // deprecated — no longer storing base64
        signatureUrl: signatureUrl,
        submittedAt: new Date(timestamp),
        notes: observacaoGeral || null,
        items: {
          create: checklist.map((item) => ({
            category: 'Checklist',
            description: item.label,
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
        ...(videoId ? {
          videos: {
            create: [{
              storagePath: videoId,
              storageUrl: `${process.env.UPLOAD_PUBLIC_URL || 'http://localhost:3000'}/uploads/${videoId}`,
            }],
          },
        } : {}),
      },
    });

    // Auto-create ServiceTicket for any PROBLEMA items
    const problemas = checklist.filter(
      (i) => i.status === 'PROBLEMA' && i.observacao?.trim()
    );
    if (problemas.length > 0) {
      try {
        const tipoLabel = tipo === 'PRE_CHECKIN' ? 'Pré Check-in' : 'Checkout';
        await prisma.serviceTicket.create({
          data: {
            propertyId: property.id,
            openedById: req.staff.id,
            title: `Vistoria ${tipoLabel} — ${problemas.length} problema${problemas.length > 1 ? 's' : ''}`,
            description: problemas.map((i) => `• ${i.label}: ${i.observacao}`).join('\n'),
            photoUrls: [],
            priority: 'ALTA',
            status: 'ABERTO',
          },
        });
      } catch (ticketErr) {
        // Non-fatal — vistoria was saved successfully
        console.error('[staff-portal] auto-ticket error (non-fatal):', ticketErr);
      }
    }

    // CHECKOUT — send detailed alert email to admin with AI solutions + guest message draft
    if (tipo === 'CHECKOUT' && problemas.length > 0) {
      try {
        const { sendCheckoutProblemaAlert } = require('../lib/mailer');
        const staffMember = await prisma.staffMember.findUnique({
          where:  { id: req.staff.id },
          select: { name: true },
        });
        await sendCheckoutProblemaAlert({
          booking,
          staffName: staffMember?.name || 'Equipe',
          problemas,
          reportId: report.id,
          propertySlug: property.slug,
        });
      } catch (emailErr) {
        // Non-fatal — vistoria was saved successfully
        console.error('[staff-portal] checkout alert email error (non-fatal):', emailErr.message);
      }
    }

    // Push to ADMIN: inspection submitted
    const tipoLabel   = tipo === 'PRE_CHECKIN' ? 'Pré Check-in' : 'Checkout';
    const checkInDate = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });

    if (problemas.length > 0) {
      // Separate urgent push for issues found
      sendPushToRole('ADMIN', {
        title: `⚠️ ${problemas.length} problema${problemas.length > 1 ? 's' : ''} na vistoria de ${tipoLabel}`,
        body:  `${booking.guestName} · Check-in ${checkInDate} · ${problemas.map(p => p.label).join(', ')}`,
        type:  'INSPECTION_ISSUES',
        data:  { reportId: report.id, bookingId },
      }).catch(e => console.error('[push] inspection issues push failed:', e.message));
    } else {
      sendPushToRole('ADMIN', {
        title: `Vistoria ${tipoLabel} concluída ✓`,
        body:  `${booking.guestName} · Check-in ${checkInDate} · Tudo OK`,
        type:  'INSPECTION_SUBMITTED',
        data:  { reportId: report.id, bookingId },
      }).catch(e => console.error('[push] inspection submitted push failed:', e.message));
    }

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
        videos: true,
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
      signatureUrl: report.signatureUrl || null,
      checklist: report.items.map((i) => ({
        label: i.description,
        status: i.status === 'NAO_VERIFICADO' ? 'PENDENTE' : i.status,
        observacao: i.problemDescription || '',
      })),
      photos: report.photos
        .map((p) => ({ url: p.thumbnailUrl || p.cloudinaryUrl }))
        .filter((p) => p.url),
      video: report.videos[0]
        ? { url: report.videos[0].storageUrl }
        : null,
    });
  } catch (err) {
    console.error('[staff-portal] vistorias/:id error:', err);
    res.status(500).json({ error: 'Erro ao buscar vistoria' });
  }
});

// ── GET /api/staff/vistorias/:id/pdf ─────────────────────────────────────────
router.get('/vistorias/:id/pdf', async (req, res) => {
  try {
    const report = await prisma.inspectionReport.findUnique({
      where: { id: req.params.id },
      include: {
        staff: { select: { name: true } },
        booking: { select: { guestName: true, checkIn: true, checkOut: true } },
        property: { select: { name: true, slug: true } },
        items: true,
        photos: true,
        videos: true,
      },
    });
    if (!report) return res.status(404).json({ error: 'Vistoria não encontrada' });

    // Helper: resolve a storage URL to a Buffer for PDF embedding.
    // Prefers the thumbnail for photos (smaller, sufficient for PDF grid).
    async function resolveBuffer(storageUrl) {
      if (!storageUrl) return null;
      const { UPLOAD_DIR } = require('../lib/storage');
      const publicBase = process.env.UPLOAD_PUBLIC_URL || 'http://localhost:3000';

      if (process.env.STORAGE_PROVIDER === 'r2') {
        try {
          const res2 = await fetch(storageUrl, { signal: AbortSignal.timeout(5000) });
          if (!res2.ok) return null;
          return Buffer.from(await res2.arrayBuffer());
        } catch { return null; }
      }

      // Local storage — derive fs path from URL
      try {
        const relPath = storageUrl.startsWith(publicBase)
          ? storageUrl.slice(publicBase.length).replace(/^\/uploads\//, '')
          : storageUrl.replace(/^\/uploads\//, '');
        const fullPath = require('path').join(UPLOAD_DIR, relPath);
        return await require('fs').promises.readFile(fullPath);
      } catch { return null; }
    }

    // Lazy-load pdfkit to avoid startup cost when not needed
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 45, size: 'A4', autoFirstPage: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vistoria-${report.id.slice(0, 8)}.pdf"`
    );
    doc.pipe(res);

    const tipoLabel = report.type === 'PRE_CHECKIN' ? 'Pré Check-in' : 'Checkout';
    const dateStr = report.submittedAt
      ? new Date(report.submittedAt).toLocaleDateString('pt-BR', { dateStyle: 'full' })
      : new Date(report.createdAt).toLocaleDateString('pt-BR', { dateStyle: 'full' });
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ── Header ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill('#3D2B1A');
    doc.fillColor('white')
      .fontSize(16).font('Helvetica-Bold')
      .text('Relatório de Vistoria', doc.page.margins.left, 18, { width: pageW, align: 'center' });
    doc.fontSize(10).font('Helvetica')
      .text(`${tipoLabel} — ${dateStr}`, doc.page.margins.left, 42, { width: pageW, align: 'center' });
    doc.fillColor('black');
    doc.y = 100;

    // ── Meta ─────────────────────────────────────────────────────────────────
    doc.fontSize(10).font('Helvetica');
    doc.text(`Propriedade: ${report.property?.name || 'Recantos da Serra'}`);
    doc.text(`Responsável: ${report.staff?.name || 'Equipe'}`);
    doc.text(`Hóspede: ${report.booking?.guestName || 'Não informado'}`);
    doc.moveDown(0.5);
    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + pageW, doc.y)
      .strokeColor('#e7e5e4').stroke();
    doc.moveDown(0.5);

    // ── Checklist ────────────────────────────────────────────────────────────
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A').text('Checklist');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('black');

    for (const item of report.items) {
      const isProblema = item.status === 'PROBLEMA';
      const statusLabel = item.status === 'OK' ? '✓ OK'
        : item.status === 'PROBLEMA' ? '⚠ Problema'
        : '– Pendente';
      doc.fillColor(isProblema ? '#b91c1c' : item.status === 'OK' ? '#15803d' : '#78716c');
      doc.text(statusLabel, { continued: true, width: 70 });
      doc.fillColor('black').text(`  ${item.description}`);
      if (item.problemDescription) {
        doc.fillColor('#c45c2e').text(`    ↳ ${item.problemDescription}`).fillColor('black');
      }
    }

    // ── Notes ────────────────────────────────────────────────────────────────
    if (report.notes) {
      doc.moveDown(0.5);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageW, doc.y)
        .strokeColor('#e7e5e4').stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A').text('Observações Gerais');
      doc.font('Helvetica').fontSize(9).fillColor('black').text(report.notes);
    }

    // ── Video note ────────────────────────────────────────────────────────────
    if (report.videos && report.videos.length > 0) {
      doc.moveDown(0.5);
      doc.fontSize(9).font('Helvetica').fillColor('#57534e')
        .text(`🎥  Vídeo anexado ao relatório — acesse pelo aplicativo para visualizar.`)
        .fillColor('black');
    }

    // ── Photos ────────────────────────────────────────────────────────────────
    if (report.photos.length > 0) {
      doc.addPage();
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A')
        .text(`Fotos (${report.photos.length})`);
      doc.moveDown(0.4);
      doc.fillColor('black');

      const cols   = 2;
      const gap    = 10;
      const imgW   = (pageW - gap) / cols;
      const imgH   = Math.round(imgW * 0.70); // ~4:3 aspect
      const marginL = doc.page.margins.left;

      let col = 0;
      let rowY = doc.y;

      for (const photo of report.photos) {
        // Use thumbnail if available (smaller/faster), fall back to original
        const src = photo.thumbnailUrl || photo.cloudinaryUrl;
        const buf = await resolveBuffer(src);

        // Add a new page when row would overflow
        if (rowY + imgH > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          rowY = doc.page.margins.top;
          col  = 0;
        }

        const x = marginL + col * (imgW + gap);
        if (buf) {
          try {
            doc.image(buf, x, rowY, { width: imgW, height: imgH, cover: [imgW, imgH], align: 'center', valign: 'center' });
          } catch {
            // Unsupported format — draw placeholder box
            doc.rect(x, rowY, imgW, imgH).strokeColor('#d6d3d1').lineWidth(1).stroke();
            doc.fontSize(7).fillColor('#a8a29e')
              .text('(imagem indisponível)', x + 5, rowY + imgH / 2 - 5, { width: imgW - 10, align: 'center' })
              .fillColor('black');
          }
        } else {
          doc.rect(x, rowY, imgW, imgH).strokeColor('#d6d3d1').lineWidth(1).stroke();
        }

        col++;
        if (col >= cols) {
          col  = 0;
          rowY += imgH + gap;
        }
      }

      // Advance cursor past last row
      doc.y = rowY + imgH + gap;
    }

    // ── Signature ────────────────────────────────────────────────────────────
    if (report.signatureUrl) {
      doc.moveDown(0.5);
      doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + pageW, doc.y)
        .strokeColor('#e7e5e4').stroke();
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#3D2B1A').text('Assinatura');
      doc.moveDown(0.3);

      const sigBuf = await resolveBuffer(report.signatureUrl);
      if (sigBuf) {
        try {
          doc.image(sigBuf, doc.page.margins.left, doc.y, { height: 60, fit: [200, 60] });
          doc.y += 70;
        } catch {
          doc.fontSize(8).fillColor('#a8a29e').text('(assinatura indisponível)').fillColor('black');
        }
      } else {
        doc.fontSize(8).fillColor('#a8a29e').text('(assinatura indisponível)').fillColor('black');
      }
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveDown(1.5);
    doc.fontSize(7).fillColor('#a8a29e')
      .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · ID ${report.id}`, { align: 'center' });

    doc.end();
  } catch (err) {
    console.error('[staff-portal] vistoria PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar PDF' });
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

    // Verify staff belongs to this property
    if (!await hasPropertyAccess(req.staff.id, req.staff.role, property.id)) {
      return res.status(403).json({ error: 'Sem acesso a esta propriedade' });
    }

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

    // Push to ADMIN: pool maintenance logged
    const logTypeLabel = bookingId ? 'Pré Check-in' : 'Rotina';
    const staffName    = (await prisma.staffMember.findUnique({
      where: { id: req.staff.id }, select: { name: true },
    }))?.name || 'Equipe';
    sendPushToRole('ADMIN', {
      title: `Manutenção da piscina registrada 🏊`,
      body:  `${logTypeLabel} · por ${staffName}${observacoes ? ` · "${observacoes.slice(0, 60)}"` : ''}`,
      type:  'POOL_MAINTENANCE_LOGGED',
      data:  { logId: log.id },
    }).catch(e => console.error('[push] pool maintenance push failed:', e.message));

    res.json({ id: log.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] piscina/manutencao error:', err);
    res.status(500).json({ error: 'Erro ao salvar manutenção' });
  }
});

// ── GET /api/staff/piscina/historico ────────────────────────────────────────
router.get('/piscina/historico', requireRole('ADMIN', 'PISCINEIRO'), async (req, res) => {
  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Nenhuma propriedade ativa' });

    const logs = await prisma.maintenanceLog.findMany({
      where: { propertyId: property.id },
      orderBy: { visitDate: 'desc' },
      take: 60,
      select: {
        id: true,
        logType: true,
        visitDate: true,
        vacuumed: true,
        borderCleaned: true,
        filterCleaned: true,
        waterTreated: true,
        notes: true,
        createdAt: true,
        staff: { select: { id: true, name: true } },
        booking: { select: { id: true, guestName: true } },
      },
    });

    res.json(logs);
  } catch (err) {
    console.error('[staff-portal] piscina/historico error:', err);
    res.status(500).json({ error: 'Erro ao carregar histórico' });
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

    // Push to ADMIN: service ticket opened
    const isUrgente = prioridade === 'URGENTE';
    sendPushToRole('ADMIN', {
      title: isUrgente ? `🚨 Chamado URGENTE aberto` : `Novo chamado aberto`,
      body:  `${titulo} · Prioridade ${prioridade}`,
      type:  isUrgente ? 'SERVICE_TICKET_URGENTE' : 'SERVICE_TICKET_OPENED',
      data:  { ticketId: ticket.id },
    }).catch(e => console.error('[push] service ticket push failed:', e.message));

    res.json({ id: ticket.id, ok: true });
  } catch (err) {
    console.error('[staff-portal] chamados error:', err);
    res.status(500).json({ error: 'Erro ao abrir chamado' });
  }
});

// ── GET /api/staff/chamados ──────────────────────────────────────────────────
// Returns open/in-progress service tickets for the active property.
router.get('/chamados', async (req, res) => {
  try {
    const property = await prisma.property.findFirst({ where: { active: true } });
    if (!property) return res.status(500).json({ error: 'Propriedade não encontrada' });

    const tickets = await prisma.serviceTicket.findMany({
      where: {
        propertyId: property.id,
        status: { in: ['ABERTO', 'EM_ANDAMENTO'] },
      },
      include: {
        openedBy: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
    });
    res.json(tickets);
  } catch (err) {
    console.error('[staff-portal] GET /chamados error:', err);
    res.status(500).json({ error: 'Erro ao buscar chamados' });
  }
});

// ── PATCH /api/staff/chamados/:id ─────────────────────────────────────────────
// Updates ticket status. ADMIN and GOVERNANTA only.
router.patch('/chamados/:id', requireRole('ADMIN', 'GOVERNANTA'), async (req, res) => {
  const { status } = req.body;
  const valid = ['ABERTO', 'EM_ANDAMENTO', 'RESOLVIDO'];
  if (!status || !valid.includes(status)) {
    return res.status(400).json({ error: 'Status inválido' });
  }
  try {
    const ticket = await prisma.serviceTicket.update({
      where: { id: req.params.id },
      data: { status, ...(status === 'RESOLVIDO' && { resolvedAt: new Date() }) },
      include: { openedBy: { select: { id: true, name: true } } },
    });

    // Push to ADMIN when ticket is resolved (if resolved by non-admin GOVERNANTA, alert admin)
    if (status === 'RESOLVIDO') {
      sendPushToRole('ADMIN', {
        title: 'Chamado resolvido ✅',
        body:  `${ticket.title} · resolvido por ${ticket.openedBy?.name || 'Equipe'}`,
        type:  'SERVICE_TICKET_RESOLVED',
        data:  { ticketId: ticket.id },
      }).catch(e => console.error('[push] ticket resolved push failed:', e.message));
    }

    res.json(ticket);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar chamado' });
  }
});

// ── GET /api/staff/chamados/:id/comentarios ───────────────────────────────────
router.get('/chamados/:id/comentarios', async (req, res) => {
  try {
    const ticket = await prisma.serviceTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado' });

    const comments = await prisma.ticketComment.findMany({
      where:   { ticketId: req.params.id },
      orderBy: { createdAt: 'asc' },
      include: { staff: { select: { id: true, name: true } } },
    });
    res.json(comments);
  } catch (err) {
    console.error('[staff-portal] GET chamados comments error:', err);
    res.status(500).json({ error: 'Erro ao buscar comentários' });
  }
});

// ── POST /api/staff/chamados/:id/comentarios ──────────────────────────────────
router.post('/chamados/:id/comentarios', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Comentário não pode estar vazio' });
  if (body.trim().length > 5000) return res.status(400).json({ error: 'Comentário muito longo (máx. 5000 caracteres)' });

  try {
    const ticket = await prisma.serviceTicket.findUnique({ where: { id: req.params.id } });
    if (!ticket) return res.status(404).json({ error: 'Chamado não encontrado' });

    const comment = await prisma.ticketComment.create({
      data: { ticketId: req.params.id, staffId: req.staff.id, body: body.trim() },
      include: { staff: { select: { id: true, name: true } } },
    });

    // Notify ticket opener if comment is from someone else
    if (ticket.openedById !== req.staff.id) {
      sendPushToStaff(ticket.openedById, {
        title: 'Novo comentário no chamado',
        body:  body.length > 60 ? body.slice(0, 60) + '…' : body,
        type:  'TICKET_COMMENT',
        data:  { ticketId: req.params.id },
      }).catch(() => {});
    }

    res.status(201).json(comment);
  } catch (err) {
    console.error('[staff-portal] POST chamados comments error:', err);
    res.status(500).json({ error: 'Erro ao adicionar comentário' });
  }
});

// ── GET /api/staff/tarefas ───────────────────────────────────────────────────
// Returns tasks assigned to the requesting staff member.
router.get('/tarefas', async (req, res) => {
  try {
    const tasks = await prisma.staffTask.findMany({
      where: { assignedToId: req.staff.id },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
    });
    res.json(tasks);
  } catch (err) {
    console.error('[staff-portal] GET /tarefas error:', err);
    res.status(500).json({ error: 'Erro ao buscar tarefas' });
  }
});

// ── PATCH /api/staff/tarefas/:id ─────────────────────────────────────────────
// Staff-scoped toggle: only the assigned staff member can update status.
router.patch('/tarefas/:id', async (req, res) => {
  const schema = z.object({ status: z.enum(['PENDENTE', 'FEITO']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Status inválido' });

  try {
    const task = await prisma.staffTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: 'Tarefa não encontrada' });
    if (task.assignedToId !== req.staff.id) return res.status(403).json({ error: 'Sem permissão' });

    const updated = await prisma.staffTask.update({
      where: { id: req.params.id },
      data: {
        status:      parsed.data.status,
        completedAt: parsed.data.status === 'FEITO' ? new Date() : null,
      },
    });

    // Push to ADMIN when staff marks task done
    if (parsed.data.status === 'FEITO') {
      const staffMember = await prisma.staffMember.findUnique({
        where: { id: req.staff.id }, select: { name: true },
      });
      sendPushToRole('ADMIN', {
        title: 'Tarefa concluída ✅',
        body:  `${updated.title} — concluída por ${staffMember?.name || 'Equipe'}`,
        type:  'TASK_COMPLETED',
        data:  { taskId: updated.id },
      }).catch(e => console.error('[push] task completed push failed:', e.message));
    }

    res.json(updated);
  } catch (err) {
    console.error('[staff-portal] PATCH /tarefas/:id error:', err);
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

// ── Guest Messages ────────────────────────────────────────────────────────────

// GET /api/staff/reservas/:id/mensagens — all messages for a booking (all roles)
router.get('/reservas/:id/mensagens', async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const messages = await prisma.guestMessage.findMany({
      where: { bookingId: req.params.id },
      include: { staff: { select: { id: true, name: true } } },
      orderBy: { sentAt: 'asc' },
    });
    res.json(messages);
  } catch (err) {
    console.error('[staff-portal] GET /reservas/:id/mensagens error:', err);
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

// POST /api/staff/reservas/:id/mensagens — send a message (ADMIN + GOVERNANTA only)
router.post('/reservas/:id/mensagens', requireRole('ADMIN', 'GOVERNANTA'), async (req, res) => {
  try {
    const { body, channel = 'MANUAL', direction = 'OUTBOUND' } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Mensagem não pode ser vazia' });

    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: { id: true, guestName: true, guestPhone: true },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const message = await prisma.guestMessage.create({
      data: {
        bookingId: req.params.id,
        staffId: req.staff.id,
        direction,
        channel,
        body: body.trim(),
      },
      include: { staff: { select: { id: true, name: true } } },
    });

    // TODO: wire GHL webhook when phone number and integration are configured
    // if (channel === 'WHATSAPP' && process.env.GHL_WEBHOOK_URL && booking.guestPhone) {
    //   await fetch(process.env.GHL_WEBHOOK_URL, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify({
    //       bookingId: booking.id,
    //       guestPhone: booking.guestPhone,
    //       message: body.trim(),
    //       staffName: req.staff.name,
    //     }),
    //   }).catch(err => console.error('[GHL webhook] error:', err));
    // }

    res.status(201).json(message);
  } catch (err) {
    console.error('[staff-portal] POST /reservas/:id/mensagens error:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// ── PATCH /api/staff/reservas/:id/dados ─────────────────────────────────────
// Completes missing OTA booking data. Auto-completes the linked StaffTask when
// required fields (guestPhone + guestCount) are present.
router.patch('/reservas/:id/dados', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    guestName:        z.string().min(1).optional(),
    guestEmail:       z.string().email().optional(),
    guestPhone:       z.string().min(1).optional(),
    guestCpf:         z.string().optional(),
    guestCount:       z.number().int().min(1).optional(),
    hasPet:           z.boolean().optional(),
    totalAmount:      z.number().min(0).optional(),
    grossAmount:      z.number().min(0).optional(),
    commissionAmount: z.number().min(0).optional(),
    notes:            z.string().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });

  const updates = {};
  for (const [key, val] of Object.entries(parsed.data)) {
    if (val !== undefined) updates[key] = val;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }
  // Decimal fields must be cast to string for Prisma
  if (updates.totalAmount      !== undefined) updates.totalAmount      = updates.totalAmount.toString();
  if (updates.grossAmount      !== undefined) updates.grossAmount      = updates.grossAmount.toString();
  if (updates.commissionAmount !== undefined) updates.commissionAmount = updates.commissionAmount.toString();

  try {
    const booking = await prisma.booking.update({
      where: { id: req.params.id },
      data:  updates,
      include: { user: { select: { name: true } }, upsells: true },
    });

    // Auto-complete OTA task if required fields are now filled
    await maybeCompleteOtaTask(req.params.id);

    res.json(serializeBooking(booking));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Reserva não encontrada' });
    console.error('[staff-portal] PATCH reservas/:id/dados error:', err);
    res.status(500).json({ error: 'Erro ao atualizar dados da reserva' });
  }
});

// ── POST /api/staff/reservas/:id/upsells ─────────────────────────────────────
router.post('/reservas/:id/upsells', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    description: z.string().min(1),
    amount:      z.number().min(0),
    receivedAt:  z.string().optional(),
    notes:       z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });

  try {
    // Verify booking exists
    const exists = await prisma.booking.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!exists) return res.status(404).json({ error: 'Reserva não encontrada' });

    const upsell = await prisma.bookingUpsell.create({
      data: {
        bookingId:   req.params.id,
        description: parsed.data.description,
        amount:      parsed.data.amount.toString(),
        receivedAt:  parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : null,
        notes:       parsed.data.notes || null,
      },
    });
    res.status(201).json({
      id:          upsell.id,
      description: upsell.description,
      amount:      parseFloat(upsell.amount.toString()),
      receivedAt:  upsell.receivedAt?.toISOString() || null,
      notes:       upsell.notes || null,
    });
  } catch (err) {
    console.error('[staff-portal] POST upsells error:', err);
    res.status(500).json({ error: 'Erro ao adicionar upsell' });
  }
});

// ── DELETE /api/staff/reservas/:id/upsells/:uid ───────────────────────────────
router.delete('/reservas/:id/upsells/:uid', requireRole('ADMIN'), async (req, res) => {
  try {
    await prisma.bookingUpsell.delete({ where: { id: req.params.uid } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Upsell não encontrado' });
    console.error('[staff-portal] DELETE upsell error:', err);
    res.status(500).json({ error: 'Erro ao remover upsell' });
  }
});

// ── GET /api/staff/reservas/:id/custos ────────────────────────────────────────
// Returns per-booking cost breakdown: commission, cleaning, fixed costs.
// These are computed on demand so they always reflect current expense data.
router.get('/reservas/:id/custos', requireRole('ADMIN'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, source: true, totalAmount: true, commissionAmount: true,
        grossAmount: true, checkIn: true, checkOut: true, nights: true,
        isInvoiceAggregate: true, propertyId: true,
      },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const PLATFORM_FEES = { AIRBNB: 0.035, BOOKING_COM: 0.13, DIRECT: 0 };
    const feeRate = PLATFORM_FEES[booking.source] ?? 0;
    const net = parseFloat(booking.totalAmount?.toString() || '0');

    // Commission: use stored value or estimate
    const taxaPlataforma = booking.commissionAmount
      ? parseFloat(booking.commissionAmount.toString())
      : (feeRate > 0 ? Math.round(net * feeRate / (1 - feeRate) * 100) / 100 : 0);
    const commissionSource = booking.commissionAmount ? 'REAL' : (feeRate > 0 ? 'ESTIMADO' : 'N/A');

    // Cleaning: look for SERVICOS_LIMPEZA expense near checkOut
    const checkOut = new Date(booking.checkOut);
    const cleaningWindow = {
      gte: new Date(checkOut.getTime() - 86400000),
      lte: new Date(checkOut.getTime() + 4 * 86400000),
    };
    const cleaningExpense = await prisma.expense.findFirst({
      where: { propertyId: booking.propertyId, category: 'SERVICOS_LIMPEZA', date: cleaningWindow },
      orderBy: { date: 'asc' },
      select: { amount: true, date: true, payee: true },
    });

    let custoLimpeza, limpezaSource;
    if (cleaningExpense) {
      custoLimpeza = parseFloat(cleaningExpense.amount.toString());
      limpezaSource = 'REAL';
    } else {
      // Average cleaning cost from recent history
      const cleaningAgg = await prisma.expense.aggregate({
        where: { propertyId: booking.propertyId, category: 'SERVICOS_LIMPEZA' },
        _avg: { amount: true },
      });
      custoLimpeza = cleaningAgg._avg.amount ? parseFloat(cleaningAgg._avg.amount.toString()) : 270;
      limpezaSource = 'ESTIMADO';
    }

    // Fixed costs: ENERGIA, INTERNET, CONDOMINIO, IMPOSTOS for the check-in month
    const checkIn = new Date(booking.checkIn);
    const monthStart = new Date(checkIn.getFullYear(), checkIn.getMonth(), 1);
    const monthEnd   = new Date(checkIn.getFullYear(), checkIn.getMonth() + 1, 0, 23, 59, 59);

    const [fixedAgg, monthBookingCount] = await Promise.all([
      prisma.expense.aggregate({
        where: {
          propertyId: booking.propertyId,
          category: { in: ['ENERGIA_ELETRICA', 'INTERNET', 'CONDOMINIO', 'IMPOSTOS'] },
          date: { gte: monthStart, lte: monthEnd },
        },
        _sum: { amount: true },
      }),
      prisma.booking.count({
        where: {
          propertyId: booking.propertyId,
          status: 'CONFIRMED',
          checkIn: { gte: monthStart, lte: monthEnd },
          isInvoiceAggregate: false,
        },
      }),
    ]);

    const totalFixed = fixedAgg._sum.amount ? parseFloat(fixedAgg._sum.amount.toString()) : 0;
    const custoFixo = monthBookingCount > 0 ? Math.round(totalFixed / monthBookingCount * 100) / 100 : 0;

    const custoTotal = taxaPlataforma + (booking.isInvoiceAggregate ? 0 : custoLimpeza + custoFixo);
    const resultadoLiquido = net - custoTotal;

    res.json({
      net,
      gross: booking.grossAmount ? parseFloat(booking.grossAmount.toString()) : null,
      commission:       taxaPlataforma,
      commissionSource,
      commissionRate:   net > 0 ? Math.round(taxaPlataforma / (net + taxaPlataforma) * 10000) / 100 : 0,
      custoLimpeza:     booking.isInvoiceAggregate ? 0 : custoLimpeza,
      limpezaSource:    booking.isInvoiceAggregate ? 'N/A' : limpezaSource,
      custoFixo:        booking.isInvoiceAggregate ? 0 : custoFixo,
      custoTotal,
      resultadoLiquido,
      margem:           net > 0 ? Math.round(resultadoLiquido / net * 10000) / 100 : 0,
    });
  } catch (err) {
    console.error('[staff-portal] GET /custos error:', err);
    res.status(500).json({ error: 'Erro ao calcular custos' });
  }
});

// ── POST /api/staff/reservas/:id/extrair-lista ────────────────────────────────
// Receives raw pasted text, uses Claude to extract a structured guest list.
// Returns: { guests: [{ name, vehicle?, plate? }], hasPet?: boolean }
router.post('/reservas/:id/extrair-lista', requireRole('ADMIN'), async (req, res) => {
  const { rawText } = req.body;
  if (!rawText?.trim()) return res.status(400).json({ error: 'Texto não pode ser vazio' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'API de IA não configurada' });
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Extraia a lista de hóspedes do texto abaixo. Retorne APENAS um JSON válido (sem markdown) no formato:
{"guests":[{"name":"Nome Completo","vehicle":"Tipo Veículo","plate":"ABC-1234"}],"hasPet":false}

Regras:
- name: nome completo de cada pessoa
- vehicle: tipo do veículo se mencionado (carro, moto, etc), null se não
- plate: placa do veículo no formato brasileiro, null se não mencionado
- hasPet: true se houver menção a pet/animal, false caso contrário
- Inclua todas as pessoas mencionadas, inclusive criança e bebê
- Se um veículo não tiver placa, coloque plate como null

Texto: ${rawText}`,
      }],
    }, { signal: AbortSignal.timeout(30_000) });

    const rawJson = message.content[0].text.trim();
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed.guests)) throw new Error('Formato inválido');

    res.json(parsed);
  } catch (err) {
    console.error('[staff-portal] extrair-lista error:', err.message);
    res.status(500).json({ error: 'Erro ao processar lista com IA' });
  }
});

// ── POST /api/staff/reservas/:id/lista ────────────────────────────────────────
// Saves the confirmed guest list to GuestListEntry records (replaces previous).
router.post('/reservas/:id/lista', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    guests: z.array(z.object({
      name:    z.string().min(1),
      vehicle: z.string().nullable().optional(),
      plate:   z.string().nullable().optional(),
      isMain:  z.boolean().optional(),
    })).min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    // Replace existing entries atomically
    await prisma.$transaction([
      prisma.guestListEntry.deleteMany({ where: { bookingId: req.params.id } }),
      prisma.guestListEntry.createMany({
        data: parsed.data.guests.map((g, i) => ({
          bookingId: req.params.id,
          name:      g.name,
          vehicle:   g.vehicle || null,
          plate:     g.plate   || null,
          isMain:    i === 0,
        })),
      }),
    ]);

    const entries = await prisma.guestListEntry.findMany({
      where:   { bookingId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json(entries);
  } catch (err) {
    console.error('[staff-portal] POST lista error:', err);
    res.status(500).json({ error: 'Erro ao salvar lista' });
  }
});

// ── GET /api/staff/reservas/:id/lista ─────────────────────────────────────────
router.get('/reservas/:id/lista', requireRole('ADMIN', 'GOVERNANTA'), async (req, res) => {
  try {
    const entries = await prisma.guestListEntry.findMany({
      where:   { bookingId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });
    const sentAt = await prisma.booking.findUnique({
      where:  { id: req.params.id },
      select: { porteirSentAt: true },
    });
    res.json({ entries, porteirSentAt: sentAt?.porteirSentAt || null });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar lista' });
  }
});

// ── POST /api/staff/reservas/:id/enviar-porteiro ──────────────────────────────
// Sends the guest list to the porteiro via GHL WhatsApp webhook.
router.post('/reservas/:id/enviar-porteiro', requireRole('ADMIN'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where:   { id: req.params.id },
      include: { property: { select: { porteiroPhone: true } }, user: { select: { name: true } } },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const porteiroPhone = booking.property?.porteiroPhone || process.env.PORTEIRO_DEFAULT_PHONE;
    if (!porteiroPhone) return res.status(400).json({ error: 'Número do porteiro não configurado. Configure em Configurações → Porteiro.' });

    const entries = await prisma.guestListEntry.findMany({
      where:   { bookingId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });
    if (entries.length === 0) return res.status(400).json({ error: 'Lista de hóspedes vazia. Adicione os hóspedes primeiro.' });

    await sendPorteiroMessage(serializeBooking(booking), entries, porteiroPhone);

    await prisma.booking.update({
      where: { id: req.params.id },
      data:  { porteirSentAt: new Date() },
    });

    res.json({ ok: true, sentAt: new Date().toISOString() });
  } catch (err) {
    console.error('[staff-portal] enviar-porteiro error:', err);
    res.status(500).json({ error: 'Erro ao enviar para o porteiro' });
  }
});

// ── POST /reservas/:id/confirmar — admin confirms a REQUESTED booking ──────────
router.post('/reservas/:id/confirmar', requireRole('ADMIN'), async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.status !== 'REQUESTED') {
      return res.status(400).json({ error: `Reserva está em status ${booking.status}, não pode ser confirmada` });
    }
    if (!booking.stripePaymentIntentId) {
      return res.status(400).json({ error: 'Reserva sem PaymentIntent Stripe' });
    }

    const stripe = require('../lib/stripe');

    // Atomic: re-check status + availability + confirm inside one transaction
    let conflictData = null;
    const confirmed = await prisma.$transaction(async tx => {
      // Re-read status inside transaction to guard against concurrent confirms
      const fresh = await tx.booking.findUnique({ where: { id: booking.id } });
      if (!fresh || fresh.status !== 'REQUESTED') {
        throw Object.assign(new Error('Reserva já foi processada'), { statusCode: 400 });
      }

      const blockedCount = await tx.blockedDate.count({
        where: { date: { gte: booking.checkIn, lt: booking.checkOut } },
      });
      if (blockedCount > 0) {
        conflictData = true;
        return null;
      }

      const bookingConflict = await tx.booking.count({
        where: {
          id:       { not: booking.id },
          status:   { in: ['CONFIRMED', 'REQUESTED'] },
          checkIn:  { lt: booking.checkOut },
          checkOut: { gt: booking.checkIn },
        },
      });
      if (bookingConflict > 0) {
        conflictData = true;
        return null;
      }

      // Mark CONFIRMED inside transaction — prevents concurrent double-confirm
      return tx.booking.update({
        where: { id: booking.id },
        data:  { status: 'CONFIRMED' },
      });
    });

    if (conflictData) {
      // Cancel pre-auth and send decline
      await stripe.paymentIntents.cancel(booking.stripePaymentIntentId)
        .catch(e => console.error('[staff] PI cancel on conflict:', e.message));
      const cancelled = await prisma.booking.update({
        where: { id: booking.id },
        data:  { status: 'CANCELLED', adminDeclineNote: 'Datas indisponíveis no momento da confirmação' },
      });
      const { sendBookingDeclined }  = require('../lib/mailer');
      const { notifyBookingDeclined } = require('../lib/ghl-webhook');
      sendBookingDeclined({ booking: cancelled, declineReason: cancelled.adminDeclineNote })
        .catch(e => console.error('[mailer] conflict decline email error:', e.message));
      notifyBookingDeclined(cancelled)
        .catch(e => console.error('[ghl] conflict decline webhook error:', e.message));
      return res.status(409).json({ error: 'Datas ficaram indisponíveis. Reserva cancelada e hóspede notificado.' });
    }

    // Capture Stripe pre-auth — booking is already CONFIRMED in DB
    try {
      await stripe.paymentIntents.capture(booking.stripePaymentIntentId);
    } catch (stripeErr) {
      if (stripeErr.code === 'payment_intent_unexpected_state' && stripeErr.message?.includes('already been captured')) {
        // Idempotent: already captured (double-click) — proceed
        console.warn('[staff] PI already captured, treating as success:', booking.stripePaymentIntentId);
      } else {
        // PI expired or other Stripe error — rollback to REQUESTED, let admin retry or handle manually
        console.error('[staff] Stripe capture failed:', stripeErr.code, stripeErr.message);
        await prisma.booking.update({
          where: { id: booking.id },
          data:  { status: 'REQUESTED' },
        }).catch(e => console.error('[staff] status rollback failed:', e.message));
        return res.status(502).json({
          error: `Falha ao capturar pagamento: ${stripeErr.message}. A reserva voltou ao status Solicitada.`,
        });
      }
    }

    // Fire confirmation messages (non-blocking)
    const {
      sendBookingConfirmation,
      sendCDSBookingConfirmation,
    } = require('../lib/mailer');
    const { notifyBookingConfirmed } = require('../lib/ghl-webhook');
    const { sendPushToUser }         = require('../lib/push');
    const confirmFn = confirmed.propertyId === 'cds_property_main'
      ? sendCDSBookingConfirmation
      : sendBookingConfirmation;
    confirmFn({ booking: confirmed }).catch(e => console.error('[mailer] confirm email error:', e.message));
    notifyBookingConfirmed(confirmed).catch(e => console.error('[ghl] confirm webhook error:', e.message));
    if (confirmed.userId) {
      const checkInDate = confirmed.checkIn.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
      sendPushToUser(confirmed.userId, {
        title: 'Reserva confirmada! 🏡',
        body:  `Sua estadia em ${checkInDate} está confirmada. Prepare-se!`,
        type:  'BOOKING_CONFIRMED_GUEST',
        data:  { bookingId: confirmed.id },
      }).catch(e => console.error('[push] confirm guest push error:', e.message));
    }

    res.json({ ok: true, booking: confirmed });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    console.error('[staff] confirmar error:', err);
    res.status(500).json({ error: err.message || 'Erro ao confirmar reserva' });
  }
});

// ── POST /reservas/:id/recusar — admin declines a REQUESTED booking ───────────
router.post('/reservas/:id/recusar', requireRole('ADMIN'), async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message é obrigatório' });

  try {
    const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.status !== 'REQUESTED') {
      return res.status(400).json({ error: `Reserva está em status ${booking.status}, não pode ser recusada` });
    }
    if (!booking.stripePaymentIntentId) {
      return res.status(400).json({ error: 'Reserva sem PaymentIntent Stripe' });
    }

    const stripe = require('../lib/stripe');

    // Cancel the pre-authorization (no charge)
    try {
      await stripe.paymentIntents.cancel(booking.stripePaymentIntentId);
    } catch (stripeErr) {
      if (stripeErr.code !== 'payment_intent_unexpected_state') throw stripeErr;
      // PI already cancelled — safe to proceed
      console.warn('[staff] PI already cancelled, proceeding with recusar:', booking.stripePaymentIntentId);
    }

    const declined = await prisma.booking.update({
      where: { id: booking.id },
      data:  { status: 'CANCELLED', adminDeclineNote: message.trim() },
    });

    // Fire decline messages (non-blocking)
    const {
      sendBookingDeclined,
      sendCDSBookingDeclined,
    } = require('../lib/mailer');
    const { notifyBookingDeclined } = require('../lib/ghl-webhook');
    const { sendPushToUser }        = require('../lib/push');
    const declineFn = declined.propertyId === 'cds_property_main'
      ? sendCDSBookingDeclined
      : sendBookingDeclined;
    declineFn({ booking: declined, declineReason: message.trim() })
      .catch(e => console.error('[mailer] decline email error:', e.message));
    notifyBookingDeclined(declined)
      .catch(e => console.error('[ghl] decline webhook error:', e.message));
    if (declined.userId) {
      sendPushToUser(declined.userId, {
        title: 'Atualização sobre sua reserva',
        body:  'Infelizmente sua solicitação não pôde ser confirmada. Verifique seu e-mail.',
        type:  'BOOKING_DECLINED_GUEST',
        data:  { bookingId: declined.id },
      }).catch(e => console.error('[push] decline guest push error:', e.message));
    }

    res.json({ ok: true, booking: declined });
  } catch (err) {
    console.error('[staff] recusar error:', err);
    res.status(500).json({ error: err.message || 'Erro ao recusar reserva' });
  }
});

// ── GET /api/staff/push/vapid-key ─────────────────────────────────────────────
// Returns the VAPID public key so the PWA can create a PushSubscription.
router.get('/push/vapid-key', (_req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Push notifications not configured' });
  }
  res.json({ publicKey: key });
});

// ── POST /api/staff/push/subscribe ────────────────────────────────────────────
// Body: { subscription: { endpoint, keys: { p256dh, auth } } }
router.post('/push/subscribe', async (req, res) => {
  try {
    const { subscription } = req.body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    await prisma.staffMember.update({
      where: { id: req.staff.id },
      data:  { pushSubscription: subscription },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[push] subscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar subscription' });
  }
});

// ── DELETE /api/staff/push/subscribe ─────────────────────────────────────────
router.delete('/push/subscribe', async (req, res) => {
  try {
    await prisma.staffMember.update({
      where: { id: req.staff.id },
      data:  { pushSubscription: null },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[push] unsubscribe error:', err.message);
    res.status(500).json({ error: 'Erro ao remover subscription' });
  }
});

// ── GET /api/staff/notificacoes ───────────────────────────────────────────────
router.get('/notificacoes', async (req, res) => {
  try {
    const notifications = await prisma.pushNotification.findMany({
      where: { staffId: req.staff.id },
      orderBy: { sentAt: 'desc' },
      take: 50,
    });
    res.json(notifications);
  } catch (err) {
    console.error('[staff] notificacoes error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar notificações' });
  }
});

// ── PATCH /api/staff/notificacoes/:id/read ────────────────────────────────────
router.patch('/notificacoes/:id/read', async (req, res) => {
  try {
    const notification = await prisma.pushNotification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification) return res.status(404).json({ error: 'Notificação não encontrada' });
    if (notification.staffId !== req.staff.id) return res.status(403).json({ error: 'Acesso negado' });

    const updated = await prisma.pushNotification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json(updated);
  } catch (err) {
    console.error('[staff] notificacoes read error:', err.message);
    res.status(500).json({ error: 'Erro ao marcar notificação' });
  }
});

// ── GET /api/staff/piscina/programacao ───────────────────────────────────────
router.get('/piscina/programacao', requireRole('ADMIN', 'PISCINEIRO'), async (_req, res) => {
  try {
    const schedules = await prisma.maintenanceSchedule.findMany({
      orderBy: { nextDueAt: 'asc' },
    });
    res.json(schedules);
  } catch (err) {
    console.error('[staff] piscina/programacao error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar programação' });
  }
});

// ── Inventário (AmenitiesItem) ────────────────────────────────────────────────

// GET /api/staff/propriedade — active property type + cabin list (for form context)
router.get('/propriedade', async (_req, res) => {
  try {
    const property = await prisma.property.findFirst({
      where:  { active: true },
      select: { id: true, name: true, type: true, cabins: { where: { active: true }, select: { id: true, name: true, slug: true }, orderBy: { name: 'asc' } } },
    });
    if (!property) return res.status(404).json({ error: 'Propriedade não encontrada' });
    res.json(property);
  } catch (err) {
    console.error('[staff-portal] GET /propriedade error:', err);
    res.status(500).json({ error: 'Erro ao buscar propriedade' });
  }
});

router.get('/inventario', async (req, res) => {
  try {
    const property = await prisma.property.findFirst({ where: { active: true }, select: { id: true } });
    if (!property) return res.json([]);
    const items = await prisma.amenitiesItem.findMany({
      where:   { propertyId: property.id },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  } catch (err) {
    console.error('[staff] inventario GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar inventário' });
  }
});

router.post('/inventario', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    category:    z.string().min(1).max(60),
    name:        z.string().min(1).max(100),
    quantity:    z.number().int().min(0).default(1),
    minQuantity: z.number().int().min(0).default(1),
    unit:        z.string().min(1).max(20).default('un'),
    notes:       z.string().max(300).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const property = await prisma.property.findFirst({ where: { active: true }, select: { id: true } });
    if (!property) return res.status(404).json({ error: 'Nenhuma propriedade ativa' });
    const item = await prisma.amenitiesItem.create({
      data: { ...parsed.data, propertyId: property.id },
    });
    res.json(item);
  } catch (err) {
    console.error('[staff] inventario POST error:', err);
    res.status(500).json({ error: 'Erro ao criar item' });
  }
});

router.patch('/inventario/:id', requireRole('ADMIN', 'GOVERNANTA'), async (req, res) => {
  const schema = z.object({
    quantity:     z.number().int().min(0).optional(),
    minQuantity:  z.number().int().min(0).optional(),
    name:         z.string().min(1).max(100).optional(),
    category:     z.string().min(1).max(60).optional(),
    unit:         z.string().min(1).max(20).optional(),
    notes:        z.string().max(300).nullable().optional(),
    lastChecked:  z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const item = await prisma.amenitiesItem.update({
      where: { id: req.params.id },
      data:  {
        ...parsed.data,
        ...(parsed.data.lastChecked ? { lastChecked: new Date(parsed.data.lastChecked) } : {}),
        updatedAt: new Date(),
      },
    });
    res.json(item);
  } catch (err) {
    console.error('[staff] inventario PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar item' });
  }
});

router.delete('/inventario/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    await prisma.amenitiesItem.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[staff] inventario DELETE error:', err);
    res.status(500).json({ error: 'Erro ao deletar item' });
  }
});

// ── Fornecedores ──────────────────────────────────────────────────────────────

router.get('/fornecedores', async (_req, res) => {
  try {
    const items = await prisma.fornecedor.findMany({
      where:   { active: true },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    res.json(items);
  } catch (err) {
    console.error('[staff] fornecedores GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar fornecedores' });
  }
});

router.post('/fornecedores', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    name:     z.string().min(1).max(100),
    category: z.string().min(1).max(60),
    phone:    z.string().max(20).optional(),
    email:    z.string().email().optional().or(z.literal('')),
    notes:    z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const item = await prisma.fornecedor.create({ data: parsed.data });
    res.json(item);
  } catch (err) {
    console.error('[staff] fornecedores POST error:', err);
    res.status(500).json({ error: 'Erro ao criar fornecedor' });
  }
});

router.patch('/fornecedores/:id', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    name:     z.string().min(1).max(100).optional(),
    category: z.string().min(1).max(60).optional(),
    phone:    z.string().max(20).nullable().optional(),
    email:    z.string().email().nullable().optional().or(z.literal('')),
    notes:    z.string().max(500).nullable().optional(),
    active:   z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    const item = await prisma.fornecedor.update({
      where: { id: req.params.id },
      data:  { ...parsed.data, updatedAt: new Date() },
    });
    res.json(item);
  } catch (err) {
    console.error('[staff] fornecedores PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar fornecedor' });
  }
});

router.delete('/fornecedores/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    // Soft-delete
    await prisma.fornecedor.update({ where: { id: req.params.id }, data: { active: false } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[staff] fornecedores DELETE error:', err);
    res.status(500).json({ error: 'Erro ao remover fornecedor' });
  }
});

// ── IA Operações ──────────────────────────────────────────────────────────────
const { runAlertRules } = require('../lib/alert-rules');

// GET /api/staff/ia/alertas — live operational alerts
router.get('/ia/alertas', requireRole('ADMIN'), async (req, res) => {
  try {
    const property = await prisma.property.findFirst({
      where: { active: true },
      select: { id: true },
    });
    if (!property) return res.json({ alertas: [], geradoEm: new Date().toISOString() });

    const propertyId = req.query.propertyId || property.id;
    const alertas    = await runAlertRules(prisma, propertyId);
    res.json({ alertas, geradoEm: new Date().toISOString() });
  } catch (err) {
    console.error('[staff-portal] ia/alertas error:', err);
    res.status(500).json({ error: 'Erro ao gerar alertas' });
  }
});

// ── Briefing helpers ──────────────────────────────────────────────────────────

const BRIEF_MODEL = 'claude-sonnet-4-6';

/**
 * Resolves the propertyId to use for a briefing request.
 * Falls back to the first active property when none is specified.
 */
async function resolveBriefingProperty(queryPropertyId) {
  if (queryPropertyId) {
    const prop = await prisma.property.findUnique({
      where: { id: queryPropertyId },
      select: { id: true, name: true },
    });
    return prop;
  }
  return prisma.property.findFirst({
    where: { active: true },
    select: { id: true, name: true },
  });
}

/**
 * Gathers the full operational + financial + NPS snapshot for a property
 * and calls Claude claude-sonnet-4-6 to produce the daily briefing text.
 * Persists the result to DailyBriefing (upsert by propertyId + date).
 *
 * @returns {{ text: string, cachedAt: string, fromCache: boolean }}
 */
async function generateBriefing(property) {
  const now             = new Date();
  const today           = now.toISOString().split('T')[0]; // 'YYYY-MM-DD'
  const sevenDaysAgo    = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const threeDaysAhead  = new Date(now.getTime() + 3  * 24 * 60 * 60 * 1000);
  const monthStart      = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    recentBookings,
    upcomingBookings,
    openTickets,
    overdueSchedules,
    alertas,
    npsThisMonth,
    revenueThirtyDays,
  ] = await Promise.all([
    prisma.booking.findMany({
      where:  { propertyId: property.id, checkOut: { gte: sevenDaysAgo, lt: now } },
      select: { status: true, guestName: true, nights: true },
    }),
    prisma.booking.findMany({
      where:  { propertyId: property.id, status: 'CONFIRMED', checkIn: { gte: now, lte: threeDaysAhead } },
      select: { guestName: true, checkIn: true, guestCount: true },
    }),
    prisma.serviceTicket.findMany({
      where:  { propertyId: property.id, status: { in: ['ABERTO', 'EM_ANDAMENTO'] } },
      select: { title: true, priority: true, status: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.maintenanceSchedule.findMany({
      where:  { propertyId: property.id, nextDueAt: { lt: now } },
      select: { item: true, nextDueAt: true },
    }),
    runAlertRules(prisma, property.id),
    // NPS: surveys with npsScore this calendar month
    prisma.survey.findMany({
      where: {
        booking: { propertyId: property.id },
        npsScore: { not: null },
        updatedAt: { gte: monthStart },
      },
      select: { npsScore: true, npsClassification: true },
    }),
    // Revenue: sum of confirmed bookings (totalAmount) in last 30 days
    prisma.booking.aggregate({
      where: {
        propertyId: property.id,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        checkIn: { gte: thirtyDaysAgo },
      },
      _sum: { totalAmount: true },
      _count: { id: true },
    }),
  ]);

  const urgent    = alertas.filter(a => a.severity === 'URGENTE');

  // NPS summary
  const npsCount       = npsThisMonth.length;
  const avgNps         = npsCount > 0
    ? Math.round(npsThisMonth.reduce((s, r) => s + (r.npsScore ?? 0), 0) / npsCount)
    : null;
  const promotores     = npsThisMonth.filter(r => r.npsClassification === 'promotor').length;
  const detratores     = npsThisMonth.filter(r => r.npsClassification === 'detrator').length;
  const npsScore       = npsCount >= 5
    ? Math.round(((promotores - detratores) / npsCount) * 100)
    : null;

  // Revenue summary
  const revTotal  = Number(revenueThirtyDays._sum.totalAmount ?? 0);
  const revCount  = revenueThirtyDays._count.id;

  // Build context sections
  const ticketsSection = openTickets.length > 0
    ? `\nChamados abertos (${openTickets.length}):\n${openTickets.slice(0, 5).map(t => `• ${t.title} [${t.priority}]`).join('\n')}`
    : '';
  const overdueSection = overdueSchedules.length > 0
    ? `\nManutenções atrasadas:\n${overdueSchedules.map(s => `• ${s.item} (desde ${s.nextDueAt.toLocaleDateString('pt-BR')})`).join('\n')}`
    : '';
  const upcomingSection = upcomingBookings.length > 0
    ? `\nCheck-ins nos próximos 3 dias:\n${upcomingBookings.map(b => `• ${b.guestName} — ${new Date(b.checkIn).toLocaleDateString('pt-BR')} (${b.guestCount} hóspede${b.guestCount !== 1 ? 's' : ''})`).join('\n')}`
    : '';
  const npsSection = npsCount > 0
    ? `\nNPS do mês: ${npsCount} resposta${npsCount !== 1 ? 's' : ''}` +
      (avgNps !== null ? `, média ${avgNps}/10` : '') +
      (npsScore !== null ? `, score NPS ${npsScore}` : '') +
      ` (${promotores} promotores, ${detratores} detratores)`
    : '\nNPS do mês: sem respostas ainda';
  const revenueSection = revCount > 0
    ? `\nReceita últimos 30 dias: R$${revTotal.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} (${revCount} reserva${revCount !== 1 ? 's' : ''})`
    : '';

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model:      BRIEF_MODEL,
    max_tokens: 900,
    messages:   [{
      role:    'user',
      content: `Você é o sistema de inteligência operacional do ${property.name}, uma pousada rural em Jaboticatubas, MG (Serra do Cipó).

Snapshot operacional — ${now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}:
- Check-outs nos últimos 7 dias: ${recentBookings.length}
- Check-ins nos próximos 3 dias: ${upcomingBookings.length}
- Alertas ativos: ${alertas.length} (${urgent.length} urgentes)
- Chamados abertos: ${openTickets.length}
- Manutenções atrasadas: ${overdueSchedules.length}
${ticketsSection}${overdueSection}${upcomingSection}${npsSection}${revenueSection}

Escreva um briefing operacional diário em português brasileiro. 3 a 4 parágrafos curtos e densos.
Estrutura: (1) situação imediata e check-ins/check-outs, (2) chamados e manutenção, (3) satisfação de hóspedes e financeiro, (4) recomendações práticas para o dia.
Tom: direto, confiante, sem dramatismo. Cite números reais do snapshot. Não invente dados ausentes — mencione "sem dados" quando aplicável.`,
    }],
  });

  const text = response.content[0]?.text || '';

  // Persist to DB (upsert by propertyId + date)
  await prisma.dailyBriefing.upsert({
    where:  { propertyId_date: { propertyId: property.id, date: today } },
    update: { text, model: BRIEF_MODEL },
    create: { id: require('crypto').randomUUID(), propertyId: property.id, date: today, text, model: BRIEF_MODEL },
  });

  return { text, cachedAt: now.toISOString(), fromCache: false };
}

// GET /api/staff/ia/briefing — return today's cached briefing (no regeneration)
router.get('/ia/briefing', requireRole('ADMIN'), async (req, res) => {
  try {
    const property = await resolveBriefingProperty(req.query.propertyId);
    if (!property) return res.status(404).json({ error: 'Nenhuma propriedade ativa' });

    const today = new Date().toISOString().split('T')[0];
    const row   = await prisma.dailyBriefing.findUnique({
      where: { propertyId_date: { propertyId: property.id, date: today } },
    });

    if (!row) return res.json({ text: null, cachedAt: null, fromCache: false });
    return res.json({ text: row.text, cachedAt: row.createdAt.toISOString(), fromCache: true });
  } catch (err) {
    console.error('[staff-portal] GET ia/briefing error:', err);
    res.status(500).json({ error: 'Erro ao buscar briefing' });
  }
});

// POST /api/staff/ia/briefing — generate (or force-regenerate) the daily briefing
router.post('/ia/briefing', requireRole('ADMIN'), async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY não configurada' });
  }

  try {
    const property     = await resolveBriefingProperty(req.query.propertyId);
    if (!property) return res.status(404).json({ error: 'Nenhuma propriedade ativa' });

    const forceRefresh = req.query.refresh === '1';
    const today        = new Date().toISOString().split('T')[0];

    // Return DB cache unless force-refresh
    if (!forceRefresh) {
      const row = await prisma.dailyBriefing.findUnique({
        where: { propertyId_date: { propertyId: property.id, date: today } },
      });
      if (row) {
        return res.json({ text: row.text, cachedAt: row.createdAt.toISOString(), fromCache: true });
      }
    }

    const result = await generateBriefing(property);
    res.json(result);
  } catch (err) {
    console.error('[staff-portal] POST ia/briefing error:', err);
    res.status(500).json({ error: 'Erro ao gerar briefing' });
  }
});

// ── FINANCIAL INTELLIGENCE ───────────────────────────────────────────────────
//
// GET  /api/staff/financeiro/dre      — P&L dashboard (KPIs + historico + canais + despesas)
// GET  /api/staff/financeiro/despesas — list expenses with filters
// POST /api/staff/financeiro/despesas — create manual expense
// GET  /api/staff/financeiro/cds      — CDS investment tracker

/** Build start/end Date from a period string + optional propertyId */
function buildPeriod(period) {
  const now = new Date();
  let start, end;
  switch (period) {
    case 'quarter': // last 3 months
      start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      break;
    case 'semester': // last 6 months
      start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      break;
    case 'year': // this year Jan–now
      start = new Date(now.getFullYear(), 0, 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      break;
    default: // 'month' — current month
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  }
  return { start, end };
}

function buildComparePeriod(period, compare) {
  const { start, end } = buildPeriod(period);
  const diffMs = end - start;
  // same<YYYY> — shift dates to that year (e.g. same2024, same2025)
  const yearMatch = compare.match(/^same(\d{4})$/);
  if (yearMatch) {
    const targetYear = parseInt(yearMatch[1], 10);
    const yearDiff = start.getFullYear() - targetYear;
    return {
      start: new Date(start.getFullYear() - yearDiff, start.getMonth(), start.getDate()),
      end:   new Date(end.getFullYear()   - yearDiff, end.getMonth(),   end.getDate(), 23, 59, 59),
    };
  }
  // default: previous equivalent period
  return { start: new Date(start - diffMs - 86400000), end: new Date(start - 86400000) };
}

async function getKPIs(propertyId, start, end) {
  const [bookings, expenses] = await Promise.all([
    prisma.booking.findMany({
      where: { propertyId, status: 'CONFIRMED', checkIn: { gte: start, lte: end } },
      select: { totalAmount: true, grossAmount: true, commissionAmount: true,
                source: true, nights: true, isInvoiceAggregate: true },
    }),
    prisma.expense.findMany({
      where: { propertyId, date: { gte: start, lte: end } },
      select: { amount: true, category: true },
    }),
  ]);

  // Exclude invoice aggregates from count but keep their revenue in totals
  // (they represent real net payout even without per-stay detail)
  const receita = bookings.reduce((s, b) => s + parseFloat(b.totalAmount || 0), 0);
  const despesas = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const resultado = receita - despesas;
  const margem = receita > 0 ? resultado / receita : 0;
  // Booking count excludes aggregates — they inflate the count without adding insight
  const qtd = bookings.filter(b => !b.isInvoiceAggregate).length;

  // Per-channel: accumulate receita, qtd, and actual commission paid (when known)
  const canais = {
    AIRBNB:      { receita: 0, qtd: 0, commissionTotal: 0 },
    BOOKING_COM: { receita: 0, qtd: 0, commissionTotal: 0 },
    DIRECT:      { receita: 0, qtd: 0, commissionTotal: 0 },
  };
  const FALLBACK_RATES = { AIRBNB: 0.035, BOOKING_COM: 0.13, DIRECT: 0 };
  for (const b of bookings) {
    const src = b.source || 'DIRECT';
    if (!canais[src]) canais[src] = { receita: 0, qtd: 0, commissionTotal: 0 };
    const net = parseFloat(b.totalAmount || 0);
    canais[src].receita += net;
    if (!b.isInvoiceAggregate) canais[src].qtd += 1;
    // Use actual commissionAmount when available; otherwise estimate from net using correct formula:
    // commission = gross × rate, net = gross × (1 − rate) → gross = net / (1 − rate)
    // → commission = net × rate / (1 − rate)
    const rate = FALLBACK_RATES[src] ?? 0;
    const comm = b.commissionAmount
      ? parseFloat(b.commissionAmount)
      : (rate > 0 ? Math.round(net * rate / (1 - rate) * 100) / 100 : 0);
    canais[src].commissionTotal += comm;
  }

  const catMap = {};
  for (const e of expenses) {
    catMap[e.category] = (catMap[e.category] || 0) + parseFloat(e.amount || 0);
  }

  return {
    receita, despesas, resultado, margem,
    reservasCount: qtd,
    ticketMedio: qtd > 0 ? receita / qtd : 0,
    custoPorReserva: qtd > 0 ? despesas / qtd : 0,
    canais,
    despesasCategorias: catMap,
  };
}

/**
 * Generates smart financial observations for the dashboard.
 * All strings in pt-BR. Severity: 'INFO' | 'ALERTA' | 'DESTAQUE'
 *
 * @param {object} current  - getKPIs result for selected period
 * @param {object} previous - getKPIs result for comparison period
 * @param {Array}  historico - 12-month [{mes, receita, despesas, resultado}]
 * @param {object} allTime  - { upsellTotal, upsellCount, totalRevenue, avgNights }
 */
function computeInsights(current, previous, historico, allTime) {
  const insights = [];

  const fmt = v => `R$${Math.round(v).toLocaleString('pt-BR')}`;
  const pct = (v, d) => d > 0 ? `${((v / d) * 100).toFixed(1)}%` : '—';

  // ── 1. Margin health ────────────────────────────────────────────────────────
  if (current.receita > 0) {
    if (current.margem < 0.35) {
      insights.push({
        type:     'MARGEM',
        severity: 'ALERTA',
        titulo:   'Margem líquida abaixo de 35%',
        corpo:    `Margem atual: ${(current.margem * 100).toFixed(1)}%. Despesas de ${fmt(current.despesas)} consumiram ${pct(current.despesas, current.receita)} da receita. Revise categorias com maior peso.`,
      });
    } else if (current.margem >= 0.55) {
      insights.push({
        type:     'MARGEM',
        severity: 'DESTAQUE',
        titulo:   'Margem líquida acima de 55% 🎯',
        corpo:    `Margem de ${(current.margem * 100).toFixed(1)}% — excelente eficiência operacional neste período.`,
      });
    }
  }

  // ── 2. Revenue vs. previous period ─────────────────────────────────────────
  if (previous.receita > 0 && current.receita > 0) {
    const delta = current.receita - previous.receita;
    const deltaPct = (delta / previous.receita) * 100;
    if (deltaPct >= 25) {
      insights.push({
        type:     'RECEITA',
        severity: 'DESTAQUE',
        titulo:   `Receita +${deltaPct.toFixed(0)}% vs. período anterior`,
        corpo:    `${fmt(current.receita)} este período vs. ${fmt(previous.receita)} — crescimento de ${fmt(delta)}.`,
      });
    } else if (deltaPct <= -20) {
      insights.push({
        type:     'RECEITA',
        severity: 'ALERTA',
        titulo:   `Receita ${deltaPct.toFixed(0)}% vs. período anterior`,
        corpo:    `Queda de ${fmt(Math.abs(delta))} em relação ao período comparativo (${fmt(previous.receita)}). Verifique ocupação e sazonalidade.`,
      });
    }
  }

  // ── 3. Channel fee burden ────────────────────────────────────────────────────
  const airbnbReceita  = current.canais.AIRBNB?.receita           || 0;
  const bcomReceita    = current.canais.BOOKING_COM?.receita       || 0;
  const diretaReceita  = current.canais.DIRECT?.receita            || 0;
  // Use actual commissionTotal from getKPIs (real data when available, formula-estimated otherwise)
  const airbnbFeeBurden = Math.round(current.canais.AIRBNB?.commissionTotal     || 0);
  const bcomFeeBurden   = Math.round(current.canais.BOOKING_COM?.commissionTotal || 0);
  const totalFeeBurden  = airbnbFeeBurden + bcomFeeBurden;

  if (totalFeeBurden > 200 && current.receita > 0) {
    const airbnbRate = airbnbReceita > 0 ? ((airbnbFeeBurden / airbnbReceita) * 100).toFixed(1) : '4.6';
    const bcomRate   = bcomReceita   > 0 ? ((bcomFeeBurden   / bcomReceita  ) * 100).toFixed(1) : '13.0';
    insights.push({
      type:     'CANAIS',
      severity: 'INFO',
      titulo:   `${fmt(totalFeeBurden)} pagos em comissões OTA este período`,
      corpo:    `Airbnb: ~${fmt(airbnbFeeBurden)} (≈${airbnbRate}% do líquido) · Booking.com: ~${fmt(bcomFeeBurden)} (≈${bcomRate}%). Reservas diretas (${fmt(diretaReceita)}) não têm este custo.`,
    });
  }

  // ── 4. Booking.com efficiency vs Airbnb ──────────────────────────────────────
  const airbnbQtd = current.canais.AIRBNB?.qtd      || 0;
  const bcomQtd   = current.canais.BOOKING_COM?.qtd  || 0;
  if (airbnbQtd >= 1 && bcomQtd >= 1) {
    const airbnbTicket = airbnbReceita / airbnbQtd;
    const bcomTicket   = bcomReceita   / bcomQtd;
    // Net-of-fee ticket
    const airbnbNetTicket = airbnbTicket * (1 - 0.035 / (1 - 0.035));
    const bcomNetTicket   = bcomTicket   * (1 - 0.13   / (1 - 0.13));
    if (bcomNetTicket < airbnbNetTicket * 0.7) {
      insights.push({
        type:     'CANAIS',
        severity: 'INFO',
        titulo:   'Booking.com com ticket líquido menor que Airbnb',
        corpo:    `Ticket médio líquido: Airbnb ${fmt(airbnbNetTicket)} vs. Booking.com ${fmt(bcomNetTicket)}. Considere priorizar diárias no Airbnb ou negociar comissão menor no Booking.`,
      });
    }
  }

  // ── 5. Upsell opportunity ─────────────────────────────────────────────────────
  if (allTime.totalRevenue > 0 && allTime.upsellTotal > 0) {
    const upsellPct = (allTime.upsellTotal / allTime.totalRevenue) * 100;
    insights.push({
      type:     'UPSELL',
      severity: 'DESTAQUE',
      titulo:   `PIX diretos representam ${upsellPct.toFixed(1)}% da receita total`,
      corpo:    `${allTime.upsellCount} pagamentos add-on somam ${fmt(allTime.upsellTotal)} em cima das reservas OTA. Incentive hóspedes a pagar taxas extras via PIX direto para zerar comissões sobre esses valores.`,
    });
  }

  // ── 6. Expense spike detection ───────────────────────────────────────────────
  const EXPENSE_LABELS = {
    SERVICOS_LIMPEZA:        'Limpeza',
    CARTAO_CREDITO:          'Cartão de crédito',
    ENERGIA_ELETRICA:        'Energia elétrica',
    CONDOMINIO:              'Condomínio',
    MANUTENCAO_PISCINA:      'Manutenção piscina',
    PRODUTOS_LIMPEZA_PISCINA:'Produtos piscina',
    OBRAS_CONSTRUCAO:        'Obras/Construção',
    IMPOSTOS:                'Impostos',
    INTERNET:                'Internet',
    COMPRAS_ONLINE:          'Compras online',
    MATERIAIS_MELHORIAS:     'Materiais/Melhorias',
    JARDINAGEM_PAISAGISMO:   'Jardinagem/Paisagismo',
    MANUTENCAO_SOLAR_BOMBA:  'Solar/Bomba',
    OUTROS:                  'Outros',
    A_CLASSIFICAR:           'A classificar',
  };

  for (const [cat, valor] of Object.entries(current.despesasCategorias)) {
    const prevValor = previous.despesasCategorias[cat] || 0;
    if (prevValor > 0 && valor > prevValor * 1.5 && valor > 300) {
      const label = EXPENSE_LABELS[cat] || cat;
      insights.push({
        type:     'DESPESA',
        severity: 'ALERTA',
        titulo:   `${label} +${((valor/prevValor - 1)*100).toFixed(0)}% vs. período anterior`,
        corpo:    `${fmt(valor)} este período vs. ${fmt(prevValor)} — aumento de ${fmt(valor - prevValor)}. Verifique se há lançamentos duplicados ou custo pontual.`,
      });
    }
  }

  // ── 7. A classificar alert ────────────────────────────────────────────────────
  const aClassificar = current.despesasCategorias['A_CLASSIFICAR'] || 0;
  if (aClassificar > 100) {
    insights.push({
      type:     'DESPESA',
      severity: 'ALERTA',
      titulo:   `${fmt(aClassificar)} sem categoria definida`,
      corpo:    `Despesas marcadas como "A classificar" distorcem os relatórios por categoria. Acesse a lista de despesas e reclassifique esses lançamentos.`,
    });
  }

  // ── 8. Best / worst month from historico ─────────────────────────────────────
  if (historico.length >= 6) {
    const sorted = [...historico].filter(h => h.receita > 0).sort((a, b) => b.resultado - a.resultado);
    if (sorted.length >= 2) {
      const best  = sorted[0];
      const worst = sorted[sorted.length - 1];
      if (best.resultado > 0) {
        insights.push({
          type:     'SAZONALIDADE',
          severity: 'INFO',
          titulo:   `Melhor mês: ${best.label} (resultado ${fmt(best.resultado)})`,
          corpo:    `Pior mês nos últimos 12: ${worst.label} (resultado ${fmt(worst.resultado)}). Sazonalidade de ${((best.resultado / Math.max(worst.resultado, 1)) * 100 - 100).toFixed(0)}% entre pico e baixa.`,
        });
      }
    }
  }

  // Sort: ALERTA first, then DESTAQUE, then INFO
  const order = { ALERTA: 0, DESTAQUE: 1, INFO: 2 };
  return insights.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

router.get('/financeiro/dre', requireRole('ADMIN'), async (req, res) => {
  try {
    const period  = req.query.period  || 'month';
    const compare = req.query.compare || 'previous';

    const prop = await prisma.property.findFirst({
      where: { slug: { not: 'cabanas' }, active: true },
      orderBy: { createdAt: 'asc' }, // ensures 'recanto-dos-ipes' (oldest/primary) is always selected
    });
    if (!prop) return res.status(404).json({ error: 'Propriedade não encontrada' });

    const { start, end }         = buildPeriod(period);
    const { start: cs, end: ce } = buildComparePeriod(period, compare);

    const [current, previous, upsellAgg, totalRevAgg] = await Promise.all([
      getKPIs(prop.id, start, end),
      getKPIs(prop.id, cs, ce),
      // All-time upsell total (PIX add-ons on top of OTA bookings)
      prisma.booking.aggregate({
        where: { propertyId: prop.id, status: 'CONFIRMED', source: 'DIRECT', externalId: { startsWith: 'upsell-' } },
        _sum:   { totalAmount: true },
        _count: true,
      }),
      // All-time total revenue (for upsell % calculation)
      prisma.booking.aggregate({
        where: { propertyId: prop.id, status: 'CONFIRMED' },
        _sum: { totalAmount: true },
      }),
    ]);

    // 12-month historical
    const now = new Date();
    const historico = [];
    for (let i = 11; i >= 0; i--) {
      const ms = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const me = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const [bks, exps] = await Promise.all([
        prisma.booking.aggregate({
          where: { propertyId: prop.id, status: 'CONFIRMED', checkIn: { gte: ms, lte: me } },
          _sum: { totalAmount: true },
        }),
        prisma.expense.aggregate({
          where: { propertyId: prop.id, date: { gte: ms, lte: me } },
          _sum: { amount: true },
        }),
      ]);
      const rec = parseFloat(bks._sum.totalAmount || 0);
      const des = parseFloat(exps._sum.amount || 0);
      historico.push({
        mes:       ms.toISOString().slice(0, 7),
        label:     ms.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
        receita:   rec,
        despesas:  des,
        resultado: rec - des,
      });
    }

    // Despesas por categoria (current period, for chart)
    const despesasCategorias = Object.entries(current.despesasCategorias).map(([cat, valor]) => ({
      categoria: cat,
      valor,
      valorAnterior: previous.despesasCategorias[cat] || 0,
    })).sort((a, b) => b.valor - a.valor);

    const allTime = {
      upsellTotal:   parseFloat(upsellAgg._sum.totalAmount || 0),
      upsellCount:   upsellAgg._count,
      totalRevenue:  parseFloat(totalRevAgg._sum.totalAmount || 0),
    };

    const insights = computeInsights(current, previous, historico, allTime);

    res.json({
      periodo:     { label: period, start: start.toISOString(), end: end.toISOString() },
      comparativo: { label: compare, start: cs.toISOString(), end: ce.toISOString() },
      kpis: {
        receitaBruta:              current.receita,
        receitaBrutaAnterior:      previous.receita,
        despesasTotal:             current.despesas,
        despesasTotalAnterior:     previous.despesas,
        resultadoLiquido:          current.resultado,
        resultadoLiquidoAnterior:  previous.resultado,
        margemLiquida:             current.margem,
        margemLiquidaAnterior:     previous.margem,
        reservasCount:             current.reservasCount,
        custoPorReserva:           current.custoPorReserva,
        ticketMedio:               current.ticketMedio,
      },
      canais: {
        // fee = host commission deducted from our payout (already reflected in totalAmount)
        // guestFeeRate = service fee the OTA charges the guest on top of our listed price
        // Airbnb host fee: avg 3.498% measured across 57 bookings (backfill-airbnb-commission.js)
        // Booking.com host commission: exactly 13.0% across all 14 invoices
        airbnb:  { receita: current.canais.AIRBNB?.receita     || 0, reservas: current.canais.AIRBNB?.qtd     || 0, fee: 0.035, guestFeeRate: 0.14 },
        booking: { receita: current.canais.BOOKING_COM?.receita || 0, reservas: current.canais.BOOKING_COM?.qtd || 0, fee: 0.13,   guestFeeRate: 0.00 },
        direta:  { receita: current.canais.DIRECT?.receita      || 0, reservas: current.canais.DIRECT?.qtd      || 0, fee: 0.00,   guestFeeRate: 0.00 },
      },
      historico,
      despesasCategorias,
      insights,         // smart observations ranked by severity
      allTime,          // used by frontend for upsell % and context-setting
    });
  } catch (err) {
    console.error('[staff-portal] financeiro/dre error:', err);
    res.status(500).json({ error: 'Erro ao calcular DRE' });
  }
});

router.get('/financeiro/despesas', requireRole('ADMIN'), async (req, res) => {
  try {
    const { category, startDate, endDate, propertySlug } = req.query;
    const prop = await prisma.property.findFirst({
      where: propertySlug
        ? { slug: propertySlug }
        : { slug: { not: 'cabanas' }, active: true },
    });
    if (!prop) return res.status(404).json({ error: 'Propriedade não encontrada' });

    const where = { propertyId: prop.id };
    if (category) where.category = category;
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate)   where.date.lte = new Date(endDate);
    }

    const expenses = await prisma.expense.findMany({
      where,
      orderBy: { date: 'desc' },
      take: 200,
    });

    res.json({ expenses });
  } catch (err) {
    console.error('[staff-portal] financeiro/despesas error:', err);
    res.status(500).json({ error: 'Erro ao listar despesas' });
  }
});

router.post('/financeiro/despesas', requireRole('ADMIN'), async (req, res) => {
  try {
    const { propertySlug, date, amount, category, description, payee, notes } = req.body;
    const prop = await prisma.property.findFirst({
      where: propertySlug
        ? { slug: propertySlug }
        : { slug: { not: 'cabanas' }, active: true },
    });
    if (!prop) return res.status(404).json({ error: 'Propriedade não encontrada' });

    const expense = await prisma.expense.create({
      data: {
        propertyId: prop.id,
        date:        new Date(date),
        amount:      parseFloat(amount),
        category:    category || 'A_CLASSIFICAR',
        description: description || '',
        payee:       payee || '',
        source:      'MANUAL',
        notes,
      },
    });

    res.status(201).json({ expense });
  } catch (err) {
    console.error('[staff-portal] financeiro/despesas POST error:', err);
    res.status(500).json({ error: 'Erro ao criar despesa' });
  }
});

// ── PATCH /api/staff/financeiro/despesas/:id ─────────────────────────────────
router.patch('/financeiro/despesas/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const { date, amount, category, description, payee, notes } = req.body;
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Despesa não encontrada' });
    if (existing.source === 'BANK_IMPORT') {
      return res.status(400).json({ error: 'Despesas importadas do banco não podem ser editadas' });
    }

    const expense = await prisma.expense.update({
      where: { id: req.params.id },
      data: {
        ...(date        && { date:        new Date(date) }),
        ...(amount      && { amount:      parseFloat(amount) }),
        ...(category    && { category }),
        ...(description && { description }),
        ...(payee       && { payee }),
        ...(notes !== undefined && { notes: notes || null }),
      },
    });
    res.json({ expense });
  } catch (err) {
    console.error('[staff-portal] financeiro/despesas PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar despesa' });
  }
});

// ── DELETE /api/staff/financeiro/despesas/:id ────────────────────────────────
router.delete('/financeiro/despesas/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Despesa não encontrada' });
    if (existing.source === 'BANK_IMPORT') {
      return res.status(400).json({ error: 'Despesas importadas do banco não podem ser excluídas' });
    }
    await prisma.expense.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[staff-portal] financeiro/despesas DELETE error:', err);
    res.status(500).json({ error: 'Erro ao excluir despesa' });
  }
});

// CDS project phases — stored here until a ProjectPhase table exists
const CDS_PHASES = [
  { name: 'Conceito',      pct: 100 },
  { name: 'Projeto',       pct: 100 },
  { name: 'Detalhamento',  pct: 60  },
  { name: 'Entrega',       pct: 0   },
];

router.get('/financeiro/cds', requireRole('ADMIN'), async (req, res) => {
  try {
    const cds = await prisma.property.findFirst({ where: { slug: 'cabanas' } });
    if (!cds) return res.json({ totalInvestido: 0, pagamentos: [], acumulado: [], phases: CDS_PHASES });

    const pagamentos = await prisma.expense.findMany({
      where: { propertyId: cds.id, category: 'DESIGN_ARQUITETURA' },
      orderBy: { date: 'asc' },
      select: { date: true, amount: true, description: true, payee: true },
    });

    let running = 0;
    const acumulado = pagamentos.map(p => {
      running += parseFloat(p.amount || 0);
      return running;
    });

    res.json({
      totalInvestido: running,
      pagamentos: pagamentos.map((p, i) => ({
        data:      p.date,
        valor:     parseFloat(p.amount),
        descricao: p.description || p.payee,
        acumulado: acumulado[i],
      })),
      acumulado,
      phases: CDS_PHASES,
    });
  } catch (err) {
    console.error('[staff-portal] financeiro/cds error:', err);
    res.status(500).json({ error: 'Erro ao buscar CDS' });
  }
});

// ── GET /api/staff/financeiro/reservas-lucratividade ─────────────────────────
// Returns per-booking cost/profit breakdown for ALL confirmed bookings.
// Cost allocation:
//   - Platform fee: AIRBNB=4.58% (verified from actual CSV payouts), BOOKING_COM=13%, DIRECT=0%
//   - Cleaning: nearest SERVICOS_LIMPEZA expense ±1–4 days around checkout
//   - Fixed costs: (ENERGIA+INTERNET+CONDOMINIO+IMPOSTOS) for check-in month ÷ bookings that month
router.get('/financeiro/reservas-lucratividade', requireRole('ADMIN'), async (req, res) => {
  try {
    const prop = await prisma.property.findFirst({
      where: { slug: { not: 'cabanas' }, active: true },
    });
    if (!prop) return res.status(404).json({ error: 'Propriedade não encontrada' });

    // Airbnb avg 3.498% measured across 57 bookings (backfill-airbnb-commission.js).
    // Booking.com 13.00% exact from all 14 invoices.
    const PLATFORM_FEES = { AIRBNB: 0.035, BOOKING_COM: 0.13, DIRECT: 0 };
    const FIXED_CATS = ['ENERGIA_ELETRICA', 'INTERNET', 'CONDOMINIO', 'IMPOSTOS'];

    const [bookings, cleaningExps] = await Promise.all([
      prisma.booking.findMany({
        where:   { propertyId: prop.id, status: 'CONFIRMED' },
        orderBy: { checkIn: 'desc' },
        select:  { id: true, guestName: true, guestPhone: true, checkIn: true, checkOut: true,
                   nights: true, guestCount: true, source: true, totalAmount: true,
                   grossAmount: true, commissionAmount: true, isInvoiceAggregate: true },
      }),
      prisma.expense.findMany({
        where:   { propertyId: prop.id, category: 'SERVICOS_LIMPEZA' },
        select:  { date: true, amount: true },
        orderBy: { date: 'asc' },
      }),
    ]);

    // Cache monthly fixed costs and booking counts to avoid N+1 queries
    const fixedCache = {};
    const countCache = {};

    async function monthlyFixed(year, month) {
      const k = `${year}-${month}`;
      if (fixedCache[k] !== undefined) return fixedCache[k];
      const s = new Date(year, month - 1, 1);
      const e = new Date(year, month, 0, 23, 59, 59);
      const r = await prisma.expense.aggregate({
        where: { propertyId: prop.id, category: { in: FIXED_CATS }, date: { gte: s, lte: e } },
        _sum:  { amount: true },
      });
      fixedCache[k] = parseFloat(r._sum.amount || 0);
      return fixedCache[k];
    }

    async function monthlyBookings(year, month) {
      const k = `${year}-${month}`;
      if (countCache[k] !== undefined) return countCache[k];
      const s = new Date(year, month - 1, 1);
      const e = new Date(year, month, 0, 23, 59, 59);
      // Exclude invoice aggregates — they are monthly payout placeholders, not individual stays,
      // and would distort per-booking fixed-cost allocation if counted.
      countCache[k] = await prisma.booking.count({
        where: {
          propertyId: prop.id, status: 'CONFIRMED',
          checkIn: { gte: s, lte: e },
          isInvoiceAggregate: false,
        },
      });
      return countCache[k];
    }

    const now = new Date();

    // Historical average cleaning cost = total SERVICOS_LIMPEZA ÷ past individual (non-aggregate) bookings
    const totalCleaningAmount = cleaningExps.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const pastBookingCount    = bookings.filter(
      b => !b.isInvoiceAggregate && new Date(b.checkOut).getTime() < now.getTime()
    ).length;
    const avgCleaningCost     = pastBookingCount > 0
      ? Math.round((totalCleaningAmount / pastBookingCount) * 100) / 100
      : 270;

    const results = [];

    for (const b of bookings) {
      const totalAmount    = parseFloat(b.totalAmount || 0);
      const source         = b.source || 'DIRECT';
      // isInvoiceAggregate: explicit field set by reconciliation script (not nights===0 heuristic)
      const isAggregate    = !!b.isInvoiceAggregate;
      const feeRate        = PLATFORM_FEES[source] ?? 0;

      // Commission: use actual stored value when available (from Booking.com extranet screenshots).
      // Fallback: estimate from net using correct formula — commission = net × rate / (1 − rate).
      // (Not net × rate, which underestimates: 13% of gross ≠ 13% of net-of-commission.)
      const taxaPlataforma = b.commissionAmount
        ? parseFloat(b.commissionAmount)
        : (feeRate > 0 ? Math.round(totalAmount * feeRate / (1 - feeRate) * 100) / 100 : 0);

      // Actual commission rate for display (gross-based %)
      const grossAmt = b.grossAmount ? parseFloat(b.grossAmount) : null;
      const commissionRate = grossAmt && taxaPlataforma > 0
        ? parseFloat(((taxaPlataforma / grossAmt) * 100).toFixed(1))
        : (feeRate * 100);

      let custoLimpeza, custoLimpezaFonte, custoFixo;

      if (isAggregate) {
        // Monthly aggregates cover multiple stays — cost allocation is meaningless per record.
        // Show only the platform fee; mark cleaning + fixed as N/A.
        custoLimpeza      = 0;
        custoLimpezaFonte = 'N/A_AGGREGATE';
        custoFixo         = 0;
      } else {
        // Try to match actual cleaning expense: checkout window -1 day to +4 days
        const coMs = new Date(b.checkOut).getTime();
        const cleaningMatch = cleaningExps.find(e => {
          const diff = new Date(e.date).getTime() - coMs;
          return diff >= -86400000 && diff <= 4 * 86400000;
        });
        // Use actual if found; otherwise use historical average (more accurate than 0)
        custoLimpeza      = cleaningMatch ? parseFloat(cleaningMatch.amount || 0) : avgCleaningCost;
        custoLimpezaFonte = cleaningMatch ? 'REAL' : 'ESTIMADO';

        // Fixed cost allocation by check-in month (excludes aggregates from denominator)
        const ci = new Date(b.checkIn);
        const [fixed, count] = await Promise.all([
          monthlyFixed(ci.getFullYear(), ci.getMonth() + 1),
          monthlyBookings(ci.getFullYear(), ci.getMonth() + 1),
        ]);
        custoFixo = count > 0 ? Math.round((fixed / count) * 100) / 100 : 0;
      }

      const custoTotal       = taxaPlataforma + custoLimpeza + custoFixo;
      const resultadoLiquido = totalAmount - custoTotal;
      const margem           = totalAmount > 0 ? resultadoLiquido / totalAmount : 0;

      const ciTs = new Date(b.checkIn).getTime();
      const coTs = new Date(b.checkOut).getTime();
      const status = now < ciTs ? 'FUTURE' : now > coTs ? 'PAST' : 'CURRENT';

      results.push({
        id:               b.id,
        guestName:        b.guestName,
        guestPhone:       b.guestPhone || null,
        checkIn:          b.checkIn,
        checkOut:         b.checkOut,
        nights:           b.nights || 0,
        guests:           b.guestCount || 0,
        source,
        status,
        isAggregate,
        totalReceita:        totalAmount,
        grossReceita:        grossAmt,      // guest-facing price (null for legacy records)
        commissionRate,                    // % commission on gross (actual or estimated)
        taxaPlataforma,
        custoLimpeza,
        custoLimpezaFonte,
        custoFixoAlocado:    custoFixo,
        custoTotal,
        resultadoLiquido,
        margem,
        avgCleaningCost,
      });
    }

    res.json({ reservas: results });
  } catch (err) {
    console.error('[staff-portal] financeiro/reservas-lucratividade error:', err);
    res.status(500).json({ error: 'Erro ao calcular lucratividade por reserva' });
  }
});

// ── GET /api/staff/configuracoes/porteiro ─────────────────────────────────────
router.get('/configuracoes/porteiro', requireRole('ADMIN'), async (req, res) => {
  try {
    const property = await prisma.property.findFirst({
      where:  { active: true },
      select: { id: true, name: true, porteiroPhone: true },
    });
    res.json({ porteiroPhone: property?.porteiroPhone || null, propertyName: property?.name || null });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

// ── PATCH /api/staff/configuracoes/porteiro ───────────────────────────────────
router.patch('/configuracoes/porteiro', requireRole('ADMIN'), async (req, res) => {
  const { porteiroPhone } = req.body;
  if (porteiroPhone !== null && typeof porteiroPhone !== 'string') {
    return res.status(400).json({ error: 'Número inválido' });
  }
  try {
    const property = await prisma.property.findFirst({ where: { active: true }, select: { id: true } });
    if (!property) return res.status(404).json({ error: 'Propriedade não encontrada' });

    await prisma.property.update({
      where: { id: property.id },
      data:  { porteiroPhone: porteiroPhone || null },
    });
    res.json({ ok: true, porteiroPhone: porteiroPhone || null });
  } catch (err) {
    console.error('[staff-portal] PATCH porteiro error:', err);
    res.status(500).json({ error: 'Erro ao salvar' });
  }
});

// ── GET /api/staff/atividades ────────────────────────────────────────────────
// Admin-only: recent staff activity log across all staff or filtered by staffId/actionType
router.get('/atividades', requireRole('ADMIN'), async (req, res) => {
  try {
    const { staffId, actionType, limit: rawLimit = '50', page: rawPage = '1' } = req.query;
    const limit   = Math.min(100, Math.max(1, parseInt(rawLimit) || 50));
    const pageNum = Math.max(1, parseInt(rawPage) || 1);
    const skip    = (pageNum - 1) * limit;

    const where = {};
    if (staffId)    where.staffId    = staffId;
    if (actionType) where.actionType = actionType;

    const [logs, total] = await Promise.all([
      prisma.staffActivityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { staff: { select: { id: true, name: true, role: true } } },
      }),
      prisma.staffActivityLog.count({ where }),
    ]);

    res.json({ logs, total, page: pageNum, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[staff-portal] GET /atividades error:', err);
    res.status(500).json({ error: 'Erro ao buscar atividades' });
  }
});

// ── POST /api/staff/atividades ───────────────────────────────────────────────
// Internal: any staff member can log an action for themselves.
router.post('/atividades', async (req, res) => {
  const { actionType, entityType, entityId, summary, meta } = req.body;
  if (!actionType || typeof actionType !== 'string' || actionType.trim().length === 0) {
    return res.status(400).json({ error: 'actionType obrigatório' });
  }
  if (actionType.length > 60)  return res.status(400).json({ error: 'actionType muito longo' });
  if (entityType && entityType.length > 60) return res.status(400).json({ error: 'entityType muito longo' });
  if (entityId  && entityId.length  > 100) return res.status(400).json({ error: 'entityId muito longo' });
  if (summary   && summary.length   > 500) return res.status(400).json({ error: 'summary muito longo' });
  if (meta !== undefined && (typeof meta !== 'object' || Array.isArray(meta))) {
    return res.status(400).json({ error: 'meta deve ser um objeto JSON' });
  }

  try {
    const log = await prisma.staffActivityLog.create({
      data: {
        staffId:    req.staff.id,
        actionType: actionType.trim(),
        entityType: entityType?.trim()   || null,
        entityId:   entityId?.trim()     || null,
        summary:    summary?.trim()      || null,
        meta:       meta                 ?? undefined,
      },
    });
    res.status(201).json(log);
  } catch (err) {
    console.error('[staff-portal] POST /atividades error:', err);
    res.status(500).json({ error: 'Erro ao registrar atividade' });
  }
});

// ── GET /api/staff/admin/pricing-tiers ────────────────────────────────────────
// Returns ChildPricingTier rows (URL kept short — internally these are
// children pricing tiers; the model is `ChildPricingTier` due to a naming
// collision with the existing `PricingTier` seasonal enum).
router.get('/admin/pricing-tiers', requireRole('ADMIN'), async (req, res) => {
  const { propertyId } = req.query;
  try {
    const tiers = await prisma.childPricingTier.findMany({
      where: propertyId ? { propertyId: String(propertyId) } : undefined,
      orderBy: [{ propertyId: 'asc' }, { ageMin: 'asc' }],
    });
    res.json(tiers);
  } catch (err) {
    console.error('[staff-portal] GET pricing-tiers error:', err);
    res.status(500).json({ error: 'Erro ao buscar tiers de preço' });
  }
});

// ── PUT /api/staff/admin/pricing-tiers/:id ────────────────────────────────────
router.put('/admin/pricing-tiers/:id', requireRole('ADMIN'), async (req, res) => {
  const schema = z.object({
    label:     z.string().min(1),
    ageMin:    z.number().int().min(0),
    ageMax:    z.number().int().min(0),
    rateType:  z.enum(['FREE', 'FIXED', 'FULL_PRICE']),
    fixedRate: z.number().min(0).optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', details: parsed.error.errors });

  try {
    const tier = await prisma.childPricingTier.update({
      where: { id: req.params.id },
      data: {
        label:     parsed.data.label,
        ageMin:    parsed.data.ageMin,
        ageMax:    parsed.data.ageMax,
        rateType:  parsed.data.rateType,
        fixedRate: parsed.data.fixedRate ?? null,
      },
    });
    res.json(tier);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Tier não encontrado' });
    console.error('[staff-portal] PUT pricing-tiers/:id error:', err);
    res.status(500).json({ error: 'Erro ao atualizar tier de preço' });
  }
});

// ── GET /api/staff/contacts/initiable ────────────────────────────────────────
// Returns a merged list of contacts you can start a new conversation with:
// distinct guests from Booking table (with phones) merged with GHL contacts.
// Supports search, source filter, and recency vs alphabetical sort.
router.get('/contacts/initiable', requireRole('ADMIN'), async (req, res) => {
  const sourceFilter = String(req.query.source || 'all').toUpperCase();   // ALL | DIRECT | AIRBNB | BOOKING_COM | GHL_ONLY
  const sort         = String(req.query.sort || 'recency').toLowerCase(); // recency | alphabetical
  const query        = String(req.query.query || '').trim().toLowerCase();

  try {
    // 1. Distinct booking guests with phones, ordered by most recent checkIn first.
    const bookingRows = await prisma.booking.findMany({
      where: { guestPhone: { not: null } },
      select: {
        guestName: true,
        guestEmail: true,
        guestPhone: true,
        source: true,
        checkIn: true,
      },
      orderBy: { checkIn: 'desc' },
      distinct: ['guestPhone'],
    });

    // 2. GHL contacts via the new client.
    const ghlContacts = await ghlClient.fetchContacts({ limit: 200, query });

    // 3. Merge by phone (booking record wins when both exist — has source info).
    const byPhone = new Map();
    for (const b of bookingRows) {
      const phone = (b.guestPhone || '').replace(/\D/g, '');
      if (!phone) continue;
      byPhone.set(phone, {
        id: `booking-${phone}`,
        name: b.guestName || 'Hóspede',
        phone,
        email: b.guestEmail || null,
        source: b.source, // 'DIRECT' | 'AIRBNB' | 'BOOKING_COM'
        lastSeen: b.checkIn ? b.checkIn.toISOString() : null,
        channels: ['WHATSAPP', ...(b.guestEmail ? ['EMAIL'] : [])],
      });
    }
    for (const g of ghlContacts) {
      const phone = (g.phone || '').replace(/\D/g, '');
      if (!phone) continue;
      if (byPhone.has(phone)) continue; // booking row already wins
      byPhone.set(phone, {
        id: g.id,
        name: g.name,
        phone,
        email: g.email,
        source: 'GHL_ONLY',
        lastSeen: g.lastActivityAt,
        channels: ['WHATSAPP', ...(g.email ? ['EMAIL'] : [])],
      });
    }

    let contacts = Array.from(byPhone.values());

    // 4. Apply source filter.
    if (sourceFilter !== 'ALL') {
      contacts = contacts.filter(c => c.source === sourceFilter);
    }

    // 5. Apply text search.
    if (query) {
      contacts = contacts.filter(c =>
        (c.name || '').toLowerCase().includes(query) ||
        (c.phone || '').toLowerCase().includes(query) ||
        (c.email || '').toLowerCase().includes(query)
      );
    }

    // 6. Sort.
    if (sort === 'alphabetical') {
      contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } else {
      contacts.sort((a, b) => {
        if (!a.lastSeen) return 1;
        if (!b.lastSeen) return -1;
        return new Date(b.lastSeen) - new Date(a.lastSeen);
      });
    }

    // 7. Cap at 200.
    res.json({ contacts: contacts.slice(0, 200) });
  } catch (err) {
    console.error('[staff-portal] GET contacts/initiable error:', err);
    res.status(500).json({ error: 'Erro ao buscar contatos' });
  }
});

// Export generateBriefing under a stable name for the cron job.
// The cron calls this directly to avoid an internal HTTP round-trip.
module.exports = router;
module.exports.generateBriefingForCron = generateBriefing;
