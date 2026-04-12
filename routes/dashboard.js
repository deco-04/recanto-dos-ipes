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
      where:   { userId: req.session.userId },
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

    const bookings = await prisma.booking.findMany({
      where: {
        userId:  req.session.userId,
        status:  'CONFIRMED',
        checkIn: { gt: today },
      },
      orderBy: { checkIn: 'asc' },
    });

    res.json({ bookings: bookings.map(sanitizeBooking) });
  } catch (err) {
    console.error('[dashboard] upcoming error:', err);
    res.status(500).json({ error: 'Erro ao buscar próximas reservas' });
  }
});

// ── GET /api/dashboard/current ────────────────────────────────────────────────
router.get('/current', async (req, res) => {
  try {
    const today = new Date(); today.setHours(12, 0, 0, 0);

    const booking = await prisma.booking.findFirst({
      where: {
        userId:   req.session.userId,
        status:   'CONFIRMED',
        checkIn:  { lte: today },
        checkOut: { gte: today },
      },
    });

    res.json({ booking: booking ? sanitizeBooking(booking) : null });
  } catch (err) {
    console.error('[dashboard] current error:', err);
    res.status(500).json({ error: 'Erro ao buscar estadia atual' });
  }
});

// ── GET /api/dashboard/past ───────────────────────────────────────────────────
router.get('/past', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const bookings = await prisma.booking.findMany({
      where: {
        userId:   req.session.userId,
        status:   'CONFIRMED',
        checkOut: { lt: today },
      },
      orderBy: { checkOut: 'desc' },
    });

    res.json({ bookings: bookings.map(sanitizeBooking) });
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

// ── GET /api/dashboard/bookings/:id/guests ────────────────────────────────────
router.get('/bookings/:id/guests', async (req, res) => {
  try {
    // Verify booking belongs to this user
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId: req.session.userId },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    const guests = await prisma.bookingGuest.findMany({
      where:   { bookingId: req.params.id },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, name: true, email: true, phone: true, status: true },
    });

    res.json({ guests });
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
