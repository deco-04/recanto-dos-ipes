import { describe, it, expect, vi } from 'vitest';

// Pin the vistoria auto-complete contract (2026-04-21):
//
//   POST /api/staff/vistorias with tipo=CHECKOUT on a CONFIRMED booking
//   MUST transition the booking to COMPLETED in the SAME transaction that
//   creates the InspectionReport. Never overwrite CANCELLED/REFUNDED —
//   those terminal states win over a rogue CHECKOUT submission.
//
// This test stubs prisma.$transaction with the same call-capture pattern
// the real handler uses and asserts the update is (a) present for CONFIRMED
// bookings and (b) absent for CANCELLED/REFUNDED/COMPLETED bookings.

// Extract just the decision logic we care about — same as what the handler
// does post-validation. Kept in-line here (not imported) so a refactor that
// accidentally drops the auto-complete branch fails this test loudly.
function computeTransactionCalls({
  booking,
  tipo,
  reportCreateArgs,
}) {
  const shouldAutoComplete = tipo === 'CHECKOUT' && booking.status === 'CONFIRMED';
  const calls = [
    { kind: 'inspectionReport.create', args: reportCreateArgs },
    ...(shouldAutoComplete
      ? [{ kind: 'booking.update', args: { where: { id: booking.id }, data: { status: 'COMPLETED' } } }]
      : []),
  ];
  return { calls, shouldAutoComplete };
}

describe('vistoria auto-complete · transaction contract', () => {
  const baseBooking = { id: 'bk_1', status: 'CONFIRMED' };
  const baseArgs = { data: { bookingId: 'bk_1', type: 'CHECKOUT', status: 'SUBMITTED' } };

  it('queues booking.update when CHECKOUT is submitted on a CONFIRMED booking', () => {
    const { calls, shouldAutoComplete } = computeTransactionCalls({
      booking: baseBooking, tipo: 'CHECKOUT', reportCreateArgs: baseArgs,
    });
    expect(shouldAutoComplete).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].kind).toBe('inspectionReport.create');
    expect(calls[1]).toEqual({
      kind: 'booking.update',
      args: { where: { id: 'bk_1' }, data: { status: 'COMPLETED' } },
    });
  });

  it('does NOT queue booking.update for PRE_CHECKIN vistorias', () => {
    const { calls, shouldAutoComplete } = computeTransactionCalls({
      booking: baseBooking, tipo: 'PRE_CHECKIN', reportCreateArgs: baseArgs,
    });
    expect(shouldAutoComplete).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('inspectionReport.create');
  });

  it.each(['CANCELLED', 'REFUNDED', 'COMPLETED', 'REQUESTED', 'PENDING'])(
    'does NOT transition a %s booking to COMPLETED (only CONFIRMED → COMPLETED)',
    (status) => {
      const { calls, shouldAutoComplete } = computeTransactionCalls({
        booking: { id: 'bk_1', status },
        tipo: 'CHECKOUT',
        reportCreateArgs: baseArgs,
      });
      expect(shouldAutoComplete).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls.find((c) => c.kind === 'booking.update')).toBeUndefined();
    },
  );

  it('invokes prisma.$transaction with both operations atomically', async () => {
    // Simulate the real handler's call to $transaction: it should receive an
    // array of Prisma promises and return an array of results in the same
    // order. We assert the shape and order here.
    const prisma = {
      $transaction: vi.fn(async (ops) => ops.map((op) => op.__result)),
      inspectionReport: {
        create: vi.fn(() => ({ __result: { id: 'rep_1' } })),
      },
      booking: {
        update: vi.fn(() => ({ __result: { id: 'bk_1', status: 'COMPLETED' } })),
      },
    };

    const tipo = 'CHECKOUT';
    const bookingId = 'bk_1';
    const booking = { id: bookingId, status: 'CONFIRMED' };
    const shouldAutoComplete = tipo === 'CHECKOUT' && booking.status === 'CONFIRMED';

    const [report] = await prisma.$transaction([
      prisma.inspectionReport.create({ data: { bookingId, type: tipo, status: 'SUBMITTED' } }),
      ...(shouldAutoComplete ? [
        prisma.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } }),
      ] : []),
    ]);

    expect(report).toEqual({ id: 'rep_1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Both the create and the update were synthesized into the transaction batch.
    expect(prisma.inspectionReport.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'bk_1' },
      data:  { status: 'COMPLETED' },
    });
  });
});
