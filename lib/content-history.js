'use strict';

/**
 * Weekly-learning helpers. The content agent uses these to:
 *   1) avoid repeating recent approved titles,
 *   2) steer away from patterns the admin explicitly rejected.
 *
 * Both factories take a Prisma client so unit tests inject a fake without
 * wrestling with vitest's CJS/ESM mocking for the real ./db singleton.
 */

const DEFAULT_DAYS = 30;

function thresholdFromNow(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Factory → `fn({ brand, days? })` → array of titles (strings).
 * Used to tell the Claude prompt "don't write these again".
 */
function makeRecentApprovedTitles(prisma) {
  return async function recentApprovedTitles({ brand, days = DEFAULT_DAYS } = {}) {
    const rows = await prisma.contentPost.findMany({
      where: {
        brand,
        stage:     { in: ['APROVADO', 'PUBLICADO'] },
        updatedAt: { gte: thresholdFromNow(days) },
      },
      select:  { title: true },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(r => r.title).filter(Boolean);
  };
}

/**
 * Factory → `fn({ brand, days? })` → array of { title, feedbackNotes }.
 * Only rows with non-empty feedbackNotes are returned so the agent isn't
 * polluted by "move without comment" rejections.
 */
function makeRecentRejectionsFeedback(prisma) {
  return async function recentRejectionsFeedback({ brand, days = DEFAULT_DAYS } = {}) {
    const rows = await prisma.contentPost.findMany({
      where: {
        brand,
        stage:     { in: ['REJEITADO', 'AJUSTE_NECESSARIO'] },
        updatedAt: { gte: thresholdFromNow(days) },
      },
      select:  { title: true, feedbackNotes: true },
      orderBy: { updatedAt: 'desc' },
    });
    return rows
      .filter(r => r.feedbackNotes && r.feedbackNotes.trim().length > 0)
      .map(r => ({ title: r.title, feedbackNotes: r.feedbackNotes.trim() }));
  };
}

module.exports = { makeRecentApprovedTitles, makeRecentRejectionsFeedback };
