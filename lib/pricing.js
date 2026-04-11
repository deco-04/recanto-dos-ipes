'use strict';

const prisma = require('./db');

const TIER_PRICES = {
  LOW:      720,
  MID:      850,
  HIGH_MID: 1050,
  PEAK:     1300,
};

const EXTRA_GUEST_RATE = 50;   // R$/person/night beyond 11 guests
const PET_FEE         = 50;   // R$ flat per booking
const BASE_GUEST_LIMIT = 11;
const MAX_GUESTS      = 20;

/**
 * Returns the price per night for a given check-in date.
 * Falls back to LOW (R$720) if no seasonal pricing row covers the date.
 */
async function getPriceForDate(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0); // noon to avoid DST edge cases

  const row = await prisma.seasonalPricing.findFirst({
    where: {
      startDate: { lte: d },
      endDate:   { gte: d },
    },
    orderBy: [
      // If multiple rows overlap (shouldn't happen but safety), prefer highest tier
      { pricePerNight: 'desc' },
    ],
  });

  if (row) {
    return {
      pricePerNight: Number(row.pricePerNight),
      tier: row.tier,
      seasonName: row.name,
    };
  }

  return { pricePerNight: TIER_PRICES.LOW, tier: 'LOW', seasonName: 'Baixa temporada' };
}

/**
 * Calculates a full booking quote.
 * Uses the check-in night's rate for the entire stay.
 *
 * @param {object} params
 * @param {string|Date} params.checkIn   - ISO date string or Date
 * @param {string|Date} params.checkOut  - ISO date string or Date
 * @param {number}      params.guestCount - total guests (1–20)
 * @param {boolean}     params.hasPet    - pet fee applies
 * @returns {object} Full price breakdown
 */
async function calculateQuote({ checkIn, checkOut, guestCount, hasPet }) {
  const inDate  = new Date(checkIn);
  const outDate = new Date(checkOut);

  if (outDate <= inDate) {
    throw new Error('Check-out deve ser após o check-in');
  }

  const nights = Math.round((outDate - inDate) / (1000 * 60 * 60 * 24));

  if (nights < 1) throw new Error('Mínimo de 1 noite');

  const guests = Math.min(Math.max(1, guestCount), MAX_GUESTS);
  const extraGuests = Math.max(0, guests - BASE_GUEST_LIMIT);

  // Use check-in night's rate for the whole stay (standard vacation rental practice)
  const { pricePerNight, tier, seasonName } = await getPriceForDate(inDate);

  const baseSubtotal  = pricePerNight * nights;
  const extraGuestFee = extraGuests * EXTRA_GUEST_RATE * nights;
  const petFee        = hasPet ? PET_FEE : 0;
  const totalAmount   = baseSubtotal + extraGuestFee + petFee;

  // Per-night breakdown for display
  const breakdown = [];
  for (let i = 0; i < nights; i++) {
    const night = new Date(inDate);
    night.setDate(night.getDate() + i);
    breakdown.push({
      date: night.toISOString().split('T')[0],
      rate: pricePerNight,
      tier,
    });
  }

  return {
    nights,
    guestCount: guests,
    extraGuests,
    hasPet,
    baseRatePerNight: pricePerNight,
    tier,
    seasonName,
    baseSubtotal,
    extraGuestFee,
    petFee,
    totalAmount,
    breakdown,
    // Formatted for display
    formatted: {
      baseRatePerNight: formatBRL(pricePerNight),
      baseSubtotal:     formatBRL(baseSubtotal),
      extraGuestFee:    formatBRL(extraGuestFee),
      petFee:           formatBRL(petFee),
      totalAmount:      formatBRL(totalAmount),
    },
  };
}

/**
 * Returns all seasonal pricing entries, used by the calendar widget to color dates.
 */
async function getPricingCalendar() {
  const rows = await prisma.seasonalPricing.findMany({
    where: {
      endDate: { gte: new Date() },
    },
    orderBy: { startDate: 'asc' },
  });

  return rows.map(r => ({
    id:           r.id,
    name:         r.name,
    tier:         r.tier,
    startDate:    r.startDate.toISOString().split('T')[0],
    endDate:      r.endDate.toISOString().split('T')[0],
    pricePerNight: Number(r.pricePerNight),
    minNights:    r.minNights,
  }));
}

function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

module.exports = {
  calculateQuote,
  getPriceForDate,
  getPricingCalendar,
  TIER_PRICES,
  EXTRA_GUEST_RATE,
  PET_FEE,
  BASE_GUEST_LIMIT,
  MAX_GUESTS,
};
