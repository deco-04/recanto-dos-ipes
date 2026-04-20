'use strict';

/**
 * Pure helpers for the /conteudo/gerar-agora/:brand route.
 * Extracted so the decision logic (which property, which filters) can be
 * unit-tested without booting Express or Prisma.
 */

const BRAND_TO_SLUG = {
  RDI: 'sitio-recanto-ipes',
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
