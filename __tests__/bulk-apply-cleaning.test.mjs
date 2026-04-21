import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-21):
//
//   POST /api/admin/staff/expenses/bulk-apply-cleaning
//
// Given { propertyId, month: 'YYYY-MM', amount }, the handler MUST:
//   - validate the shape (400 on bad month format / missing propertyId)
//   - call prisma.expense.updateMany with a where-clause scoped to
//     (propertyId, category=SERVICOS_LIMPEZA, date in [month-start, next-month))
//     and data={amount}
//   - return { updated, previousTotal, newTotal }
//
// Uses the DI factory so no live DB is needed (same pattern as
// access-request.persistence.test.mjs).

process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const routerModule = require_('../routes/admin-staff.js');
const { makeBulkApplyCleaningHandler, makeCleaningCountHandler, monthBounds } = routerModule;

function makeStubs({ existing = [], updateCount = null } = {}) {
  return {
    prisma: {
      expense: {
        findMany: vi.fn(async ({ where }) => {
          // Filter by the where passed, returning the caller-provided fixtures.
          return existing.filter((e) =>
            e.propertyId === where.propertyId &&
            e.category === where.category &&
            e.date >= where.date.gte &&
            e.date <  where.date.lt,
          );
        }),
        updateMany: vi.fn(async () => ({
          count: updateCount ?? existing.length,
        })),
        count: vi.fn(async ({ where }) =>
          existing.filter((e) =>
            e.propertyId === where.propertyId &&
            e.category === where.category &&
            e.date >= where.date.gte &&
            e.date <  where.date.lt,
          ).length,
        ),
      },
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body)   { this.body = body; return this; },
  };
}

describe('bulk-apply-cleaning · contract', () => {
  let stubs, handler;

  beforeEach(() => {
    // Three dummy SERVICOS_LIMPEZA expenses in April 2026 for the test property.
    stubs = makeStubs({
      existing: [
        { id: 'e1', propertyId: 'prop-test', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 3, 5)),  amount: 250 },
        { id: 'e2', propertyId: 'prop-test', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 3, 15)), amount: 250 },
        { id: 'e3', propertyId: 'prop-test', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 3, 28)), amount: 270 },
        // Out of scope — should NOT be matched (wrong month).
        { id: 'e4', propertyId: 'prop-test', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 2, 28)), amount: 999 },
        // Out of scope — wrong category.
        { id: 'e5', propertyId: 'prop-test', category: 'ENERGIA_ELETRICA',
          date: new Date(Date.UTC(2026, 3, 10)), amount: 999 },
        // Out of scope — wrong property.
        { id: 'e6', propertyId: 'other-prop', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 3, 10)), amount: 999 },
      ],
      updateCount: 3,
    });
    handler = makeBulkApplyCleaningHandler(stubs);
  });

  it('updates the 3 in-scope April expenses to the new amount', async () => {
    const req = { body: { propertyId: 'prop-test', month: '2026-04', amount: 300 } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toBe(3);
    expect(res.body.previousTotal).toBeCloseTo(250 + 250 + 270, 2);
    expect(res.body.newTotal).toBeCloseTo(3 * 300, 2);

    // updateMany was called with the exact scoped where.
    expect(stubs.prisma.expense.updateMany).toHaveBeenCalledTimes(1);
    const call = stubs.prisma.expense.updateMany.mock.calls[0][0];
    expect(call.where.propertyId).toBe('prop-test');
    expect(call.where.category).toBe('SERVICOS_LIMPEZA');
    expect(call.where.date.gte).toEqual(new Date(Date.UTC(2026, 3, 1)));
    expect(call.where.date.lt).toEqual(new Date(Date.UTC(2026, 4, 1)));
    expect(call.data).toEqual({ amount: 300 });
  });

  it('rejects invalid month format with 400 and does not touch the DB', async () => {
    const req = { body: { propertyId: 'prop-test', month: 'April 2026', amount: 300 } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(stubs.prisma.expense.updateMany).not.toHaveBeenCalled();
  });

  it('rejects negative amount', async () => {
    const req = { body: { propertyId: 'prop-test', month: '2026-04', amount: -10 } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(stubs.prisma.expense.updateMany).not.toHaveBeenCalled();
  });

  it('accepts amount=0 (admin may zero-out a bad month)', async () => {
    const req = { body: { propertyId: 'prop-test', month: '2026-04', amount: 0 } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.updated).toBe(3);
    expect(res.body.newTotal).toBe(0);
  });

  it('returns 500 and a safe message when the DB throws', async () => {
    stubs.prisma.expense.findMany = vi.fn(async () => { throw new Error('db down'); });
    handler = makeBulkApplyCleaningHandler(stubs);

    const req = { body: { propertyId: 'prop-test', month: '2026-04', amount: 300 } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Erro ao aplicar taxa de limpeza' });
  });
});

describe('cleaning-count · GET counter', () => {
  it('returns the in-scope count for the given property + month', async () => {
    const stubs = makeStubs({
      existing: [
        { id: 'e1', propertyId: 'prop-test', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 3, 5)),  amount: 250 },
        { id: 'e2', propertyId: 'prop-test', category: 'SERVICOS_LIMPEZA',
          date: new Date(Date.UTC(2026, 3, 15)), amount: 250 },
      ],
    });
    const handler = makeCleaningCountHandler(stubs);

    const req = { query: { propertyId: 'prop-test', month: '2026-04' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it('rejects a bad month query', async () => {
    const stubs = makeStubs();
    const handler = makeCleaningCountHandler(stubs);

    const req = { query: { propertyId: 'prop-test', month: '04-2026' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(stubs.prisma.expense.count).not.toHaveBeenCalled();
  });
});

describe('monthBounds · pure helper', () => {
  it('returns a half-open interval [first, first-of-next-month)', () => {
    const { start, end } = monthBounds('2026-04');
    expect(start).toEqual(new Date(Date.UTC(2026, 3, 1)));
    expect(end).toEqual(new Date(Date.UTC(2026, 4, 1)));
  });

  it('handles December → January rollover', () => {
    const { start, end } = monthBounds('2026-12');
    expect(start).toEqual(new Date(Date.UTC(2026, 11, 1)));
    expect(end).toEqual(new Date(Date.UTC(2027, 0, 1)));
  });
});
