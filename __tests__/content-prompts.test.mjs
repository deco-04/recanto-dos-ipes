import { describe, it, expect } from 'vitest';
import {
  buildWeeklySystemPrompt,
  buildWeeklyUserPrompt,
  seasonalHookForMonth,
} from '../lib/content-prompts.js';

describe('buildWeeklySystemPrompt', () => {
  it('includes the DECO 7-pillar framework label', () => {
    const p = buildWeeklySystemPrompt();
    expect(p).toMatch(/EXPERIENCIA|DESTINO|PROVA_SOCIAL|DISPONIBILIDADE|BASTIDORES|BLOG_SEO/);
  });

  it('includes the BLOG SEO structure requirements', () => {
    const p = buildWeeklySystemPrompt();
    // Must reference a long-tail H1, H2 sections, FAQ bullet, and word-count band.
    expect(p).toMatch(/H1/);
    expect(p).toMatch(/H2/);
    expect(p).toMatch(/FAQ/i);
    expect(p).toMatch(/600|900|palavras|words/i);
  });

  it('is in Brazilian Portuguese (system-language directive present)', () => {
    const p = buildWeeklySystemPrompt();
    expect(p).toMatch(/portugu[eê]s|pt-BR/i);
  });
});

describe('buildWeeklyUserPrompt', () => {
  const baseCtx = {
    brand: 'RDI',
    config: {
      voiceNotes:      'Warm, genuine, nature-focused.',
      upcomingThemes:  'family pool weekend',
      pillarMix:       { EXPERIENCIA: 40, DESTINO: 30, BLOG_SEO: 20, BASTIDORES: 10 },
      defaultHashtags: '#JaboticatubasMG #SerraDoCipo',
      postsPerWeek:    5,
    },
    recentTitles:   ['Outono no Sítio', 'Rota de cachoeiras'],
    recentFeedback: [{ title: 'Sunset post', feedbackNotes: 'muito clichê, evitar pôr-do-sol genérico' }],
    seasonalHook:   'outono: temporada de cachoeiras com águas cristalinas',
    propertyTruths: {
      location:      'Jaboticatubas, Minas Gerais',
      distanceFromBH: '60 km de Belo Horizonte',
      amenities:     ['piscina natural', 'churrasqueira', 'trilhas'],
      pricingTiers:  { LOW: 720, MID: 850, HIGH_MID: 1050, PEAK: 1300 },
    },
  };

  it('injects voice notes, upcoming themes, and hashtags', () => {
    const p = buildWeeklyUserPrompt(baseCtx);
    expect(p).toContain('Warm, genuine, nature-focused.');
    expect(p).toContain('family pool weekend');
    expect(p).toContain('#JaboticatubasMG');
  });

  it('injects the seasonal hook', () => {
    const p = buildWeeklyUserPrompt(baseCtx);
    expect(p).toMatch(/cachoeiras com águas cristalinas/);
  });

  it('injects the non-negotiable RDI property truths', () => {
    const p = buildWeeklyUserPrompt(baseCtx);
    expect(p).toContain('Jaboticatubas');
    expect(p).toContain('Belo Horizonte');
    expect(p).toMatch(/piscina natural/);
  });

  it('includes the recent-titles exclusion block', () => {
    const p = buildWeeklyUserPrompt(baseCtx);
    expect(p).toContain('Outono no Sítio');
    expect(p).toMatch(/evitar|não repetir|avoid|exclude/i);
  });

  it('includes the feedback-steer block so the agent learns from past rejections', () => {
    const p = buildWeeklyUserPrompt(baseCtx);
    expect(p).toContain('muito clichê');
  });

  it('respects the contentTypes filter when provided (narrows output)', () => {
    const p = buildWeeklyUserPrompt({ ...baseCtx, contentTypes: ['BLOG'] });
    expect(p).toMatch(/apenas.*BLOG|somente.*BLOG|only.*BLOG/i);
  });

  it('respects the count override when provided', () => {
    const p = buildWeeklyUserPrompt({ ...baseCtx, count: 2 });
    expect(p).toMatch(/\b2\b.*posts?|posts?.*\b2\b/);
  });
});

describe('seasonalHookForMonth', () => {
  it('maps July to winter/high-season in Brazil (férias escolares)', () => {
    // Month is 0-indexed: July = 6
    expect(seasonalHookForMonth(6)).toMatch(/inverno|férias/i);
  });

  it('maps January to summer/peak with Carnaval prep', () => {
    expect(seasonalHookForMonth(0)).toMatch(/verão|carnaval|peak/i);
  });

  it('returns a non-empty string for every month', () => {
    for (let m = 0; m < 12; m++) {
      const hook = seasonalHookForMonth(m);
      expect(typeof hook).toBe('string');
      expect(hook.length).toBeGreaterThan(10);
    }
  });
});

describe('buildWeeklyUserPrompt · topPillars performance block (Sprint D)', () => {
  it('omits the performance block entirely when topPillars is empty', () => {
    const p = buildWeeklyUserPrompt({
      brand:        'RDI',
      config:       { postsPerWeek: 5 },
      seasonalHook: 'hook',
      topPillars:   [],
    });
    expect(p).not.toMatch(/PERFORMANCE RECENTE/);
  });

  it('injects the top pillars list with approvalRate when provided', () => {
    const p = buildWeeklyUserPrompt({
      brand:        'RDI',
      config:       { postsPerWeek: 5 },
      seasonalHook: 'hook',
      topPillars: [
        { pillar: 'DESTINO',     approved: 8, total: 10, approvalRate: 80 },
        { pillar: 'EXPERIENCIA', approved: 4, total: 10, approvalRate: 40 },
      ],
    });
    expect(p).toMatch(/PERFORMANCE RECENTE/);
    expect(p).toContain('DESTINO: 80% aprovados (8/10)');
    expect(p).toContain('EXPERIENCIA: 40% aprovados (4/10)');
    // Must also reinforce that configured mix still wins.
    expect(p).toMatch(/sem violar o mix configurado/);
  });

  it('caps the list at 4 entries so the prompt stays readable', () => {
    const topPillars = [
      { pillar: 'A', approved: 5, total: 5, approvalRate: 100 },
      { pillar: 'B', approved: 4, total: 5, approvalRate: 80 },
      { pillar: 'C', approved: 3, total: 5, approvalRate: 60 },
      { pillar: 'D', approved: 2, total: 5, approvalRate: 40 },
      { pillar: 'E', approved: 1, total: 5, approvalRate: 20 },
    ];
    const p = buildWeeklyUserPrompt({
      brand: 'RDI', config: { postsPerWeek: 5 },
      seasonalHook: 'hook', topPillars,
    });
    expect(p).toMatch(/A: 100%/);
    expect(p).toMatch(/D: 40%/);
    expect(p).not.toMatch(/E: 20%/);
  });
});
