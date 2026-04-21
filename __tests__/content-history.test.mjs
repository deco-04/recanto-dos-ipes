import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeRecentApprovedTitles,
  makeRecentRejectionsFeedback,
  makeTopPerformingPillars,
} from '../lib/content-history.js';

function makeFakePrisma(rows) {
  return {
    contentPost: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
}

describe('recentApprovedTitles', () => {
  let prisma, fn;

  beforeEach(() => {
    prisma = makeFakePrisma([
      { title: 'Post A', stage: 'APROVADO',  contentType: 'BLOG', updatedAt: new Date('2026-04-10') },
      { title: 'Post B', stage: 'PUBLICADO', contentType: 'BLOG', updatedAt: new Date('2026-04-05') },
    ]);
    fn = makeRecentApprovedTitles(prisma);
  });

  it('filters by brand + APROVADO/PUBLICADO + 30-day window', async () => {
    const titles = await fn({ brand: 'RDI' });
    expect(titles).toEqual(['Post A', 'Post B']);

    const args = prisma.contentPost.findMany.mock.calls[0][0];
    expect(args.where.brand).toBe('RDI');
    expect(args.where.stage.in).toEqual(['APROVADO', 'PUBLICADO']);
    // date threshold should be ~30d ago
    expect(args.where.updatedAt.gte).toBeInstanceOf(Date);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const diff = Date.now() - args.where.updatedAt.gte.getTime();
    expect(diff).toBeGreaterThan(thirtyDaysMs - 1000); // ~30d
    expect(diff).toBeLessThan(thirtyDaysMs + 1000);
  });

  it('accepts a custom days window', async () => {
    await fn({ brand: 'RDS', days: 7 });
    const args = prisma.contentPost.findMany.mock.calls[0][0];
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const diff = Date.now() - args.where.updatedAt.gte.getTime();
    expect(diff).toBeGreaterThan(sevenDaysMs - 1000);
    expect(diff).toBeLessThan(sevenDaysMs + 1000);
  });

  it('returns [] on empty result', async () => {
    prisma = makeFakePrisma([]);
    fn = makeRecentApprovedTitles(prisma);
    expect(await fn({ brand: 'RDI' })).toEqual([]);
  });
});

describe('recentRejectionsFeedback', () => {
  it('filters by brand + REJEITADO/AJUSTE_NECESSARIO, returns title + feedbackNotes pairs', async () => {
    const prisma = makeFakePrisma([
      { title: 'Too generic',   feedbackNotes: 'muito clichê', stage: 'REJEITADO',          updatedAt: new Date() },
      { title: 'Wrong season',  feedbackNotes: 'já é inverno',  stage: 'AJUSTE_NECESSARIO',  updatedAt: new Date() },
      { title: 'Missing notes', feedbackNotes: null,            stage: 'REJEITADO',          updatedAt: new Date() },
    ]);
    const fn = makeRecentRejectionsFeedback(prisma);

    const result = await fn({ brand: 'RDI', days: 30 });

    expect(result).toEqual([
      { title: 'Too generic',  feedbackNotes: 'muito clichê' },
      { title: 'Wrong season', feedbackNotes: 'já é inverno' },
    ]);

    const args = prisma.contentPost.findMany.mock.calls[0][0];
    expect(args.where.brand).toBe('RDI');
    expect(args.where.stage.in).toEqual(['REJEITADO', 'AJUSTE_NECESSARIO']);
    // Only rows with non-empty feedbackNotes should be returned (filter applied in code, not query)
  });

  it('skips rows with empty/null feedbackNotes so the agent isn\'t polluted by noise', async () => {
    const prisma = makeFakePrisma([
      { title: 'A', feedbackNotes: '',    stage: 'REJEITADO', updatedAt: new Date() },
      { title: 'B', feedbackNotes: '   ', stage: 'REJEITADO', updatedAt: new Date() },
      { title: 'C', feedbackNotes: null,  stage: 'REJEITADO', updatedAt: new Date() },
    ]);
    const fn = makeRecentRejectionsFeedback(prisma);
    expect(await fn({ brand: 'RDI' })).toEqual([]);
  });
});

describe('topPerformingPillars', () => {
  it('returns pillars sorted by approvalRate desc, with approved/rejected/total counts', async () => {
    const prisma = makeFakePrisma([
      // DESTINO: 3/4 approved (75%)
      { pillar: 'DESTINO',     stage: 'APROVADO' },
      { pillar: 'DESTINO',     stage: 'PUBLICADO' },
      { pillar: 'DESTINO',     stage: 'AGENDADO' },
      { pillar: 'DESTINO',     stage: 'REJEITADO' },
      // EXPERIENCIA: 1/3 approved (33%)
      { pillar: 'EXPERIENCIA', stage: 'APROVADO' },
      { pillar: 'EXPERIENCIA', stage: 'AJUSTE_NECESSARIO' },
      { pillar: 'EXPERIENCIA', stage: 'GERADO' },
      // BASTIDORES: 3/3 approved (100%) — highest rate
      { pillar: 'BASTIDORES',  stage: 'APROVADO' },
      { pillar: 'BASTIDORES',  stage: 'APROVADO' },
      { pillar: 'BASTIDORES',  stage: 'APROVADO' },
    ]);
    const fn = makeTopPerformingPillars(prisma);
    const r = await fn({ brand: 'RDI' });
    expect(r.map(p => p.pillar)).toEqual(['BASTIDORES', 'DESTINO', 'EXPERIENCIA']);
    expect(r[0]).toEqual({ pillar: 'BASTIDORES', approved: 3, rejected: 0, total: 3, approvalRate: 100 });
    expect(r[1].approvalRate).toBe(75);
  });

  it('excludes pillars with fewer than 3 samples (noise floor)', async () => {
    const prisma = makeFakePrisma([
      // Two approved posts — not enough signal.
      { pillar: 'PROVA_SOCIAL', stage: 'APROVADO' },
      { pillar: 'PROVA_SOCIAL', stage: 'APROVADO' },
      // Eligible pillar.
      { pillar: 'DESTINO', stage: 'APROVADO' },
      { pillar: 'DESTINO', stage: 'APROVADO' },
      { pillar: 'DESTINO', stage: 'GERADO' },
    ]);
    const fn = makeTopPerformingPillars(prisma);
    const r = await fn({ brand: 'RDI' });
    expect(r.map(p => p.pillar)).toEqual(['DESTINO']);
  });

  it('queries prisma with the expected where clause (default 60 days, pillar not null)', async () => {
    const prisma = makeFakePrisma([]);
    const fn = makeTopPerformingPillars(prisma);
    await fn({ brand: 'RDI' });

    const where = prisma.contentPost.findMany.mock.calls[0][0].where;
    expect(where.brand).toBe('RDI');
    expect(where.pillar).toEqual({ not: null });
    // Default 60 days — threshold is ~60d ago, give a day of slack for test timing.
    const diffDays = (Date.now() - where.createdAt.gte.getTime()) / 86400_000;
    expect(diffDays).toBeGreaterThan(59);
    expect(diffDays).toBeLessThan(61);
  });
});
