'use strict';

/**
 * Content analytics helpers.
 *
 * Answers the admin questions:
 *   "How many posts per month? What's the approval rate? Which pillars win?
 *    How long does admin review take? What feedback keywords repeat?"
 *
 * All pure aggregations — given a flat list of posts, return dashboard-ready
 * shapes. The endpoint layer is thin glue (fetch-then-aggregate).
 *
 * Factory pattern lets tests inject a fake prisma without touching ./db.
 */

const APPROVED_STAGES = new Set(['APROVADO', 'PUBLICADO', 'AGENDADO']);
const REJECTED_STAGES = new Set(['REJEITADO', 'AJUSTE_NECESSARIO']);

/** YYYY-MM key for grouping. Stable sort order + UI-friendly. */
function monthKey(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Groups posts by month (createdAt). Returns chronological array so the UI
 * can render a bar chart without re-sorting.
 */
function postsPerMonth(posts) {
  const agg = {};
  for (const p of posts) {
    const k = monthKey(new Date(p.createdAt));
    if (!agg[k]) agg[k] = { month: k, total: 0, approved: 0, rejected: 0 };
    agg[k].total += 1;
    if (APPROVED_STAGES.has(p.stage)) agg[k].approved += 1;
    else if (REJECTED_STAGES.has(p.stage)) agg[k].rejected += 1;
  }
  return Object.values(agg).sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Overall approval rate for a post set. Uses the same approved-stages rule
 * as the pillar breakdown so numbers reconcile across the dashboard.
 */
function approvalRate(posts) {
  if (posts.length === 0) return { approved: 0, total: 0, ratePct: 0 };
  const approved = posts.filter(p => APPROVED_STAGES.has(p.stage)).length;
  return {
    approved,
    total:   posts.length,
    ratePct: Math.round((approved / posts.length) * 1000) / 10,
  };
}

/**
 * Median turnaround time (hours) from createdAt → updatedAt for posts that
 * reached APROVADO/PUBLICADO/AGENDADO. Median, not mean, so a single
 * week-long outlier doesn't poison the number.
 *
 * Returns null when there's no approved post to measure.
 */
function avgTurnaroundHours(posts) {
  const hours = posts
    .filter(p => APPROVED_STAGES.has(p.stage))
    .map(p => {
      const dt = new Date(p.updatedAt).getTime() - new Date(p.createdAt).getTime();
      return dt / (1000 * 60 * 60);
    })
    .filter(h => h >= 0);
  if (hours.length === 0) return null;
  hours.sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length % 2 === 0
    ? (hours[mid - 1] + hours[mid]) / 2
    : hours[mid];
  return Math.round(median * 10) / 10;
}

/**
 * Per-pillar breakdown with approval rate. Pillars with no posts are excluded
 * so a fresh brand doesn't render dozens of empty zero-rows.
 */
function pillarBreakdown(posts) {
  const agg = {};
  for (const p of posts) {
    const key = p.pillar || 'SEM_PILAR';
    if (!agg[key]) agg[key] = { pillar: key, total: 0, approved: 0, rejected: 0 };
    agg[key].total += 1;
    if (APPROVED_STAGES.has(p.stage))      agg[key].approved += 1;
    else if (REJECTED_STAGES.has(p.stage)) agg[key].rejected += 1;
  }
  return Object.values(agg)
    .map(p => ({
      ...p,
      ratePct: p.total > 0 ? Math.round((p.approved / p.total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Recent rejection notes for a "why were posts rejected?" peek. Just a list
 * of the last N notes with title context — keyword clustering is out of scope.
 */
function recentRejectionFeedback(posts, limit = 5) {
  return posts
    .filter(p => REJECTED_STAGES.has(p.stage) && p.feedbackNotes && p.feedbackNotes.trim().length > 0)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map(p => ({
      title:         p.title,
      feedbackNotes: p.feedbackNotes.trim(),
      stage:         p.stage,
      updatedAt:     p.updatedAt,
    }));
}

/**
 * Factory — gives a ready-to-call summarizer bound to a prisma instance.
 * Callers pass `{ brand, days }` and get the full dashboard payload.
 */
function makeContentAnalytics(prisma) {
  return async function contentAnalytics({ brand, days = 90 } = {}) {
    const where = {
      createdAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    };
    if (brand) where.brand = brand;

    const posts = await prisma.contentPost.findMany({
      where,
      select: {
        id:            true,
        pillar:        true,
        stage:         true,
        title:         true,
        feedbackNotes: true,
        createdAt:     true,
        updatedAt:     true,
      },
    });

    return {
      windowDays:         days,
      totalPosts:         posts.length,
      postsPerMonth:      postsPerMonth(posts),
      approvalRate:       approvalRate(posts),
      avgTurnaroundHours: avgTurnaroundHours(posts),
      pillarBreakdown:    pillarBreakdown(posts),
      recentRejectionFeedback: recentRejectionFeedback(posts),
    };
  };
}

module.exports = {
  makeContentAnalytics,
  // Pure helpers exported for tests — faster than exercising the full factory.
  _internals: {
    postsPerMonth,
    approvalRate,
    avgTurnaroundHours,
    pillarBreakdown,
    recentRejectionFeedback,
    APPROVED_STAGES,
    REJECTED_STAGES,
  },
};
