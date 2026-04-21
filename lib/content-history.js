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

/**
 * Factory → `fn({ brand, days? })` → array of { pillar, approved, rejected, approvalRate }
 * sorted by approvalRate desc. Used by the weekly agent to prioritise pillars
 * the admin has consistently approved — acts as a proxy for "what performs
 * well" until we pipe real engagement numbers back from GHL (Sprint D follow-up).
 *
 * Pillars with fewer than MIN_SAMPLE posts are excluded so a single approval
 * doesn't ratchet a pillar to the top.
 */
function makeTopPerformingPillars(prisma) {
  const MIN_SAMPLE = 3;
  return async function topPerformingPillars({ brand, days = 60 } = {}) {
    const rows = await prisma.contentPost.findMany({
      where: {
        brand,
        pillar:    { not: null },
        createdAt: { gte: thresholdFromNow(days) },
      },
      select:  { pillar: true, stage: true },
    });

    const agg = {};
    for (const r of rows) {
      if (!r.pillar) continue;
      if (!agg[r.pillar]) agg[r.pillar] = { approved: 0, rejected: 0, total: 0 };
      agg[r.pillar].total += 1;
      if (r.stage === 'APROVADO' || r.stage === 'PUBLICADO' || r.stage === 'AGENDADO') {
        agg[r.pillar].approved += 1;
      } else if (r.stage === 'REJEITADO' || r.stage === 'AJUSTE_NECESSARIO') {
        agg[r.pillar].rejected += 1;
      }
    }

    return Object.entries(agg)
      .filter(([, v]) => v.total >= MIN_SAMPLE)
      .map(([pillar, v]) => ({
        pillar,
        approved:      v.approved,
        rejected:      v.rejected,
        total:         v.total,
        approvalRate:  v.total > 0 ? Math.round((v.approved / v.total) * 100) : 0,
      }))
      .sort((a, b) => b.approvalRate - a.approvalRate);
  };
}

module.exports = {
  makeRecentApprovedTitles,
  makeRecentRejectionsFeedback,
  makeTopPerformingPillars,
};
