'use strict';

/**
 * Compute occupancy for one or more properties over a date range.
 * Total nights = days in period × cabin count (across all scoped properties).
 * Occupied nights = sum of overlap nights for CONFIRMED/COMPLETED bookings.
 *
 * CRITICAL: `isInvoiceAggregate: true` bookings are Booking.com monthly payout
 * placeholders — not real guest stays. Including them inflated occupancy by
 * counting phantom nights. See Sprint T audit.
 *
 * Factory pattern mirrors lib/contacts.js so tests can inject a fake Prisma
 * without wrestling with Vitest's CJS/ESM bridge.
 *
 * @param {object} prisma  — prisma client (or compatible fake)
 * @returns {(propertyIds: string|string[], startDate: Date, endDate: Date) => Promise<{ occupiedNights: number, totalNights: number, ratePct: number, propertyCount: number }>}
 */
function makeComputeOccupancy(prisma) {
  return async function computeOccupancy(propertyIds, startDate, endDate) {
    const ids = Array.isArray(propertyIds) ? propertyIds : [propertyIds];
    if (ids.length === 0) return { occupiedNights: 0, totalNights: 0, ratePct: 0, propertyCount: 0 };

    const cabinCount = await prisma.cabin.count({ where: { propertyId: { in: ids } } });
    if (cabinCount === 0) return { occupiedNights: 0, totalNights: 0, ratePct: 0, propertyCount: ids.length };

    const days = Math.max(0, Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)));
    const totalNights = days * cabinCount;

    const bookings = await prisma.booking.findMany({
      where: {
        propertyId: { in: ids },
        status: { in: ['CONFIRMED', 'COMPLETED'] },
        isInvoiceAggregate: false,   // <-- Sprint T fix: skip Booking.com monthly payout placeholders
        checkIn:  { lt: endDate },
        checkOut: { gt: startDate },
      },
      select: { checkIn: true, checkOut: true },
    });

    let occupiedNights = 0;
    for (const b of bookings) {
      const start = b.checkIn  > startDate ? b.checkIn  : startDate;
      const end   = b.checkOut < endDate   ? b.checkOut : endDate;
      const nights = Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
      occupiedNights += nights;
    }

    const ratePct = totalNights > 0 ? Math.round((occupiedNights / totalNights) * 1000) / 10 : 0;
    return { occupiedNights, totalNights, ratePct, propertyCount: ids.length };
  };
}

// Default binding for production callers — keeps the existing import path working.
const prisma = require('./db');
const computeOccupancy = makeComputeOccupancy(prisma);

module.exports = { computeOccupancy, makeComputeOccupancy };
