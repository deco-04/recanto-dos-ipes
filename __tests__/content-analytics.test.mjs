import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { makeContentAnalytics, _internals } = require_('../lib/content-analytics.js');

function post({ id, stage, pillar, createdAt, updatedAt, feedbackNotes, title }) {
  return { id, stage, pillar, createdAt, updatedAt, feedbackNotes, title: title ?? `Post ${id}` };
}

describe('content-analytics internals · postsPerMonth', () => {
  it('groups by UTC year-month and preserves chronological order', () => {
    const posts = [
      post({ id: '1', stage: 'APROVADO',   createdAt: new Date('2026-01-15T00:00:00Z') }),
      post({ id: '2', stage: 'APROVADO',   createdAt: new Date('2026-01-22T00:00:00Z') }),
      post({ id: '3', stage: 'REJEITADO',  createdAt: new Date('2026-02-02T00:00:00Z') }),
      post({ id: '4', stage: 'GERADO',     createdAt: new Date('2026-02-20T00:00:00Z') }),
    ];
    const r = _internals.postsPerMonth(posts);
    expect(r).toEqual([
      { month: '2026-01', total: 2, approved: 2, rejected: 0 },
      { month: '2026-02', total: 2, approved: 0, rejected: 1 },
    ]);
  });

  it('counts AGENDADO + PUBLICADO as approved', () => {
    const posts = [
      post({ id: '1', stage: 'AGENDADO',  createdAt: new Date('2026-03-01T00:00:00Z') }),
      post({ id: '2', stage: 'PUBLICADO', createdAt: new Date('2026-03-05T00:00:00Z') }),
    ];
    const r = _internals.postsPerMonth(posts);
    expect(r[0].approved).toBe(2);
  });
});

describe('content-analytics internals · approvalRate', () => {
  it('returns 0/0/0 on empty input', () => {
    expect(_internals.approvalRate([])).toEqual({ approved: 0, total: 0, ratePct: 0 });
  });

  it('computes rate across approved / total, one-decimal percent', () => {
    const posts = [
      post({ id: '1', stage: 'APROVADO',          createdAt: new Date() }),
      post({ id: '2', stage: 'PUBLICADO',         createdAt: new Date() }),
      post({ id: '3', stage: 'AGENDADO',          createdAt: new Date() }),
      post({ id: '4', stage: 'REJEITADO',         createdAt: new Date() }),
      post({ id: '5', stage: 'GERADO',            createdAt: new Date() }),
      post({ id: '6', stage: 'AJUSTE_NECESSARIO', createdAt: new Date() }),
    ];
    const r = _internals.approvalRate(posts);
    expect(r.approved).toBe(3);
    expect(r.total).toBe(6);
    expect(r.ratePct).toBe(50);
  });
});

describe('content-analytics internals · avgTurnaroundHours (median)', () => {
  it('returns null when there are no approved posts', () => {
    expect(_internals.avgTurnaroundHours([
      post({ id: '1', stage: 'REJEITADO', createdAt: new Date(), updatedAt: new Date() }),
    ])).toBeNull();
  });

  it('is a MEDIAN not a mean (rejects outlier poisoning)', () => {
    // 3 approved posts: 1h, 2h, 100h. Mean=34.3, median=2.
    const base = new Date('2026-03-01T00:00:00Z');
    const posts = [
      post({ id: '1', stage: 'APROVADO', createdAt: base, updatedAt: new Date(base.getTime() + 1 * 3600_000) }),
      post({ id: '2', stage: 'APROVADO', createdAt: base, updatedAt: new Date(base.getTime() + 2 * 3600_000) }),
      post({ id: '3', stage: 'APROVADO', createdAt: base, updatedAt: new Date(base.getTime() + 100 * 3600_000) }),
    ];
    expect(_internals.avgTurnaroundHours(posts)).toBe(2);
  });

  it('averages middle two on even-length input', () => {
    const base = new Date('2026-03-01T00:00:00Z');
    const mk = h => post({ id: `${h}`, stage: 'APROVADO', createdAt: base, updatedAt: new Date(base.getTime() + h * 3600_000) });
    expect(_internals.avgTurnaroundHours([mk(2), mk(4), mk(6), mk(8)])).toBe(5);
  });
});

describe('content-analytics internals · pillarBreakdown', () => {
  it('sorts by total desc and attaches ratePct per pillar', () => {
    const posts = [
      post({ id: '1', stage: 'APROVADO',   pillar: 'DESTINO',     createdAt: new Date() }),
      post({ id: '2', stage: 'APROVADO',   pillar: 'DESTINO',     createdAt: new Date() }),
      post({ id: '3', stage: 'REJEITADO',  pillar: 'DESTINO',     createdAt: new Date() }),
      post({ id: '4', stage: 'APROVADO',   pillar: 'EXPERIENCIA', createdAt: new Date() }),
    ];
    const r = _internals.pillarBreakdown(posts);
    expect(r[0].pillar).toBe('DESTINO');
    expect(r[0].total).toBe(3);
    expect(r[0].ratePct).toBeCloseTo(66.7, 1);
    expect(r[1].pillar).toBe('EXPERIENCIA');
    expect(r[1].ratePct).toBe(100);
  });

  it('buckets null pillars under SEM_PILAR', () => {
    const posts = [
      post({ id: '1', stage: 'APROVADO',  pillar: null, createdAt: new Date() }),
    ];
    const r = _internals.pillarBreakdown(posts);
    expect(r[0].pillar).toBe('SEM_PILAR');
  });
});

describe('content-analytics internals · recentRejectionFeedback', () => {
  it('only returns rejected/adjustment stages with non-empty feedback, newest first', () => {
    const posts = [
      post({ id: '1', stage: 'APROVADO',   createdAt: new Date(), updatedAt: new Date('2026-03-10'), feedbackNotes: null,    title: 'A' }),
      post({ id: '2', stage: 'REJEITADO',  createdAt: new Date(), updatedAt: new Date('2026-03-01'), feedbackNotes: 'old',   title: 'Old rejection' }),
      post({ id: '3', stage: 'REJEITADO',  createdAt: new Date(), updatedAt: new Date('2026-03-15'), feedbackNotes: 'new',   title: 'New rejection' }),
      post({ id: '4', stage: 'REJEITADO',  createdAt: new Date(), updatedAt: new Date('2026-03-20'), feedbackNotes: '   ',   title: 'Whitespace only' }),
    ];
    const r = _internals.recentRejectionFeedback(posts, 10);
    expect(r.map(x => x.title)).toEqual(['New rejection', 'Old rejection']);
  });

  it('respects the limit', () => {
    const posts = Array.from({ length: 10 }, (_, i) => post({
      id: `${i}`, stage: 'REJEITADO', createdAt: new Date(),
      updatedAt: new Date(Date.now() - i * 1000), feedbackNotes: `f-${i}`, title: `T-${i}`,
    }));
    expect(_internals.recentRejectionFeedback(posts, 3)).toHaveLength(3);
  });
});

describe('makeContentAnalytics factory', () => {
  it('queries prisma with the expected window + brand filter', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const fake = { contentPost: { findMany } };
    const fn = makeContentAnalytics(fake);
    await fn({ brand: 'RDI', days: 30 });

    const where = findMany.mock.calls[0][0].where;
    expect(where.brand).toBe('RDI');
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('omits brand when not provided (cross-brand totals)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const fake = { contentPost: { findMany } };
    const fn = makeContentAnalytics(fake);
    await fn({});

    const where = findMany.mock.calls[0][0].where;
    expect(where.brand).toBeUndefined();
  });

  it('aggregates across helpers (smoke test — exact shape)', async () => {
    const base = new Date('2026-03-01T00:00:00Z');
    const posts = [
      post({ id: '1', stage: 'APROVADO',   pillar: 'DESTINO',     createdAt: base, updatedAt: new Date(base.getTime() + 3600_000) }),
      post({ id: '2', stage: 'REJEITADO',  pillar: 'DESTINO',     createdAt: base, updatedAt: base, feedbackNotes: 'tone off' }),
    ];
    const fake = { contentPost: { findMany: vi.fn().mockResolvedValue(posts) } };
    const fn = makeContentAnalytics(fake);
    const r = await fn({ brand: 'RDI', days: 30 });

    expect(r.totalPosts).toBe(2);
    expect(r.approvalRate).toEqual({ approved: 1, total: 2, ratePct: 50 });
    expect(r.avgTurnaroundHours).toBe(1);
    expect(r.pillarBreakdown[0].pillar).toBe('DESTINO');
    expect(r.recentRejectionFeedback[0].feedbackNotes).toBe('tone off');
  });
});
