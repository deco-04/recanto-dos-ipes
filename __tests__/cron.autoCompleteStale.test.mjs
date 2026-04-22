import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-21):
//
//   POST /api/staff/cron/auto-complete-stale-bookings
//
// Defensive cron endpoint that transitions CONFIRMED bookings → COMPLETED
// when their checkout was > 48h ago, regardless of whether a CHECKOUT
// vistoria was ever submitted. This protects against the Governanta
// forgetting to submit the checkout inspection — without it, the booking
// lingers in CONFIRMED forever.
//
// Guards:
//   - Rejects missing/wrong X-Cron-Secret header (401)
//   - Only flips status === 'CONFIRMED' bookings (never touches
//     CANCELLED / REFUNDED / COMPLETED / REQUESTED / PENDING)
//   - Only flips when checkOut < now - 48h
//   - Respects { dryRun: true } — returns candidates without mutating
//   - Returns { transitioned: N, ids: string[] }

process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const cronModule = require_('../routes/cron.js');
const { makeAutoCompleteStaleHandler } = cronModule;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body)   { this.body = body; return this; },
  };
}

function makeStubs({ bookings = [] } = {}) {
  // Each call to findMany({ where }) should only return bookings matching:
  //   status === 'CONFIRMED' AND checkOut < where.checkOut.lt
  return {
    prisma: {
      booking: {
        findMany: vi.fn(async ({ where }) => {
          return bookings.filter((b) =>
            b.status === 'CONFIRMED' && b.checkOut < where.checkOut.lt,
          );
        }),
        update: vi.fn(async ({ where, data }) => ({ id: where.id, ...data })),
      },
    },
  };
}

describe('cron · auto-complete-stale-bookings · contract', () => {
  const CRON_SECRET = 'test-cron-secret-abcdefghij0123456789';
  const now = new Date('2026-04-21T20:00:00Z');
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  let stubs, handler;

  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET;
    stubs = makeStubs({
      bookings: [
        // stale CONFIRMED — should transition
        { id: 'bk_stale_1', status: 'CONFIRMED', checkOut: threeDaysAgo, guestName: 'Alice' },
        // stale CONFIRMED — should transition
        { id: 'bk_stale_2', status: 'CONFIRMED', checkOut: threeDaysAgo, guestName: 'Bob' },
        // recent CONFIRMED — should NOT transition (< 48h)
        { id: 'bk_recent',  status: 'CONFIRMED', checkOut: oneDayAgo,    guestName: 'Carol' },
        // terminal/non-CONFIRMED — should NOT transition
        { id: 'bk_cancel',  status: 'CANCELLED', checkOut: threeDaysAgo, guestName: 'Dave' },
        { id: 'bk_refund',  status: 'REFUNDED',  checkOut: threeDaysAgo, guestName: 'Eve' },
        { id: 'bk_done',    status: 'COMPLETED', checkOut: threeDaysAgo, guestName: 'Finn' },
        { id: 'bk_req',     status: 'REQUESTED', checkOut: threeDaysAgo, guestName: 'Gail' },
        { id: 'bk_pend',    status: 'PENDING',   checkOut: threeDaysAgo, guestName: 'Hank' },
      ],
    });
    handler = makeAutoCompleteStaleHandler({ prisma: stubs.prisma, now: () => now });
  });

  it('rejects missing X-Cron-Secret header with 401', async () => {
    const req = { headers: {}, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(stubs.prisma.booking.findMany).not.toHaveBeenCalled();
    expect(stubs.prisma.booking.update).not.toHaveBeenCalled();
  });

  it('rejects wrong X-Cron-Secret header with 401', async () => {
    const req = { headers: { 'x-cron-secret': 'wrong' }, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(stubs.prisma.booking.findMany).not.toHaveBeenCalled();
    expect(stubs.prisma.booking.update).not.toHaveBeenCalled();
  });

  it('transitions only CONFIRMED bookings whose checkOut is > 48h ago', async () => {
    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.transitioned).toBe(2);
    expect(res.body.ids.sort()).toEqual(['bk_stale_1', 'bk_stale_2']);
    // Exactly 2 updates — one per stale booking
    expect(stubs.prisma.booking.update).toHaveBeenCalledTimes(2);
    // And each update targets COMPLETED
    for (const call of stubs.prisma.booking.update.mock.calls) {
      expect(call[0].data).toEqual({ status: 'COMPLETED' });
    }
  });

  it('does NOT touch CANCELLED / REFUNDED / COMPLETED / REQUESTED / PENDING bookings even if stale', async () => {
    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: {} };
    const res = mockRes();
    await handler(req, res);
    const updatedIds = stubs.prisma.booking.update.mock.calls.map((c) => c[0].where.id);
    for (const bad of ['bk_cancel', 'bk_refund', 'bk_done', 'bk_req', 'bk_pend']) {
      expect(updatedIds).not.toContain(bad);
    }
  });

  it('does NOT touch recent CONFIRMED bookings (checkOut < 48h ago)', async () => {
    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: {} };
    const res = mockRes();
    await handler(req, res);
    const updatedIds = stubs.prisma.booking.update.mock.calls.map((c) => c[0].where.id);
    expect(updatedIds).not.toContain('bk_recent');
  });

  it('uses a 48h cutoff boundary — exactly-48h-ago is not yet stale', async () => {
    stubs = makeStubs({
      bookings: [
        // Exactly at the 48h threshold (not strictly less-than) — must NOT transition
        { id: 'bk_boundary', status: 'CONFIRMED', checkOut: twoDaysAgo, guestName: 'Boundary' },
      ],
    });
    handler = makeAutoCompleteStaleHandler({ prisma: stubs.prisma, now: () => now });

    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.body.transitioned).toBe(0);
    expect(stubs.prisma.booking.update).not.toHaveBeenCalled();
  });

  it('respects dryRun: true — returns candidates without calling update', async () => {
    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: { dryRun: true } };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.transitioned).toBe(0);
    expect(res.body.ids.sort()).toEqual(['bk_stale_1', 'bk_stale_2']);
    expect(res.body.dryRun).toBe(true);
    expect(stubs.prisma.booking.update).not.toHaveBeenCalled();
  });

  it('returns { transitioned: N, ids: string[] } on success', async () => {
    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.body).toMatchObject({
      transitioned: expect.any(Number),
      ids: expect.any(Array),
    });
    for (const id of res.body.ids) {
      expect(typeof id).toBe('string');
    }
  });

  it('returns { transitioned: 0, ids: [] } when no stale bookings exist', async () => {
    stubs = makeStubs({ bookings: [] });
    handler = makeAutoCompleteStaleHandler({ prisma: stubs.prisma, now: () => now });

    const req = { headers: { 'x-cron-secret': CRON_SECRET }, body: {} };
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.transitioned).toBe(0);
    expect(res.body.ids).toEqual([]);
    expect(stubs.prisma.booking.update).not.toHaveBeenCalled();
  });
});
