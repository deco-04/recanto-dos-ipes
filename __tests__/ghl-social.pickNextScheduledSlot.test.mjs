import { describe, it, expect } from 'vitest';
import { pickNextScheduledSlot } from '../lib/ghl-social.js';

// Reference clock: Wed 2026-04-22 09:00 UTC. Picked deliberately so most cases
// land on the same week without time-zone or DST edge-case noise.
const NOW = new Date(Date.UTC(2026, 3, 22, 9, 0, 0)); // April is month=3 (0-based)

describe('pickNextScheduledSlot', () => {
  it('returns null when postingSchedule is missing or empty', () => {
    expect(pickNextScheduledSlot(null, 'INSTAGRAM_FEED', NOW)).toBeNull();
    expect(pickNextScheduledSlot({}, 'INSTAGRAM_FEED', NOW)).toBeNull();
    expect(pickNextScheduledSlot({ INSTAGRAM_FEED: [] }, 'INSTAGRAM_FEED', NOW)).toBeNull();
  });

  it('returns null when contentType has no slot list', () => {
    const cfg = { INSTAGRAM_FEED: ['mon 10:00'] };
    expect(pickNextScheduledSlot(cfg, 'BLOG', NOW)).toBeNull();
  });

  it('picks the soonest future slot from the list', () => {
    // Wed 09:00 → next Wed 14:00 (today, 5h later) beats Fri 09:00.
    const cfg = { INSTAGRAM_FEED: ['mon 10:00', 'wed 14:00', 'fri 09:00'] };
    const out = pickNextScheduledSlot(cfg, 'INSTAGRAM_FEED', NOW);
    expect(out.toISOString()).toBe('2026-04-22T14:00:00.000Z');
  });

  it('rolls a slot whose time has already passed today to next week', () => {
    // Wed 09:00 → "wed 08:00" already passed → push to following Wed.
    const cfg = { INSTAGRAM_FEED: ['wed 08:00'] };
    const out = pickNextScheduledSlot(cfg, 'INSTAGRAM_FEED', NOW);
    expect(out.toISOString()).toBe('2026-04-29T08:00:00.000Z');
  });

  it('skips malformed entries silently', () => {
    const cfg = { INSTAGRAM_FEED: ['garbage', 'mon 25:00', 123, 'fri 09:00'] };
    const out = pickNextScheduledSlot(cfg, 'INSTAGRAM_FEED', NOW);
    // Only fri 09:00 is valid → Fri 2026-04-24 09:00 UTC
    expect(out.toISOString()).toBe('2026-04-24T09:00:00.000Z');
  });

  it('accepts long weekday names case-insensitively', () => {
    const cfg = { INSTAGRAM_FEED: ['Friday 09:00'] };
    const out = pickNextScheduledSlot(cfg, 'INSTAGRAM_FEED', NOW);
    expect(out.toISOString()).toBe('2026-04-24T09:00:00.000Z');
  });
});
