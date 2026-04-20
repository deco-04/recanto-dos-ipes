'use strict';

/**
 * Pure helpers for the /conteudo/gerar-agora/:brand route.
 * Extracted so the decision logic (which property, which filters) can be
 * unit-tested without booting Express or Prisma.
 */

// Production DB uses these exact slugs (audited 2026-04-20 via Railway SSH):
//   RDI → recanto-dos-ipes      (active)  — id cmnvjziwv0000ohgcb3nxbl4j
//   CDS → cabanas-da-serra      (active)  — id cds_property_main
//   RDS → recantos-da-serra     (seeded by scripts/seed-rds-property-and-brand-configs.js)
// A legacy "cabanas" row also exists but points to the same property and is
// effectively shadowed by the canonical cabanas-da-serra slug.
const BRAND_TO_SLUG = {
  RDI: 'recanto-dos-ipes',
  RDS: 'recantos-da-serra',
  CDS: 'cabanas-da-serra',
};

const VALID_CONTENT_TYPES = new Set([
  'INSTAGRAM_FEED',
  'INSTAGRAM_REELS',
  'INSTAGRAM_STORIES',
  'FACEBOOK',
  'BLOG',
  'GBP_POST',
]);

function slugForBrand(brand) {
  if (!brand || typeof brand !== 'string') return null;
  return BRAND_TO_SLUG[brand] || null;
}

function parseGerarBody(body) {
  const b = body || {};

  // contentTypes: narrow to valid enum values, dedupe, return undefined if
  // nothing survives filtering (so the agent falls back to the full mix).
  let contentTypes;
  if (Array.isArray(b.contentTypes)) {
    const filtered = [...new Set(b.contentTypes.filter(v => VALID_CONTENT_TYPES.has(v)))];
    contentTypes = filtered.length ? filtered : undefined;
  } else {
    contentTypes = undefined;
  }

  // count: integer, clamp [1, 10]; undefined when not a number.
  let count;
  if (typeof b.count === 'number' && Number.isFinite(b.count)) {
    count = Math.max(1, Math.min(10, Math.trunc(b.count)));
  } else {
    count = undefined;
  }

  return { contentTypes, count };
}

module.exports = { slugForBrand, parseGerarBody, BRAND_TO_SLUG, VALID_CONTENT_TYPES };
