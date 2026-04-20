import { describe, it, expect, beforeEach } from 'vitest';
import backoff from '../lib/ical-backoff.js';

const { shouldSkip, recordRateLimited, recordSuccess, _reset } = backoff;

describe('iCal backoff (429 cooldown)', () => {
  beforeEach(() => _reset());

  it('does not skip when no 429 has been recorded', () => {
    expect(shouldSkip('AIRBNB')).toBe(false);
  });

  it('skips the default number of cycles after a 429', () => {
    recordRateLimited('AIRBNB'); // default 4 cycles
    expect(shouldSkip('AIRBNB')).toBe(true);
    expect(shouldSkip('AIRBNB')).toBe(true);
    expect(shouldSkip('AIRBNB')).toBe(true);
    expect(shouldSkip('AIRBNB')).toBe(true);
    expect(shouldSkip('AIRBNB')).toBe(false); // cooldown over
  });

  it('respects a custom cooldown length', () => {
    recordRateLimited('BOOKING_COM', 2);
    expect(shouldSkip('BOOKING_COM')).toBe(true);
    expect(shouldSkip('BOOKING_COM')).toBe(true);
    expect(shouldSkip('BOOKING_COM')).toBe(false);
  });

  it('tracks backoff per-source independently', () => {
    recordRateLimited('AIRBNB', 1);
    expect(shouldSkip('AIRBNB')).toBe(true);
    expect(shouldSkip('BOOKING_COM')).toBe(false); // unaffected
  });

  it('clears cooldown on recordSuccess', () => {
    recordRateLimited('AIRBNB', 3);
    recordSuccess('AIRBNB');
    expect(shouldSkip('AIRBNB')).toBe(false);
  });
});
