'use strict';

const crypto = require('crypto');
const prisma = require('./db');

const RDS_PUBLIC_URL = process.env.RDS_PUBLIC_URL || 'https://recantosdaserra.com';
const RDS_SYNC_SECRET = process.env.RDS_SYNC_SECRET;

// Map SRI property slugs → RDS property slugs.
// SRI runs the staff backend for ALL properties; RDS only handles its own.
// Adjust this map based on actual property slugs in each repo.
const PROPERTY_SLUG_MAP = {
  'sitio': 'sitio',
  // Add more mappings as SRI properties become RDS-syncable (e.g. RDS, CDS)
};

function signPayload(payload) {
  return crypto.createHmac('sha256', RDS_SYNC_SECRET).update(payload).digest('hex');
}

/**
 * Push current SeasonalPricing for all mapped properties to the RDS website.
 * @returns {Promise<{ pushed: number, errors: number }>}
 */
async function pushPricingToRds() {
  if (!RDS_SYNC_SECRET) {
    console.warn('[sync-rds] RDS_SYNC_SECRET not configured — skipping');
    return { pushed: 0, errors: 0 };
  }
  let pushed = 0, errors = 0;
  for (const [sriSlug, rdsSlug] of Object.entries(PROPERTY_SLUG_MAP)) {
    try {
      const property = await prisma.property.findUnique({ where: { slug: sriSlug } });
      if (!property) {
        console.log(`[sync-rds] property ${sriSlug} not found — skipping`);
        continue;
      }
      const pricing = await prisma.seasonalPricing.findMany({
        where: { propertyId: property.id, endDate: { gte: new Date() } },
      });
      const payload = JSON.stringify({
        propertySlug: rdsSlug,
        pricing: pricing.map(p => ({
          name:          p.name,
          tier:          p.tier,
          startDate:     p.startDate.toISOString().slice(0, 10),
          endDate:       p.endDate.toISOString().slice(0, 10),
          pricePerNight: Number(p.pricePerNight),
          minNights:     p.minNights,
          isFlash:       p.isFlash,
        })),
      });
      const signature = signPayload(payload);
      const res = await fetch(`${RDS_PUBLIC_URL}/api/internal/seasonal-pricing/sync`, {
        method:  'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Sync-Signature': signature,
        },
        body: payload,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[sync-rds] ${rdsSlug} → HTTP ${res.status} ${text.slice(0, 200)}`);
        errors++;
      } else {
        pushed++;
      }
    } catch (err) {
      console.error(`[sync-rds] ${sriSlug} sync failed:`, err.message);
      errors++;
    }
  }
  console.log(`[sync-rds] Pushed ${pushed} property pricing payloads (${errors} errors)`);
  return { pushed, errors };
}

module.exports = { pushPricingToRds };
