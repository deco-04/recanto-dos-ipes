import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { makeComputeOccupancy } = require_('../lib/occupancy.js');

function makeFakePrisma() {
  return {
    cabin:   { count:    vi.fn() },
    booking: { findMany: vi.fn() },
  };
}

describe('computeOccupancy', () => {
  let prisma;
  let computeOccupancy;

  beforeEach(() => {
    prisma = makeFakePrisma();
    computeOccupancy = makeComputeOccupancy(prisma);
  });

  it('excludes isInvoiceAggregate bookings (Sprint T regression pin)', async () => {
    prisma.cabin.count.mockResolvedValue(5);
    prisma.booking.findMany.mockResolvedValue([]);

    await computeOccupancy('prop-rdi', new Date('2026-04-01'), new Date('2026-04-30'));

    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.isInvoiceAggregate).toBe(false);
    expect(where.status).toEqual({ in: ['CONFIRMED', 'COMPLETED'] });
  });

  it('accepts a single property id and normalizes to an array internally', async () => {
    prisma.cabin.count.mockResolvedValue(3);
    prisma.booking.findMany.mockResolvedValue([]);

    await computeOccupancy('prop-rdi', new Date('2026-04-01'), new Date('2026-04-30'));

    expect(prisma.cabin.count).toHaveBeenCalledWith({ where: { propertyId: { in: ['prop-rdi'] } } });
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.propertyId).toEqual({ in: ['prop-rdi'] });
  });

  it('accepts an array of property ids (cross-property ALL scope)', async () => {
    prisma.cabin.count.mockResolvedValue(8);
    prisma.booking.findMany.mockResolvedValue([]);

    await computeOccupancy(['prop-rdi', 'prop-rds'], new Date('2026-04-01'), new Date('2026-04-30'));

    expect(prisma.cabin.count).toHaveBeenCalledWith({ where: { propertyId: { in: ['prop-rdi', 'prop-rds'] } } });
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.propertyId).toEqual({ in: ['prop-rdi', 'prop-rds'] });
  });

  it('sums overlap nights per booking, bounded by the period', async () => {
    prisma.cabin.count.mockResolvedValue(2);
    // 2 cabins × 10 days = 20 total nights
    prisma.booking.findMany.mockResolvedValue([
      // Fully inside the period: 5 nights
      { checkIn: new Date('2026-04-03'), checkOut: new Date('2026-04-08') },
      // Straddles the start: booking 03-30 → 04-02; period starts 04-01 → 1 night counted
      { checkIn: new Date('2026-03-30'), checkOut: new Date('2026-04-02') },
    ]);

    const result = await computeOccupancy('prop-rdi', new Date('2026-04-01'), new Date('2026-04-11'));

    expect(result.totalNights).toBe(20);
    expect(result.occupiedNights).toBe(6);
    expect(result.ratePct).toBe(30);
  });

  it('returns zeros when no cabins exist', async () => {
    prisma.cabin.count.mockResolvedValue(0);
    const result = await computeOccupancy('prop-rdi', new Date('2026-04-01'), new Date('2026-04-30'));
    expect(result).toEqual({ occupiedNights: 0, totalNights: 0, ratePct: 0, propertyCount: 1 });
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });
});
