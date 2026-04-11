'use strict';

const express = require('express');
const router  = express.Router();
const { getPricingCalendar, TIER_PRICES, EXTRA_GUEST_RATE, PET_FEE, BASE_GUEST_LIMIT, MAX_GUESTS } = require('../lib/pricing');

// GET /api/pricing/calendar
// Returns all future seasonal pricing periods (used by the calendar widget to color dates)
router.get('/calendar', async (_req, res) => {
  try {
    const periods = await getPricingCalendar();
    res.json({ periods });
  } catch (err) {
    console.error('[pricing] calendar error:', err);
    res.status(500).json({ error: 'Erro ao carregar calendário de preços' });
  }
});

// GET /api/pricing/tiers
// Returns tier definitions (static reference for UI labels)
router.get('/tiers', (_req, res) => {
  res.json({
    tiers: [
      { tier: 'LOW',      label: 'Baixa temporada',  price: TIER_PRICES.LOW },
      { tier: 'MID',      label: 'Feriado',           price: TIER_PRICES.MID },
      { tier: 'HIGH_MID', label: 'Alta temporada',    price: TIER_PRICES.HIGH_MID },
      { tier: 'PEAK',     label: 'Temporada máxima',  price: TIER_PRICES.PEAK },
    ],
    extraGuestRate:  EXTRA_GUEST_RATE,
    petFee:          PET_FEE,
    baseGuestLimit:  BASE_GUEST_LIMIT,
    maxGuests:       MAX_GUESTS,
  });
});

module.exports = router;
