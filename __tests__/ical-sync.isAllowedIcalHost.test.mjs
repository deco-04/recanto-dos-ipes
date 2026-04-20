import { describe, it, expect } from 'vitest';
import icalSync from '../lib/ical-sync.js';

const { isAllowedIcalHost } = icalSync;

describe('isAllowedIcalHost (SSRF allowlist)', () => {
  it('accepts whitelisted Airbnb + Booking.com hosts', () => {
    expect(isAllowedIcalHost('https://www.airbnb.com/calendar/ical/abc.ics')).toBe(true);
    expect(isAllowedIcalHost('https://admin.booking.com/hotel/ical/xyz')).toBe(true);
    expect(isAllowedIcalHost('https://ical.booking.com/v1/export.ics')).toBe(true);
  });

  it('rejects malicious lookalike hosts', () => {
    expect(isAllowedIcalHost('https://airbnb.com.evil.com/ical')).toBe(false);
    expect(isAllowedIcalHost('https://fake-airbnb.com/ical')).toBe(false);
    expect(isAllowedIcalHost('http://localhost:3000/ical')).toBe(false);
  });

  it('rejects invalid URLs gracefully without throwing', () => {
    expect(isAllowedIcalHost('not-a-url')).toBe(false);
    expect(isAllowedIcalHost('')).toBe(false);
  });
});
