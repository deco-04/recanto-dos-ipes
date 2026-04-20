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
