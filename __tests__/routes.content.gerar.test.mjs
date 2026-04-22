import { describe, it, expect } from 'vitest';
import { slugForBrand, parseGerarBody, validateRejectionFeedback } from '../lib/content-gerar-helpers.js';

// These helpers are extracted from routes/content.js so the route handler
// stays small and the decision logic (which property + which filter) is
// covered without spinning up an Express app in tests.

describe('slugForBrand', () => {
  it('maps each brand to its canonical property slug', () => {
    // Slugs match live production DB (audited 2026-04-20).
    expect(slugForBrand('RDI')).toBe('recanto-dos-ipes');
    expect(slugForBrand('RDS')).toBe('recantos-da-serra');
    expect(slugForBrand('CDS')).toBe('cabanas-da-serra');
  });

  it('returns null for unknown brand (route should 400)', () => {
    expect(slugForBrand('X')).toBeNull();
    expect(slugForBrand('')).toBeNull();
    expect(slugForBrand(null)).toBeNull();
  });
});

describe('parseGerarBody', () => {
  it('defaults to undefined filter + undefined count when body is empty', () => {
    expect(parseGerarBody({})).toEqual({ contentTypes: undefined, count: undefined });
    expect(parseGerarBody(undefined)).toEqual({ contentTypes: undefined, count: undefined });
  });

  it('narrows contentTypes to the valid enum subset only', () => {
    const r = parseGerarBody({ contentTypes: ['BLOG', 'INSTAGRAM_FEED', 'BOGUS'] });
    expect(r.contentTypes).toEqual(['BLOG', 'INSTAGRAM_FEED']);
  });

  it('dedupes repeated contentTypes', () => {
    const r = parseGerarBody({ contentTypes: ['BLOG', 'BLOG'] });
    expect(r.contentTypes).toEqual(['BLOG']);
  });

  it('returns undefined contentTypes when the array is empty or invalid after filtering', () => {
    expect(parseGerarBody({ contentTypes: [] }).contentTypes).toBeUndefined();
    expect(parseGerarBody({ contentTypes: ['NOPE'] }).contentTypes).toBeUndefined();
    expect(parseGerarBody({ contentTypes: 'not-an-array' }).contentTypes).toBeUndefined();
  });

  it('clamps count to [1, 10] integer range', () => {
    expect(parseGerarBody({ count: 0 }).count).toBe(1);
    expect(parseGerarBody({ count: 99 }).count).toBe(10);
    expect(parseGerarBody({ count: 3.7 }).count).toBe(3);
    expect(parseGerarBody({ count: -5 }).count).toBe(1);
  });

  it('leaves count undefined when not a number', () => {
    expect(parseGerarBody({ count: 'five' }).count).toBeUndefined();
    expect(parseGerarBody({ count: null }).count).toBeUndefined();
  });
});

describe('validateRejectionFeedback', () => {
  it('returns null for non-rejection stages regardless of feedback', () => {
    expect(validateRejectionFeedback('APROVADO',  null)).toBeNull();
    expect(validateRejectionFeedback('GERADO',    '')).toBeNull();
    expect(validateRejectionFeedback('PUBLICADO', undefined)).toBeNull();
  });

  it('rejects AJUSTE_NECESSARIO without feedback', () => {
    expect(validateRejectionFeedback('AJUSTE_NECESSARIO', null)).toMatch(/feedbackNotes/);
    expect(validateRejectionFeedback('AJUSTE_NECESSARIO', '')).toMatch(/feedbackNotes/);
    expect(validateRejectionFeedback('AJUSTE_NECESSARIO', '   \n  ')).toMatch(/feedbackNotes/);
  });

  it('rejects REJEITADO without feedback', () => {
    expect(validateRejectionFeedback('REJEITADO', null)).toMatch(/feedbackNotes/);
    expect(validateRejectionFeedback('REJEITADO', '   ')).toMatch(/feedbackNotes/);
  });

  it('accepts AJUSTE_NECESSARIO + REJEITADO when feedback is non-whitespace', () => {
    expect(validateRejectionFeedback('AJUSTE_NECESSARIO', 'add more pool detail')).toBeNull();
    expect(validateRejectionFeedback('REJEITADO',         'wrong angle')).toBeNull();
  });
});
