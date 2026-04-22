import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the persistence contract (2026-04-21):
//
//   POST /api/staff/auth/request-access MUST write to AccessRequest
//   BEFORE calling the notification email/push helpers, so admins can
//   review requests from /admin/equipe/solicitacoes even when Gmail
//   OAuth is broken.
//
// Sthefane Souza's 2026-04-21 request was silently dropped because the
// endpoint's only record was a notification email that never reached
// the admin. This test prevents recurrence by asserting the handler
// calls prisma.accessRequest.create even when the notification helpers
// throw.
//
// We use the DI-friendly factory (makeRequestAccessHandler) with stub
// deps — same pattern used by makeFindStaffWithProperties. No live DB
// required.

process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const { makeRequestAccessHandler } = require_('../routes/staff-auth.js');

function makeStubs({ persistThrows = false, emailThrows = true, pushThrows = true } = {}) {
  return {
    prisma: {
      accessRequest: {
        create: vi.fn(async ({ data }) =>
          persistThrows
            ? Promise.reject(new Error('db unavailable'))
            : { id: 'ar_stub', status: 'PENDING', ...data },
        ),
      },
    },
    // Simulate Gmail OAuth failure — the exact failure mode that silently
    // dropped Sthefane's request. Persistence MUST happen before this.
    sendAdminNotification: vi.fn(() =>
      emailThrows
        ? Promise.reject(new Error('Gmail OAuth expired'))
        : Promise.resolve(true),
    ),
    sendPushToRole: vi.fn(() =>
      pushThrows
        ? Promise.reject(new Error('push unavailable'))
        : Promise.resolve(true),
    ),
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

describe('request-access · persistence contract', () => {
  let stubs, handler;

  beforeEach(() => {
    stubs = makeStubs();
    handler = makeRequestAccessHandler(stubs);
  });

  it('persists an AccessRequest row even when the notification email throws', async () => {
    const req = {
      body: {
        name:    'Regression Bot',
        email:   'regression-test@example.com',
        phone:   '+5531999999999',
        message: 'automated test — persistence pin',
      },
    };
    const res = mockRes();

    await handler(req, res);

    // Endpoint returns ok regardless of notification outcome (best-effort).
    // Body now also includes structured `notifications` reporting — we
    // assert ok + that the key exists; the exact shape is pinned by
    // request-access.notifications.test.mjs.
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('notifications');

    // THE contract: the AccessRequest row was created.
    expect(stubs.prisma.accessRequest.create).toHaveBeenCalledTimes(1);
    const callArg = stubs.prisma.accessRequest.create.mock.calls[0][0];
    expect(callArg.data).toEqual({
      name:    'Regression Bot',
      email:   'regression-test@example.com',
      phone:   '+5531999999999',
      message: 'automated test — persistence pin',
    });

    // Notification helpers were still called (best-effort), and their
    // rejections didn't bubble up.
    expect(stubs.sendAdminNotification).toHaveBeenCalledTimes(1);
    expect(stubs.sendPushToRole).toHaveBeenCalledTimes(1);
  });

  it('normalizes missing optional fields to null when persisting', async () => {
    const req = { body: { name: 'No Phone', email: 'nophone@example.com' } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(stubs.prisma.accessRequest.create).toHaveBeenCalledTimes(1);
    const callArg = stubs.prisma.accessRequest.create.mock.calls[0][0];
    expect(callArg.data).toEqual({
      name:    'No Phone',
      email:   'nophone@example.com',
      phone:   null,
      message: null,
    });
  });

  it('rejects invalid payloads (short name) without writing to the DB', async () => {
    const req = { body: { name: 'A', email: 'bad@example.com' } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Dados inválidos' });
    expect(stubs.prisma.accessRequest.create).not.toHaveBeenCalled();
    expect(stubs.sendAdminNotification).not.toHaveBeenCalled();
  });

  it('still returns 200 when the DB write fails (so caller does not retry-storm)', async () => {
    stubs = makeStubs({ persistThrows: true });
    handler = makeRequestAccessHandler(stubs);

    const req = { body: { name: 'DB Failure Case', email: 'dbfail@example.com' } };
    const res = mockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(stubs.prisma.accessRequest.create).toHaveBeenCalledTimes(1);
  });
});
