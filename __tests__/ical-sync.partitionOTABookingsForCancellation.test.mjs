// Tests for the iCal cancellation filter shipped 2026-04-30 to fix the
// "Roberta Magalhães auto-revert" bug.
//
// User report:
//   "Roberta Magalhães 04/06-07/06 está voltando para o status 'cancelada'
//    automaticamente, mesmo eu alterando para o status de confirmada por
//    diversas vezes"
//
// Mechanism that broke things: every hour, the iCal sync looked at OTA
// bookings whose UID was missing from the feed and force-cancelled them.
// Booking.com / Airbnb feeds occasionally drop a UID (rate limits, upstream
// cancellation reversals, timezone edge cases) so the admin's manual
// re-confirmation got blown away on the next cron tick.
//
// Fix: Booking.statusManuallyOverriddenAt is stamped on PATCH /reservas/:id
// when an admin changes status. The cancellation filter now skips bookings
// whose override timestamp is within the manual-override window (30 days).
//
// These tests pin the partitioning logic in isolation — no DB, no Express,
// no fetch. Pure function with explicit time injection so the cases are
// deterministic across timezones and CI clocks.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const __filename      = fileURLToPath(import.meta.url);
const __dirname       = path.dirname(__filename);
const projectRoot     = path.resolve(__dirname, '..');
const requireFromHere = createRequire(import.meta.url);

const {
  partitionOTABookingsForCancellation,
  MANUAL_OVERRIDE_WINDOW_MS,
  CANCELLATION_NOTIFICATION_WINDOW_MS,
} = requireFromHere(path.join(projectRoot, 'lib/ical-sync.js'));

const NOW = new Date('2026-06-15T12:00:00.000Z');

function bookingFixture(overrides = {}) {
  return {
    id:                          'b1',
    externalId:                  'uid-1',
    status:                      'CONFIRMED',
    checkIn:                     new Date('2026-07-01'),
    checkOut:                    new Date('2026-07-05'),
    lastCancellationNotifiedAt:  null,
    statusManuallyOverriddenAt:  null,
    ...overrides,
  };
}

describe('partitionOTABookingsForCancellation', () => {
  describe('base eligibility', () => {
    it('cancels CONFIRMED bookings whose UID is missing from the feed and checkout is future', () => {
      const b = bookingFixture();
      const { toCancel, protectedByOverride } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),  // UID gone from feed
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(1);
      expect(toCancel[0].id).toBe('b1');
      expect(protectedByOverride).toHaveLength(0);
    });

    it('leaves CONFIRMED bookings still in the feed alone', () => {
      const b = bookingFixture();
      const { toCancel } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(['uid-1']),  // still present
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(0);
    });

    it('leaves CANCELLED bookings alone (no double-cancel)', () => {
      const b = bookingFixture({ status: 'CANCELLED' });
      const { toCancel } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(0);
    });

    it('leaves past-checkout bookings alone (revenue integrity)', () => {
      // Past stays naturally age off the feed after checkout — cancelling
      // them would corrupt historical revenue reporting.
      const b = bookingFixture({
        checkOut: new Date('2026-05-01'),  // before NOW
      });
      const { toCancel } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(0);
    });
  });

  describe('cancellation dedupe window', () => {
    it('skips bookings already notified within the dedupe window', () => {
      const b = bookingFixture({
        lastCancellationNotifiedAt: new Date(NOW.getTime() - 60 * 60 * 1000),  // 1h ago
      });
      const { toCancel } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(0);
    });

    it('re-cancels bookings whose dedupe window has expired', () => {
      const b = bookingFixture({
        lastCancellationNotifiedAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),  // 2 days ago
      });
      const { toCancel } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(1);
    });
  });

  describe('admin manual-override window — the Roberta-bug fix', () => {
    it('protects a booking whose admin override is recent (within window)', () => {
      // Real scenario: admin re-confirmed Roberta's booking 2h ago via the
      // app. The Booking.com feed STILL doesn't include her UID. Without
      // this guard, the next iCal sync would re-cancel her in 1h.
      const robertaLikeBooking = bookingFixture({
        statusManuallyOverriddenAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),  // 2h ago
      });
      const { toCancel, protectedByOverride } = partitionOTABookingsForCancellation({
        existingOTABookings:        [robertaLikeBooking],
        feedUids:                   new Set(),  // missing from feed
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(0);
      expect(protectedByOverride).toHaveLength(1);
      expect(protectedByOverride[0].id).toBe('b1');
    });

    it('protects a booking overridden 29 days ago (still within window)', () => {
      const b = bookingFixture({
        statusManuallyOverriddenAt: new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000),
      });
      const { toCancel, protectedByOverride } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(0);
      expect(protectedByOverride).toHaveLength(1);
    });

    it('lets a booking be cancelled when override is older than window (31 days ago)', () => {
      // The override is a "recent admin intent" signal, not permanent
      // immunity. After 30 days, the booking falls back to normal feed-
      // driven status — so a long-stale "confirmed but missing" booking
      // still gets cleaned up eventually.
      const b = bookingFixture({
        statusManuallyOverriddenAt: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000),
      });
      const { toCancel, protectedByOverride } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(1);
      expect(protectedByOverride).toHaveLength(0);
    });

    it('null override timestamp does NOT count as "recently overridden"', () => {
      // Defensive: a booking that was never touched by an admin should
      // still be auto-cancelled when missing from the feed (otherwise
      // the new field would block ALL legitimate cancellations).
      const b = bookingFixture({ statusManuallyOverriddenAt: null });
      const { toCancel, protectedByOverride } = partitionOTABookingsForCancellation({
        existingOTABookings:        [b],
        feedUids:                   new Set(),
        now:                        NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel).toHaveLength(1);
      expect(protectedByOverride).toHaveLength(0);
    });
  });

  describe('multi-booking partitioning', () => {
    it('correctly splits a mixed batch across all categories in one pass', () => {
      // Realistic Booking.com sync: 1 still in feed, 1 to cancel, 1 protected
      // by override, 1 already cancelled (skip), 1 in dedupe window (skip).
      const stillInFeed   = bookingFixture({ id: 'still', externalId: 'uid-still' });
      const shouldCancel  = bookingFixture({ id: 'cancel', externalId: 'uid-cancel' });
      const protected1    = bookingFixture({
        id: 'roberta', externalId: 'uid-roberta',
        statusManuallyOverriddenAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      });
      const alreadyCancelled = bookingFixture({
        id: 'old-cancel', externalId: 'uid-oc', status: 'CANCELLED',
      });
      const inDedupe = bookingFixture({
        id: 'recent', externalId: 'uid-recent',
        lastCancellationNotifiedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      });

      const { toCancel, protectedByOverride } = partitionOTABookingsForCancellation({
        existingOTABookings: [stillInFeed, shouldCancel, protected1, alreadyCancelled, inDedupe],
        feedUids:            new Set(['uid-still']),
        now:                 NOW,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });
      expect(toCancel.map(b => b.id)).toEqual(['cancel']);
      expect(protectedByOverride.map(b => b.id)).toEqual(['roberta']);
    });
  });

  describe('production constants', () => {
    it('manual override window is 30 days', () => {
      expect(MANUAL_OVERRIDE_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });

    it('cancellation dedupe window is 24h', () => {
      expect(CANCELLATION_NOTIFICATION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
