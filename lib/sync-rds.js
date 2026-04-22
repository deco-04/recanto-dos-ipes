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

// Gap #8: brand-code (RDI/RDS/CDS) → rds-website property slug. RDI is the
// only brand publishing blogs today; RDS/CDS are mapped pre-emptively so a
// future content type doesn't silently land under "sitio". Unknown brands
// fall back to "sitio" — same behavior as the previous hardcoded default.
const BRAND_TO_SLUG = {
  RDI: 'sitio',
  RDS: 'recantos-da-serra',
  CDS: 'cabanas-da-serra',
};

/**
 * Push a single published BLOG post from SRI → rds-website Articles table.
 * Fires once per post at the APROVADO/BLOG → PUBLICADO transition. Idempotent
 * on the receiving side (upsert keyed on slug that encodes the SRI post id),
 * so retries on transient failures are safe.
 *
 * The receiving-side property slug is derived from `post.brand` via
 * BRAND_TO_SLUG. An explicit `brandSlug` argument still wins for callers who
 * want to override (e.g. tests, manual republish scripts).
 *
 * @param {object} post - Serialized ContentPost (id, title, body, mediaUrls, pillar, publishedAt, brand)
 * @param {string} [brandSlug] - explicit override for the target slug; auto-derived from post.brand otherwise
 * @returns {Promise<{ok: boolean, slug?: string, status?: number, error?: string}>}
 */
async function pushBlogPostToRds(post, brandSlug) {
  // Resolve slug: explicit arg → brand-derived → "sitio" fallback.
  const resolvedSlug = brandSlug || BRAND_TO_SLUG[post?.brand] || 'sitio';
  if (!RDS_SYNC_SECRET) {
    console.warn('[sync-rds] RDS_SYNC_SECRET not configured — skipping blog push');
    return { ok: false, error: 'not configured' };
  }
  if (!post || !post.id || !post.title || !post.body) {
    console.warn('[sync-rds] pushBlogPostToRds: post missing required fields');
    return { ok: false, error: 'invalid post' };
  }

  const coverImage = Array.isArray(post.mediaUrls) && post.mediaUrls.length > 0
    ? post.mediaUrls[0]
    : null;

  const payload = JSON.stringify({
    externalId:   post.id,
    propertySlug: resolvedSlug,
    title:        post.title,
    body:         post.body,
    coverImage,
    pillar:       post.pillar || null,
    publishedAt:  post.publishedAt ? new Date(post.publishedAt).toISOString() : new Date().toISOString(),
    createdBy:    'vera',
  });

  try {
    const signature = signPayload(payload);
    const res = await fetch(`${RDS_PUBLIC_URL}/api/internal/blog/sync`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Signature': signature },
      body:    payload,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[sync-rds] blog push failed (${res.status}): ${text.slice(0, 200)}`);
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, slug: data.slug };
  } catch (err) {
    console.error('[sync-rds] blog push network error:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { pushPricingToRds, pushBlogPostToRds, BRAND_TO_SLUG };
