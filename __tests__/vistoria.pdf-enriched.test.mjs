import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

// Pin the enriched vistoria-PDF contract (2026-04-21):
//
//   GET /api/staff/vistorias/:id/pdf
//
// The PDF is now a consolidated guest-stay document and includes three
// sections BEFORE the checklist/photos/signature:
//   A — Booking header (guest, property, dates, nights, guest count, pet)
//   B — Financial summary (total, daily rate, commission, upsells, net)
//   C — Contact info (masked phone + email)
//
// The pure helpers that produce masked/formatted strings are exported as
// staff-portal._vistoriaPdfInternals — we test those directly. The full
// streaming render is integration-level (pdfkit + prisma) and is verified
// by hand in dev; locking the helpers here is enough to catch regressions
// in the user-visible output.

const require_ = createRequire(import.meta.url);
const mod = require_('../routes/staff-portal.js');
const { maskEmail, maskPhone, sourceLabel, fmtBRL } = mod._vistoriaPdfInternals;

describe('vistoria PDF · masking helpers', () => {
  describe('maskEmail', () => {
    it('keeps the first char + domain, masks the rest of the local part', () => {
      expect(maskEmail('joao.silva@gmail.com')).toBe('j***@gmail.com');
      expect(maskEmail('andre@scalewithgos.com')).toBe('a***@scalewithgos.com');
    });
    it('is defensive against empty/malformed input', () => {
      expect(maskEmail('')).toBe('');
      expect(maskEmail(null)).toBe('');
      expect(maskEmail('noatsign')).toBe('noatsign');
    });
  });

  describe('maskPhone', () => {
    it('formats a Brazilian E.164 number with area code + last 4 visible', () => {
      expect(maskPhone('+5531987654321')).toBe('+55 (31) *****-4321');
      expect(maskPhone('5531987654321')).toBe('+55 (31) *****-4321');
    });
    it('falls back for non-BR numbers and returns the original on short input', () => {
      expect(maskPhone('12345')).toBe('12345');
      expect(maskPhone('')).toBe('');
      // 10-digit US number (no BR prefix) takes the generic fallback.
      expect(maskPhone('14155551234')).toBe('14 *****-1234');
    });
  });

  describe('sourceLabel', () => {
    it('maps enum values to guest-facing labels', () => {
      expect(sourceLabel('AIRBNB')).toBe('AIRBNB');
      expect(sourceLabel('BOOKING_COM')).toBe('BOOKING.COM');
      expect(sourceLabel('DIRECT')).toBe('DIRETO');
      expect(sourceLabel(undefined)).toBe('DIRETO');
    });
  });

  describe('fmtBRL', () => {
    it('formats numbers as Brazilian currency', () => {
      // Narrow no-break space + regular space variants across Node/ICU builds
      // — normalize spaces before asserting.
      const normalize = (s) => s.replace(/\s/g, ' ');
      expect(normalize(fmtBRL(1250.5))).toBe('R$ 1.250,50');
      expect(normalize(fmtBRL(0))).toBe('R$ 0,00');
      expect(normalize(fmtBRL(null))).toBe('R$ 0,00');
    });
  });
});
