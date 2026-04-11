'use strict';

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/db');
const { requireAuth } = require('../lib/auth-middleware');

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

    const booking = await prisma.booking.findFirst({
      where: {
        userId:   req.session.userId,
        status:   'CONFIRMED',
        checkIn:  { gt: today },
      },
      orderBy: { checkIn: 'asc' },
    });

    res.json({ booking: booking ? sanitizeBooking(booking) : null });
  } catch (err) {
    console.error('[dashboard] upcoming error:', err);
    res.status(500).json({ error: 'Erro ao buscar próxima reserva' });
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
