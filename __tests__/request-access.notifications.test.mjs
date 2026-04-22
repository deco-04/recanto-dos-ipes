import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the notification-reporting contract (2026-04-21):
//
// POST /api/staff/auth/request-access now returns a `notifications`
// object exposing whether email and push fired — 'sent' | 'skipped' |
// 'failed'. Rationale: the Gmail OAuth token has gone stale twice in
// two weeks and each time the admin had no idea the notification
// dropped. The persistence contract already shipped (83bbd1e) so the
// request itself never gets lost; this makes the flakiness observable.
//
// Failure mode: email failure specifically logs a Gmail-OAuth hint so
// log-grep surfaces the actionable cause.

process.env.STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || 'test-secret';

const require_ = createRequire(import.meta.url);
const { makeRequestAccessHandler } = require_('../routes/staff-auth.js');

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeStubs({ emailThrows = false, pushThrows = false } = {}) {
  return {
    prisma: {
      accessRequest: {
        create: vi.fn(async ({ data }) => ({ id: 'ar_1', ...data })),
      },
    },
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

describe('request-access · structured notification reporting', () => {
  let handler, stubs, validBody;

  beforeEach(() => {
    validBody = { name: 'Jane Doe', email: 'jane@example.com', phone: '+5531987654321' };
  });

  it('reports { email: sent, push: sent } when both succeed', async () => {
    stubs = makeStubs();
    handler = makeRequestAccessHandler(stubs);

    const res = mockRes();
    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.notifications).toEqual({ email: 'sent', push: 'sent' });
  });

  it('reports { email: failed, push: sent } on Gmail OAuth failure (non-blocking)', async () => {
    stubs = makeStubs({ emailThrows: true });
    handler = makeRequestAccessHandler(stubs);

    const res = mockRes();
    await handler({ body: validBody }, res);

    // Endpoint still succeeds — caller does not retry-storm.
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.notifications.email).toBe('failed');
    expect(res.body.notifications.push).toBe('sent');
    // Persistence still happened.
    expect(stubs.prisma.accessRequest.create).toHaveBeenCalledTimes(1);
  });

  it('reports { email: sent, push: failed } when web-push throws', async () => {
    stubs = makeStubs({ pushThrows: true });
    handler = makeRequestAccessHandler(stubs);

    const res = mockRes();
    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.notifications.email).toBe('sent');
    expect(res.body.notifications.push).toBe('failed');
  });

  it('reports both failed when email AND push blow up, but still persists', async () => {
    stubs = makeStubs({ emailThrows: true, pushThrows: true });
    handler = makeRequestAccessHandler(stubs);

    const res = mockRes();
    await handler({ body: validBody }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.notifications).toEqual({ email: 'failed', push: 'failed' });
    expect(stubs.prisma.accessRequest.create).toHaveBeenCalledTimes(1);
  });

  it('logs a Gmail-OAuth hint when email fails (grep target for on-call)', async () => {
    stubs = makeStubs({ emailThrows: true });
    handler = makeRequestAccessHandler(stubs);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handler({ body: validBody }, mockRes());

    const allLogs = errSpy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(allLogs).toMatch(/Gmail OAuth/);
    errSpy.mockRestore();
  });
});
