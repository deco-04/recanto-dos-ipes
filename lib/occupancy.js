'use strict';

const prisma = require('./db');

/**
 * Compute occupancy for a property over a date range.
 * Total nights = days in period × cabin count.
 * Occupied nights = sum of overlap nights for CONFIRMED/COMPLETED bookings.
 *
 * @param {string} propertyId
 * @param {Date}   startDate
 * @param {Date}   endDate
 * @returns {Promise<{ occupiedNights: number, totalNights: number, ratePct: number }>}
 */
async function computeOccupancy(propertyId, startDate, endDate) {
  const cabinCount = await prisma.cabin.count({ where: { propertyId } });
  if (cabinCount === 0) return { occupiedNights: 0, totalNights: 0, ratePct: 0 };

  const days = Math.max(0, Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)));
  const totalNights = days * cabinCount;

  const bookings = await prisma.booking.findMany({
    where: {
      propertyId,
      status: { in: ['CONFIRMED', 'COMPLETED'] },
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
  return { occupiedNights, totalNights, ratePct };
}

module.exports = { computeOccupancy };
