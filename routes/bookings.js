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

// ── Per-IP rate limit: max 10 receipt lookups per minute ──────────────────────
const receiptRateLimit = new Map(); // ip → { count, resetAt }

function checkReceiptRateLimit(ip) {
  const now   = Date.now();
  const entry = receiptRateLimit.get(ip);
  if (!entry || entry.resetAt < now) {
    receiptRateLimit.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// Prune expired entries hourly to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of intentRateLimit)  if (v.resetAt < now) intentRateLimit.delete(k);
  for (const [k, v] of receiptRateLimit) if (v.resetAt < now) receiptRateLimit.delete(k);
}, 60 * 60 * 1000).unref();

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

    // Dates blocked by confirmed/requested direct bookings (PENDING excluded — only show real blocks)
    const bookings = await prisma.booking.findMany({
      where: {
        status:   { in: ['CONFIRMED', 'REQUESTED'] },   // ← add REQUESTED
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
// Query: ?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=N&petCount=0-4
router.get('/quote', async (req, res) => {
  try {
    const { checkIn, checkOut, guests, petCount } = req.query;

    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'checkIn e checkOut são obrigatórios' });
    }

    const guestCount = Math.max(1, parseInt(guests) || 1);
    const petCountInt = Math.min(Math.max(parseInt(petCount) || 0, 0), 4);

    const quote = await calculateQuote({ checkIn, checkOut, guestCount, petCount: petCountInt });
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
      checkIn:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      checkOut:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      guestCount:     z.number().int().min(1).max(20),
      petCount:       z.number().int().min(0).max(4).optional().default(0),
      guestName:      z.string().min(2).max(120),
      guestEmail:     z.string().email(),
      guestPhone:     z.string().min(8).max(30),
      guestCpf:       z.string().optional(),
      petDescription: z.string().max(200).optional(),
      notes:          z.string().max(500).optional(),
    });

    const data = schema.parse(req.body);
    const { checkIn, checkOut, guestCount, petCount, guestName, guestEmail, guestPhone, guestCpf, notes } = data;
    // petDescription accessed via data.petDescription below
    const hasPet = petCount > 0;

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
          status: { in: ['CONFIRMED', 'PENDING', 'REQUESTED'] },  // ← add REQUESTED
          checkIn:  { lt: outDate },
          checkOut: { gt: inDate },
        },
      });
      return bookingConflict > 0;
    });

    if (conflict) {
      return res.status(409).json({ error: 'Datas indisponíveis. Por favor selecione outras datas.' });
    }

    const quote = await calculateQuote({ checkIn, checkOut, guestCount, petCount });

    // Create Stripe PaymentIntent
    const stripe = require('../lib/stripe');
    const paymentIntent = await stripe.paymentIntents.create({
      amount:         Math.round(quote.totalAmount * 100), // cents
      currency:       'brl',
      capture_method: 'manual',          // ← hold card, don't charge yet
      metadata: {
        checkIn, checkOut,
        guestCount: String(guestCount),
        petCount:   String(petCount),
        hasPet:     String(hasPet),
        guestName, guestEmail,
      },
      description: `Reserva Recanto dos Ipês — ${checkIn} a ${checkOut}`,
    });

    // Create a PENDING booking record
    const booking = await prisma.booking.create({
      data: {
        userId:                req.session?.userId ?? null,
        guestName, guestEmail, guestPhone,
        guestCpf:              guestCpf || null,
        checkIn:               inDate,
        checkOut:              outDate,
        nights:                quote.nights,
        guestCount,
        extraGuests:           quote.extraGuests,
        hasPet,
        petDescription:        data.petDescription || null,   // ← new
        baseRatePerNight:      quote.baseRatePerNight,
        extraGuestFee:         quote.extraGuestFee,
        petFee:                quote.petFee,
        totalAmount:           quote.totalAmount,
        stripePaymentIntentId: paymentIntent.id,
        notes:                 data.notes || null,
        status:                'PENDING',
        source:                'DIRECT',
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

    // 1. Verify with Stripe that card has been authorized (pre-auth captured)
    const stripe = require('../lib/stripe');
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.status !== 'requires_capture') {
      return res.status(402).json({ error: 'Pagamento não autorizado' });
    }

    // 2. Load the pending booking
    const pending = await prisma.booking.findUnique({ where: { id: bookingId } });
    if (!pending) return res.status(404).json({ error: 'Reserva não encontrada' });

    if (pending.stripePaymentIntentId !== paymentIntentId) {
      return res.status(400).json({ error: 'Dados de reserva inconsistentes' });
    }

    // Idempotent: already requested or confirmed (e.g. webhook beat the client)
    if (pending.status === 'REQUESTED' || pending.status === 'CONFIRMED') {
      return res.json({ success: true, booking: sanitizeBooking(pending) });
    }

    // 3. Atomic final availability check + set REQUESTED
    const result = await prisma.$transaction(async tx => {
      const blockedCount = await tx.blockedDate.count({
        where: { date: { gte: pending.checkIn, lt: pending.checkOut } },
      });
      if (blockedCount > 0) return { conflict: true };

      const bookingConflict = await tx.booking.count({
        where: {
          id:       { not: bookingId },
          status:   { in: ['CONFIRMED', 'REQUESTED'] },
          checkIn:  { lt: pending.checkOut },
          checkOut: { gt: pending.checkIn },
        },
      });
      if (bookingConflict > 0) return { conflict: true };

      const requested = await tx.booking.update({
        where: { id: bookingId },
        data:  { status: 'REQUESTED' },
      });
      return { requested };
    });

    // 4. Handle conflict: cancel pre-auth
    if (result.conflict) {
      console.warn(`[bookings] confirm conflict on booking ${bookingId} — cancelling pre-auth`);
      await stripe.paymentIntents.cancel(paymentIntentId)
        .catch(e => console.error('[bookings] PI cancel failed:', e.message));
      await prisma.booking.update({
        where: { id: bookingId },
        data:  { status: 'CANCELLED' },
      }).catch(e => console.error('[bookings] booking cancel update failed:', e.message));
      return res.status(409).json({
        error: 'Infelizmente as datas foram reservadas por outra pessoa durante o seu checkout. A pré-autorização do seu cartão foi cancelada.',
      });
    }

    // 5. Fire request-received messages + GHL (non-blocking, best-effort)
    try {
      const { sendBookingRequestReceived } = require('../lib/mailer');
      const { notifyBookingRequested }     = require('../lib/ghl-webhook');
      const { sendPushToRole }             = require('../lib/push');

      if (typeof sendBookingRequestReceived === 'function') {
        sendBookingRequestReceived({ booking: result.requested })
          .catch(e => console.error('[mailer] requestReceived error:', e.message));
      }
      if (typeof notifyBookingRequested === 'function') {
        notifyBookingRequested(result.requested)
          .catch(e => console.error('[ghl] notifyRequested error:', e.message));
      }
      sendPushToRole('ADMIN', {
        title: 'Nova solicitação de reserva',
        body:  `${result.requested.guestName} · ${result.requested.checkIn.toISOString().split('T')[0]} → ${result.requested.checkOut.toISOString().split('T')[0]}`,
        type:  'BOOKING_REQUESTED',
        data:  { bookingId: result.requested.id },
      }).catch(() => {});
    } catch (notifyErr) {
      console.error('[bookings] notify setup error:', notifyErr.message);
    }

    res.json({ success: true, booking: sanitizeBooking(result.requested) });
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

// ── GET /api/bookings/receipt/:bookingId ──────────────────────────────────────
// Public, no-auth endpoint for post-payment confirmation page.
// Only returns CONFIRMED bookings — prevents leaking PENDING details.
router.get('/receipt/:bookingId', async (req, res) => {
  if (!checkReceiptRateLimit(getClientIp(req))) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde um minuto.' });
  }

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: req.params.bookingId },
    });

    if (!booking || booking.status !== 'CONFIRMED') {
      return res.status(404).json({ error: 'Reserva não encontrada' });
    }

    res.json({
      id:            booking.id,
      invoiceNumber: booking.invoiceNumber,
      guestName:     booking.guestName,
      guestEmail:    booking.guestEmail,
      checkIn:       booking.checkIn,
      checkOut:      booking.checkOut,
      nights:        booking.nights,
      guestCount:    booking.guestCount,
      totalAmount:   Number(booking.totalAmount),
      hasPet:        booking.hasPet,
      status:        booking.status,
    });
  } catch (err) {
    console.error('[bookings] receipt error:', err);
    res.status(500).json({ error: 'Erro ao buscar reserva' });
  }
});

// ── GET /api/bookings/:id/cancel-preview ─────────────────────────────────────
// Returns refund estimate without actually cancelling (shown in dashboard modal)
router.get('/:id/cancel-preview', requireAuth, async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId: req.session.userId },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.status !== 'CONFIRMED') {
      return res.status(400).json({ error: 'Apenas reservas confirmadas podem ser canceladas' });
    }
    if (booking.source !== 'DIRECT') {
      return res.status(400).json({
        error: 'Reservas via Airbnb ou Booking.com devem ser canceladas diretamente na plataforma de origem.',
      });
    }

    const refundInfo = calcRefund(booking);
    res.json(refundInfo);
  } catch (err) {
    console.error('[bookings] cancel-preview error:', err);
    res.status(500).json({ error: 'Erro ao calcular reembolso' });
  }
});

// ── POST /api/bookings/:id/cancel ────────────────────────────────────────────
// Self-cancellation by the booking owner. Calculates and processes Stripe refund.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: { id: req.params.id, userId: req.session.userId },
    });
    if (!booking) return res.status(404).json({ error: 'Reserva não encontrada' });
    if (booking.status !== 'CONFIRMED') {
      return res.status(400).json({ error: 'Apenas reservas confirmadas podem ser canceladas' });
    }
    if (booking.source !== 'DIRECT') {
      return res.status(400).json({
        error: 'Reservas via Airbnb ou Booking.com devem ser canceladas diretamente na plataforma de origem.',
      });
    }

    const { refundAmount, refundPercent } = calcRefund(booking);

    // Process Stripe refund if applicable
    if (refundAmount > 0 && booking.stripePaymentIntentId) {
      const stripe = require('../lib/stripe');
      await stripe.refunds.create({
        payment_intent: booking.stripePaymentIntentId,
        amount: Math.round(refundAmount * 100), // cents
      });
    }

    // Mark as CANCELLED (REFUNDED status reserved for full refunds via admin)
    await prisma.booking.update({
      where: { id: booking.id },
      data:  { status: 'CANCELLED', notes: `Cancelado pelo hóspede em ${new Date().toLocaleDateString('pt-BR')}. Reembolso: ${refundPercent}% (R$${refundAmount.toFixed(2)}).` },
    });

    console.log(`[bookings] Booking ${booking.id} self-cancelled. Refund: ${refundPercent}% = R$${refundAmount.toFixed(2)}`);
    res.json({ success: true, refundAmount, refundPercent });
  } catch (err) {
    console.error('[bookings] cancel error:', err);
    res.status(500).json({ error: 'Erro ao cancelar reserva' });
  }
});

/**
 * Calculates the refund amount and percentage based on cancellation policy:
 *   ≥ 21 days before check-in   → 100% refund
 *   14–20 days before check-in  → 50% refund
 *   < 14 days before check-in   → 0% refund
 */
function calcRefund(booking) {
  const now      = new Date();
  const checkIn  = new Date(booking.checkIn);
  const daysUntil = Math.floor((checkIn - now) / (1000 * 60 * 60 * 24));
  const total    = Number(booking.totalAmount);

  let refundPercent;
  if (daysUntil >= 21)      refundPercent = 100;
  else if (daysUntil >= 14) refundPercent = 50;
  else                      refundPercent = 0;

  const refundAmount = Math.round(total * refundPercent) / 100;
  return { daysUntil, refundPercent, refundAmount, totalAmount: total };
}

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
