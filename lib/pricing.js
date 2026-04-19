'use strict';

const prisma = require('./db');

// ── SRI pricing ───────────────────────────────────────────────────────────────
const TIER_PRICES = {
  LOW:      720,
  MID:      850,
  HIGH_MID: 1050,
  PEAK:     1300,
};

const EXTRA_GUEST_RATE = 50;   // R$/person/night beyond 11 guests
const PET_FEE_MAP     = { 0: 0, 1: 0, 2: 0, 3: 50, 4: 100 }; // R$ by pet count
const BASE_GUEST_LIMIT = 11;
const MAX_GUESTS      = 20;

// ── CDS cabin pricing ─────────────────────────────────────────────────────────
const CDS_TIER_PRICES = {
  LOW:      380,
  MID:      490,
  HIGH_MID: 620,
  PEAK:     780,
};
const CDS_EXTRA_GUEST_RATE = 80;  // R$/person/night beyond 2 guests
const CDS_BASE_GUEST_LIMIT = 2;
const CDS_MAX_GUESTS       = 4;
const CDS_PET_FEE          = 50;  // flat R$ per stay

/**
 * Returns the price per night for a given check-in date.
 * Optionally filtered by propertyId (for multi-property pricing).
 * Falls back to tier default if no seasonal pricing row covers the date.
 *
 * @param {Date|string} date
 * @param {string|null}  [propertyId] - if provided, filters to that property's pricing rows
 * @param {object}       [fallbackTiers] - tier price map to use as fallback (defaults to SRI)
 */
async function getPriceForDate(date, propertyId = null, fallbackTiers = TIER_PRICES) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0); // noon to avoid DST edge cases

  const where = {
    startDate: { lte: d },
    endDate:   { gte: d },
  };
  if (propertyId) where.propertyId = propertyId;

  const row = await prisma.seasonalPricing.findFirst({
    where,
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

  return { pricePerNight: fallbackTiers.LOW, tier: 'LOW', seasonName: 'Baixa temporada' };
}

/**
 * Calculates a full booking quote.
 * Uses the check-in night's rate for the entire stay.
 *
 * @param {object} params
 * @param {string|Date} params.checkIn   - ISO date string or Date
 * @param {string|Date} params.checkOut  - ISO date string or Date
 * @param {number}      params.guestCount - total guests (1–20)
 * @param {number}      params.petCount  - number of pets (0-4); 0 = no pets
 * @returns {object} Full price breakdown
 */
async function calculateQuote({ checkIn, checkOut, guestCount, petCount }) {
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
  const { pricePerNight, tier, seasonName } = await getPriceForDate(inDate, null, TIER_PRICES);

  const clampedPetCount = Math.min(Math.max(parseInt(petCount) || 0, 0), 4);
  const baseSubtotal  = pricePerNight * nights;
  const extraGuestFee = extraGuests * EXTRA_GUEST_RATE * nights;
  const petFee        = PET_FEE_MAP[clampedPetCount] ?? 0;
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
    petCount: clampedPetCount,
    hasPet: clampedPetCount > 0,
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
 * Calculates a booking quote for a CDS cabin.
 * Pricing: up to 2 guests included; extra guest fee per head per night for guests 3-4.
 * Pet: flat fee per stay. Max 4 guests per cabin.
 *
 * @param {object} params
 * @param {string|Date} params.checkIn
 * @param {string|Date} params.checkOut
 * @param {number}      params.guestCount - 1–4
 * @param {number}      params.petCount   - 0–4
 * @returns {object} Full price breakdown (same shape as calculateQuote)
 */
async function calculateCDSQuote({ checkIn, checkOut, guestCount, petCount }) {
  const inDate  = new Date(checkIn);
  const outDate = new Date(checkOut);

  if (outDate <= inDate) throw new Error('Check-out deve ser após o check-in');

  const nights = Math.round((outDate - inDate) / (1000 * 60 * 60 * 24));
  if (nights < 1) throw new Error('Mínimo de 1 noite');

  const guests       = Math.min(Math.max(1, guestCount), CDS_MAX_GUESTS);
  const extraGuests  = Math.max(0, guests - CDS_BASE_GUEST_LIMIT);
  const clampedPets  = Math.min(Math.max(parseInt(petCount) || 0, 0), 4);

  const { pricePerNight, tier, seasonName } = await getPriceForDate(
    inDate,
    'cds_property_main',
    CDS_TIER_PRICES,
  );

  const baseSubtotal  = pricePerNight * nights;
  const extraGuestFee = extraGuests * CDS_EXTRA_GUEST_RATE * nights;
  const petFee        = clampedPets > 0 ? CDS_PET_FEE : 0;
  const totalAmount   = baseSubtotal + extraGuestFee + petFee;

  const breakdown = [];
  for (let i = 0; i < nights; i++) {
    const night = new Date(inDate);
    night.setDate(night.getDate() + i);
    breakdown.push({ date: night.toISOString().split('T')[0], rate: pricePerNight, tier });
  }

  return {
    nights,
    guestCount: guests,
    extraGuests,
    petCount: clampedPets,
    hasPet: clampedPets > 0,
    baseRatePerNight: pricePerNight,
    tier,
    seasonName,
    baseSubtotal,
    extraGuestFee,
    petFee,
    totalAmount,
    breakdown,
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
    isFlash:      r.isFlash || false,
  }));
}

/**
 * Maps a price to the nearest pricing tier.
 * Uses midpoints between tier defaults as thresholds.
 * LOW ≤ 785 < MID ≤ 950 < HIGH_MID ≤ 1175 < PEAK
 *
 * @param {number|string} price
 * @returns {'LOW'|'MID'|'HIGH_MID'|'PEAK'}
 */
function deriveTierFromPrice(price) {
  const p = Number(price);
  if (p <= 785)  return 'LOW';
  if (p <= 950)  return 'MID';
  if (p <= 1175) return 'HIGH_MID';
  return 'PEAK';
}

function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

module.exports = {
  calculateQuote,
  calculateCDSQuote,
  getPriceForDate,
  getPricingCalendar,
  deriveTierFromPrice,
  TIER_PRICES,
  CDS_TIER_PRICES,
  EXTRA_GUEST_RATE,
  CDS_EXTRA_GUEST_RATE,
  PET_FEE_MAP,
  CDS_PET_FEE,
  BASE_GUEST_LIMIT,
  CDS_BASE_GUEST_LIMIT,
  MAX_GUESTS,
  CDS_MAX_GUESTS,
};
