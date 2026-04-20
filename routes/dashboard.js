'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const prisma  = require('../lib/db');
const { requireAuth } = require('../lib/auth-middleware');
const { sendGuestInvite } = require('../lib/mailer');

// All dashboard routes require authentication
router.use(requireAuth);

// ── GET /api/dashboard/bookings ───────────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { userId: req.session.userId },
          { guestEmail: req.session.userEmail, userId: null },
        ],
      },
      orderBy: { checkIn: 'desc' },
    });
    res.json({ bookings: bookings.map(sanitizeBooking) });
  } catch (err) {
    console.error('[dashboard] bookings error:', err);
    res.status(500).json({ error: 'Erro ao buscar reservas' });
  }
});

// ── GET /api/dashboard/upcoming ───────────────────────────────────────────────
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    // Own bookings
    const own = await prisma.booking.findMany({
      where: {
        OR: [
          { userId: req.session.userId },
          { guestEmail: req.session.userEmail, userId: null },
        ],
        status:  'CONFIRMED',
        checkIn: { gt: today },
      },
      orderBy: { checkIn: 'asc' },
    });

    // Bookings where this user is a confirmed co-guest
    const coGuestEntries = await prisma.bookingGuest.findMany({
      where:   { userId: req.session.userId, status: 'CONFIRMADO' },
      include: { booking: true },
    });

    const coGuest = coGuestEntries
      .filter(g => g.booking && g.booking.status === 'CONFIRMED' && new Date(g.booking.checkIn) > today)
      .map(g => ({ ...sanitizeBooking(g.booking), role: 'CO_GUEST' }));

    const bookings = [
      ...own.map(b => ({ ...sanitizeBooking(b), role: 'GUEST' })),
      ...coGuest,
    ].sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));

    res.json({ bookings });
  } catch (err) {
    console.error('[dashboard] upcoming error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas reservas' });
  }
});

// ── GET /api/dashboard/current ────────────────────────────────────────────────
router.get('/current', async (req, res) => {
  try {
    const today = new Date(); today.setHours(12, 0, 0, 0);

    // Own booking
    const own = await prisma.booking.findFirst({
      where: {
        OR: [
          { userId: req.session.userId },
          { guestEmail: req.session.userEmail, userId: null },
        ],
        status:   'CONFIRMED',
        checkIn:  { lte: today },
        checkOut: { gte: today },
      },
    });
    if (own) return res.json({ booking: { ...sanitizeBooking(own), role: 'GUEST' } });

    // Co-guest: check if there's an active booking they're confirmed on
    const coGuestEntries = await prisma.bookingGuest.findMany({
      where:   { userId: req.session.userId, status: 'CONFIRMADO' },
      include: { booking: true },
    });

    const coBooking = coGuestEntries
      .map(g => g.booking)
      .find(b => b && b.status === 'CONFIRMED' && new Date(b.checkIn) <= today && new Date(b.checkOut) >= today)
      ?? null;
    res.json({ booking: coBooking ? { ...sanitizeBooking(coBooking), role: 'CO_GUEST' } : null });
  } catch (err) {
    console.error('[dashboard] current error:', err);
    res.status(500).json({ error: 'Erro ao buscar estadia atual' });
  }
});

// ── GET /api/dashboard/past ───────────────────────────────────────────────────
router.get('/past', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const own = await prisma.booking.findMany({
      where: {
        OR: [
          { userId: req.session.userId },
          { guestEmail: req.session.userEmail, userId: null },
        ],
        status:   'CONFIRMED',
        checkOut: { lt: today },
      },
      orderBy: { checkOut: 'desc' },
    });

    const coGuestEntries = await prisma.bookingGuest.findMany({
      where:   { userId: req.session.userId, status: 'CONFIRMADO' },
      include: { booking: true },
    });

    const coGuest = coGuestEntries
      .filter(g => g.booking && g.booking.status === 'CONFIRMED' && new Date(g.booking.checkOut) < today)
      .map(g => ({ ...sanitizeBooking(g.booking), role: 'CO_GUEST' }));

    const bookings = [
      ...own.map(b => ({ ...sanitizeBooking(b), role: 'GUEST' })),
      ...coGuest,
    ].sort((a, b) => new Date(b.checkOut) - new Date(a.checkOut));

    res.json({ bookings });
  } catch (err) {
    console.error('[dashboard] past error:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// ── GET /api/dashboard/invoice/:bookingId ──────────────────────────────────────
router.get('/invoice/:bookingId', async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.bookingId, userId: req.session.userId },
    });

    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const formatBRL = v => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));

    res.json({
      invoice: {
        ...sanitizeBooking(booking),
        guestPhone:      booking.guestPhone,
        guestCpf:        booking.guestCpf,
        baseRatePerNight: formatBRL(booking.baseRatePerNight),
        extraGuestFee:    formatBRL(booking.extraGuestFee),
        petFee:           formatBRL(booking.petFee),
        totalAmount:      formatBRL(booking.totalAmount),
        hasPet:           booking.hasPet,
        extraGuests:      booking.extraGuests,
        notes:            booking.notes,
      },
    });
  } catch (err) {
    console.error('[dashboard] invoice error:', err);
    res.status(500).json({ error: 'Erro ao buscar fatura' });
  }
});

// ── GET /api/dashboard/pending ───────────────────────────────────────────────
// Returns PENDING bookings created in the last 48h (awaiting payment confirmation)
router.get('/pending', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const bookings = await prisma.booking.findMany({
      where: {
        OR: [
          { userId: req.session.userId },
          { guestEmail: req.session.userEmail, userId: null },
        ],
        status:    'PENDING',
        createdAt: { gt: cutoff },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ bookings: bookings.map(sanitizeBooking) });
  } catch (err) {
    console.error('[dashboard] pending error:', err);
    res.status(500).json({ error: 'Erro ao buscar reservas pendentes' });
  }
});

// ── GET /api/dashboard/bookings/:id/guests ────────────────────────────────────
// Owner sees all guests (pending + confirmed). Co-guests see only confirmed ones.
router.get('/bookings/:id/guests', async (req, res) => {
  try {
    const userId = req.session.userId;

    // Check if requester is the booking owner
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId },
    });

    if (booking) {
      // Owner: full list with all statuses
      const guests = await prisma.bookingGuest.findMany({
        where:   { bookingId: req.params.id },
        orderBy: { createdAt: 'asc' },
        select:  { id: true, name: true, email: true, phone: true, status: true },
      });
      return res.json({ guests, isOwner: true });
    }

    // Not owner — check if they are a confirmed co-guest on this booking
    const coGuestEntry = await prisma.bookingGuest.findFirst({
      where: { bookingId: req.params.id, userId, status: 'CONFIRMADO' },
    });
    if (!coGuestEntry) return res.status(403).json({ error: 'Acesso negado' });

    // Co-guest: only see confirmed guests (hide pending invites)
    const guests = await prisma.bookingGuest.findMany({
      where:   { bookingId: req.params.id, status: 'CONFIRMADO' },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, name: true, email: true, status: true },
    });
    return res.json({ guests, isOwner: false });
  } catch (err) {
    console.error('[dashboard] guests list error:', err);
    res.status(500).json({ error: 'Erro ao buscar acompanhantes' });
  }
});

// ── POST /api/dashboard/bookings/:id/guests ───────────────────────────────────
router.post('/bookings/:id/guests', async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId: req.session.userId },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const { name, email, phone } = req.body;
    if (!name?.trim() || !email?.trim()) {
      return res.status(400).json({ error: 'Nome e e-mail são obrigatórios' });
    }

    // Max 10 co-guests per booking
    const count = await prisma.bookingGuest.count({ where: { bookingId: req.params.id } });
    if (count >= 10) return res.status(400).json({ error: 'Limite de 10 acompanhantes por reserva' });

    // Generate invite token (raw token sent in URL, hashed version stored)
    const rawToken   = crypto.randomBytes(32).toString('hex');
    const tokenHash  = crypto.createHash('sha256').update(rawToken).digest('hex');
    const inviteExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72h

    const guest = await prisma.bookingGuest.create({
      data: {
        bookingId:   req.params.id,
        addedById:   req.session.userId,
        name:        name.trim(),
        email:       email.trim().toLowerCase(),
        phone:       phone?.trim() || null,
        inviteToken: tokenHash,
        inviteExpiry,
        status:      'PENDENTE',
      },
    });

    // Send invite email (non-blocking)
    const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
    const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
    const baseUrl  = process.env.GUEST_SITE_URL || 'https://sitiorecantodosipes.com';
    const inviteUrl = `${baseUrl}/confirmar-hospede.html?token=${rawToken}`;

    sendGuestInvite({
      to: guest.email,
      name: guest.name,
      hostName: booking.guestName,
      checkIn,
      checkOut,
      inviteUrl,
    }).catch(e => console.error('[dashboard] guest invite email error:', e.message));

    res.json({ guest: { id: guest.id, name: guest.name, email: guest.email, status: guest.status } });
  } catch (err) {
    console.error('[dashboard] add guest error:', err);
    res.status(500).json({ error: 'Erro ao convidar acompanhante' });
  }
});

// ── DELETE /api/dashboard/bookings/:id/guests/:guestId ───────────────────────
router.delete('/bookings/:id/guests/:guestId', async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId: req.session.userId },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const guest = await prisma.bookingGuest.findFirst({
      where: { id: req.params.guestId, bookingId: req.params.id },
    });
    if (!guest) return res.status(404).json({ error: 'Acompanhante não encontrado' });
    if (guest.status !== 'PENDENTE') {
      return res.status(400).json({ error: 'Não é possível remover acompanhante já confirmado' });
    }

    await prisma.bookingGuest.delete({ where: { id: req.params.guestId } });
    res.json({ ok: true });
  } catch (err) {
    console.error('[dashboard] remove guest error:', err);
    res.status(500).json({ error: 'Erro ao remover acompanhante' });
  }
});

// ── GET /api/dashboard/arrival-kit ───────────────────────────────────────────
// Returns property accessInfo if the user has a CONFIRMED booking checking in
// within the next 7 days (or currently ongoing). Fail-safe: never 500.
router.get('/arrival-kit', async (req, res) => {
  try {
    const today  = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(today.getDate() + 7);

    // 1. Check own bookings within window
    const ownBooking = await prisma.booking.findFirst({
      where: {
        OR: [
          { userId: req.session.userId },
          { guestEmail: req.session.userEmail, userId: null },
        ],
        status:   'CONFIRMED',
        checkIn:  { lte: cutoff },
        checkOut: { gte: today },
      },
      orderBy: { checkIn: 'asc' },
    });

    // 2. Check co-guest bookings within window
    let targetBooking = ownBooking;
    if (!targetBooking && req.session.userId) {
      const coGuestEntries = await prisma.bookingGuest.findMany({
        where:   { userId: req.session.userId, status: 'CONFIRMADO' },
        include: { booking: true },
      });
      const coBooking = coGuestEntries
        .map(g => g.booking)
        .find(b =>
          b &&
          b.status === 'CONFIRMED' &&
          new Date(b.checkIn) <= cutoff &&
          new Date(b.checkOut) >= today
        ) ?? null;
      if (coBooking) targetBooking = coBooking;
    }

    if (!targetBooking) return res.json({ accessInfo: null });

    const property = await prisma.property.findFirst({ where: { active: true } });
    const daysUntil = Math.ceil((new Date(targetBooking.checkIn) - today) / (1000 * 60 * 60 * 24));

    res.json({
      accessInfo: property?.accessInfo ?? null,
      checkIn:    targetBooking.checkIn,
      checkOut:   targetBooking.checkOut,
      daysUntil,  // negative = already checked in
    });
  } catch (err) {
    console.error('[dashboard] arrival-kit error:', err);
    res.json({ accessInfo: null }); // fail silently — non-critical feature
  }
});

// ── POST /api/dashboard/bookings/:id/guests/:guestId/resend ───────────────────
router.post('/bookings/:id/guests/:guestId/resend', async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId: req.session.userId },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const guest = await prisma.bookingGuest.findFirst({
      where: { id: req.params.guestId, bookingId: req.params.id },
    });
    if (!guest) return res.status(404).json({ error: 'Acompanhante não encontrado' });
    if (guest.status !== 'PENDENTE') {
      return res.status(400).json({ error: 'Convite já aceito ou cancelado' });
    }

    // Regenerate token
    const rawToken    = crypto.randomBytes(32).toString('hex');
    const tokenHash   = crypto.createHash('sha256').update(rawToken).digest('hex');
    const inviteExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72h

    await prisma.bookingGuest.update({
      where: { id: guest.id },
      data:  { inviteToken: tokenHash, inviteExpiry },
    });

    const checkIn  = new Date(booking.checkIn).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
    const checkOut = new Date(booking.checkOut).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
    const baseUrl  = process.env.GUEST_SITE_URL || 'https://sitiorecantodosipes.com';
    const inviteUrl = `${baseUrl}/confirmar-hospede.html?token=${rawToken}`;

    sendGuestInvite({
      to: guest.email,
      name: guest.name,
      hostName: booking.guestName,
      checkIn,
      checkOut,
      inviteUrl,
    }).catch(e => console.error('[dashboard] resend invite email error:', e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[dashboard] resend invite error:', err);
    res.status(500).json({ error: 'Erro ao reenviar convite' });
  }
});

function sanitizeBooking(b) {
  return {
    id:            b.id,
    invoiceNumber: b.invoiceNumber,
    checkIn:       b.checkIn,
    checkOut:      b.checkOut,
    nights:        b.nights,
    guestCount:    b.guestCount,
    extraGuests:   b.extraGuests,
    hasPet:        b.hasPet,
    totalAmount:   Number(b.totalAmount),
    status:        b.status,
    guestName:     b.guestName,
    guestEmail:    b.guestEmail,
    source:        b.source,
    createdAt:     b.createdAt,
  };
}

module.exports = router;
