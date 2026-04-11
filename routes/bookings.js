'use strict';

const express = require('express');
const router  = express.Router();
const { z }   = require('zod');
const prisma  = require('../lib/db');
const { calculateQuote } = require('../lib/pricing');
const { requireAuth }    = require('../lib/auth-middleware');

// ── Per-IP rate limit: max 5 booking intents per hour ─────────────────────────
// Prevents DoS via unlimited PaymentIntent creation and calendar pollution.
const intentRateLimit = new Map(); // ip → { count, resetAt }

function checkIntentRateLimit(ip) {
  const now   = Date.now();
  const entry = intentRateLimit.get(ip);
  if (!entry || entry.resetAt < now) {
    intentRateLimit.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// Best-effort IP: honour X-Forwarded-For set by Railway's proxy
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.ip;
}

// ── GET /api/bookings/availability ────────────────────────────────────────────
// Query: ?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns array of blocked date strings
router.get('/availability', async (req, res) => {
  try {
    const start = req.query.start ? new Date(req.query.start) : new Date();
    const end   = req.query.end
      ? new Date(req.query.end)
      : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    // Dates blocked by iCal sync
    const blockedRows = await prisma.blockedDate.findMany({
      where: { date: { gte: start, lte: end } },
      select: { date: true, source: true },
    });

    // Dates blocked by confirmed direct bookings (PENDING excluded — only show real blocks)
    const bookings = await prisma.booking.findMany({
      where: {
        status:   'CONFIRMED',
        checkIn:  { lte: end },
        checkOut: { gte: start },
      },
      select: { checkIn: true, checkOut: true },
    });

    const blocked = new Set();

    for (const row of blockedRows) {
      blocked.add(row.date.toISOString().split('T')[0]);
    }

    for (const booking of bookings) {
      const cur = new Date(booking.checkIn);
      const last = new Date(booking.checkOut);
      while (cur < last) {
        blocked.add(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
      }
    }

    res.json({ blockedDates: Array.from(blocked).sort() });
  } catch (err) {
    console.error('[bookings] availability error:', err);
    res.status(500).json({ error: 'Erro ao verificar disponibilidade' });
  }
});

// ── GET /api/bookings/quote ───────────────────────────────────────────────────
// Query: ?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N&pet=true|false
router.get('/quote', async (req, res) => {
  try {
    const { checkIn, checkOut, guests, pet } = req.query;

    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'checkIn e checkOut são obrigatórios' });
    }

    const guestCount = Math.max(1, parseInt(guests) || 1);
    const hasPet     = pet === 'true' || pet === '1';

    const quote = await calculateQuote({ checkIn, checkOut, guestCount, hasPet });
    res.json(quote);
  } catch (err) {
    console.error('[bookings] quote error:', err);
    res.status(400).json({ error: err.message || 'Erro ao calcular cotação' });
  }
});

// ── POST /api/bookings/intent ─────────────────────────────────────────────────
// Creates a Stripe PaymentIntent. Validates availability first.
router.post('/intent', async (req, res) => {
  // Rate-limit before any DB or Stripe work
  if (!checkIntentRateLimit(getClientIp(req))) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.' });
  }

  try {
    const schema = z.object({
      checkIn:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      checkOut:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      guestCount: z.number().int().min(1).max(20),
      hasPet:     z.boolean().optional().default(false),
      guestName:  z.string().min(2).max(120),
      guestEmail: z.string().email(),
      guestPhone: z.string().min(8).max(30),
      guestCpf:   z.string().optional(),
      notes:      z.string().max(500).optional(),
    });

    const data = schema.parse(req.body);
    const { checkIn, checkOut, guestCount, hasPet, guestName, guestEmail, guestPhone, guestCpf, notes } = data;

    const inDate  = new Date(checkIn);
    const outDate = new Date(checkOut);

    // Atomically check availability
    const conflict = await prisma.$transaction(async tx => {
      const blockedCount = await tx.blockedDate.count({
        where: { date: { gte: inDate, lt: outDate } },
      });
      if (blockedCount > 0) return true;

      const bookingConflict = await tx.booking.count({
        where: {
          status: { in: ['CONFIRMED', 'PENDING'] },
          checkIn:  { lt: outDate },
          checkOut: { gt: inDate },
        },
      });
      return bookingConflict > 0;
    });

    if (conflict) {
      return res.status(409).json({ error: 'Datas indisponíveis. Por favor selecione outras datas.' });
    }

    const quote = await calculateQuote({ checkIn, checkOut, guestCount, hasPet });

    // Create Stripe PaymentIntent
    const stripe = require('../lib/stripe');
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   Math.round(quote.totalAmount * 100), // cents
      currency: 'brl',
      metadata: {
        checkIn, checkOut,
        guestCount: String(guestCount),
        hasPet:     String(hasPet),
        guestName, guestEmail,
      },
      description: `Reserva Recanto dos Ipês — ${checkIn} a ${checkOut}`,
    });

    // Create a PENDING booking record
    const booking = await prisma.booking.create({
      data: {
        userId:               req.session?.userId ?? null,
        guestName, guestEmail, guestPhone,
        guestCpf:             guestCpf || null,
        checkIn:              inDate,
        checkOut:             outDate,
        nights:               quote.nights,
        guestCount,
        extraGuests:          quote.extraGuests,
        hasPet,
        baseRatePerNight:     quote.baseRatePerNight,
        extraGuestFee:        quote.extraGuestFee,
        petFee:               quote.petFee,
        totalAmount:          quote.totalAmount,
        stripePaymentIntentId: paymentIntent.id,
        notes:                notes || null,
        status:               'PENDING',
        source:               'DIRECT',
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      bookingId:    booking.id,
      quote,
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: 'Dados inválidos', details: err.errors });
    }
    console.error('[bookings] intent error:', err);
    res.status(500).json({ error: 'Erro ao criar reserva' });
  }
});

// ── POST /api/bookings/confirm ────────────────────────────────────────────────
// Called after Stripe.confirmCardPayment succeeds on the client.
// Atomically re-checks availability before confirming — auto-refunds on conflict.
router.post('/confirm', async (req, res) => {
  try {
    const { paymentIntentId, bookingId } = req.body;

    if (!paymentIntentId || !bookingId) {
      return res.status(400).json({ error: 'paymentIntentId e bookingId são obrigatórios' });
    }

    // 1. Verify with Stripe that payment actually succeeded
    const stripe = require('../lib/stripe');
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'succeeded') {
      return res.status(402).json({ error: 'Pagamento não confirmado' });
    }

    // 2. Load the pending booking
    const pending = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!pending) return res.status(404).json({ error: 'Reserva não encontrada' });

    // Idempotent: already confirmed (e.g. webhook beat the client)
    if (pending.status === 'CONFIRMED') {
      return res.json({ success: true, booking: sanitizeBooking(pending) });
    }

    // 3. Atomic final availability check + status update in one transaction
    const result = await prisma.$transaction(async tx => {
      // Check iCal-blocked dates
      const blockedCount = await tx.blockedDate.count({
        where: { date: { gte: pending.checkIn, lt: pending.checkOut } },
      });
      if (blockedCount > 0) return { conflict: true };

      // Check any OTHER booking that got confirmed for the same window
      const bookingConflict = await tx.booking.count({
        where: {
          id:       { not: bookingId },
          status:   'CONFIRMED',
          checkIn:  { lt: pending.checkOut },
          checkOut: { gt: pending.checkIn },
        },
      });
      if (bookingConflict > 0) return { conflict: true };

      // All clear — confirm atomically
      const confirmed = await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'CONFIRMED' },
      });
      return { confirmed };
    });

    // 4. Handle conflict: auto-refund + cancel
    if (result.conflict) {
      console.warn(`[bookings] confirm conflict on booking ${bookingId} — issuing refund`);
      await stripe.refunds.create({ payment_intent: paymentIntentId })
        .catch(e => console.error('[bookings] refund failed:', e.message));
      await prisma.booking.update({
        where: { id: bookingId },
        data:  { status: 'CANCELLED' },
      }).catch(() => {});
      return res.status(409).json({
        error: 'Infelizmente as datas foram reservadas por outra pessoa durante o seu checkout. Seu pagamento será estornado em até 5 dias úteis.',
      });
    }

    // 5. Fire GHL webhook (non-blocking)
    const { notifyBookingConfirmed } = require('../lib/ghl-webhook');
    notifyBookingConfirmed(result.confirmed).catch(e => console.error('[ghl] webhook error:', e.message));

    res.json({ success: true, booking: sanitizeBooking(result.confirmed) });
  } catch (err) {
    console.error('[bookings] confirm error:', err);
    res.status(500).json({ error: 'Erro ao confirmar reserva' });
  }
});

// ── GET /api/bookings/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
    });

    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });

    // Allow access if: logged-in owner OR matching guest email in query param (for anonymous link)
    const userId    = req.session?.userId;
    const isOwner   = userId && booking.userId === userId;
    const emailMatch = req.query.email && booking.guestEmail.toLowerCase() === req.query.email.toLowerCase();

    if (!isOwner && !emailMatch) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    res.json(sanitizeBooking(booking));
  } catch (err) {
    console.error('[bookings] get error:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva' });
  }
});

// ── POST /api/bookings/:id/link-account ───────────────────────────────────────
// Links an anonymous booking to a logged-in user account
router.post('/:id/link-account', requireAuth, async (req, res) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.id },
    });

    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.userId) return res.status(409).json({ error: 'Reserva já vinculada a uma conta' });

    // Verify email matches
    if (booking.guestEmail.toLowerCase() !== req.session.userEmail?.toLowerCase()) {
      return res.status(403).json({ error: 'E-mail não corresponde à reserva' });
    }

    const updated = await prisma.booking.update({
      where: { id: req.params.id },
      data:  { userId: req.session.userId },
    });

    res.json({ success: true, booking: sanitizeBooking(updated) });
  } catch (err) {
    console.error('[bookings] link-account error:', err);
    res.status(500).json({ error: 'Erro ao vincular conta' });
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
    createdAt:     b.createdAt,
  };
}

module.exports = router;
