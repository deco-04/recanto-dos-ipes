import { describe, it, expect } from 'vitest';
import icalSync from '../lib/ical-sync.js';

const { parseGuestName, extractBlockedDates } = icalSync;

describe('parseGuestName', () => {
  it('extracts name + initial from Airbnb format', () => {
    expect(parseGuestName('Maria S. (ABC123XYZ)', 'AIRBNB')).toBe('Maria S.');
    expect(parseGuestName('João P. (HMABCD1234)', 'AIRBNB')).toBe('João P.');
  });

  it('returns null for Booking.com hold events (skip signal)', () => {
    expect(parseGuestName('CLOSED - Not available', 'BOOKING_COM')).toBeNull();
    expect(parseGuestName('Not available', 'BOOKING_COM')).toBeNull();
    expect(parseGuestName('blocked', 'BOOKING_COM')).toBeNull();
  });

  it('falls back to source label when summary is empty', () => {
    expect(parseGuestName('', 'AIRBNB')).toBe('Hóspede Airbnb');
    expect(parseGuestName(null, 'BOOKING_COM')).toBe('Hóspede Booking.com');
  });

  it('trims and returns raw summary when no Airbnb pattern matches', () => {
    expect(parseGuestName('  Reserva Direta  ', 'BOOKING_COM')).toBe('Reserva Direta');
  });
});

describe('extractBlockedDates', () => {
  it('returns one ISO date per night of a 3-night stay', () => {
    const parsed = {
      e1: {
        type: 'VEVENT',
        start: new Date('2026-05-10T12:00:00Z'),
        end:   new Date('2026-05-13T12:00:00Z'),
      },
    };
    const dates = extractBlockedDates(parsed);
    expect([...dates].sort()).toEqual(['2026-05-10', '2026-05-11', '2026-05-12']);
  });

  it('skips non-VEVENT entries', () => {
    const parsed = {
      meta: { type: 'VCALENDAR' },
      ev:   { type: 'VEVENT', start: new Date('2026-06-01T12:00:00Z'), end: new Date('2026-06-02T12:00:00Z') },
    };
    expect(extractBlockedDates(parsed).size).toBe(1);
  });

  it('handles a single-night stay (start === end - 1 day)', () => {
    const parsed = {
      e: {
        type: 'VEVENT',
        start: new Date('2026-07-01T12:00:00Z'),
        end:   new Date('2026-07-02T12:00:00Z'),
      },
    };
    expect([...extractBlockedDates(parsed)]).toEqual(['2026-07-01']);
  });
});
