import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

// Pin the contract (2026-04-28):
//
//   D-3 guest-list escalation cron
//
// Daily at 15:00 UTC (12:00 BRT). Finds CONFIRMED bookings with check-in in
// exactly 3 days and ZERO GuestListEntry rows, sends the
// `lembrete_lista_hospedes_urgente` Meta template (with free-text fallback)
// and pushes ADMIN.
//
// The per-booking logic is extracted into a helper `processD3UrgentReminder`
// so we can test it without registering the cron itself.
//
// Cases:
//   1. Bookings with guestList.length > 0 → filtered out by Prisma where clause
//      (we assert the where: { guestList: { none: {} } } shape)
//   2. Bookings without phone → skipped (no WA send, but push still fires)
//   3. With Meta template active → sendTemplate called with correct args
//   4. Without Meta template (or inactive) → sendText fallback
//   5. Push notification fires per booking regardless of WA path

const require_ = createRequire(import.meta.url);
const cronModule = require_('../lib/cron.js');
const { processD3UrgentReminder, buildD3UrgentReminderQuery } = cronModule;

function makeStubs() {
  return {
    prismaClient: {
      booking: { findMany: vi.fn() },
      messageTemplate: { findUnique: vi.fn() },
    },
    sendTemplate:   vi.fn(async () => ({ ok: true })),
    sendText:       vi.fn(async () => ({ ok: true })),
    sendPushToRole: vi.fn(async () => 1),
  };
}

describe('cron · D-3 guest-list escalation · query shape', () => {
  it('filters by status=CONFIRMED, exact checkIn date, and guestList: { none: {} }', () => {
    const targetDate = '2026-05-01';
    const where = buildD3UrgentReminderQuery(targetDate);

    expect(where.status).toBe('CONFIRMED');
    expect(where.checkIn).toBeInstanceOf(Date);
    expect(where.checkIn.toISOString().slice(0, 10)).toBe(targetDate);
    // Critical: the Prisma filter that excludes bookings already submitted
    expect(where.guestList).toEqual({ none: {} });
  });
});

describe('cron · D-3 guest-list escalation · processD3UrgentReminder', () => {
  let stubs;
  const checkIn = new Date('2026-05-01T00:00:00Z');
  const baseBooking = {
    id:         'bk_d3_1',
    guestName:  'Alice Silva',
    guestPhone: '+5531999999999',
    checkIn,
  };

  beforeEach(() => {
    stubs = makeStubs();
  });

  it('skips WA send when booking has no phone, but still pushes ADMIN', async () => {
    const noPhone = { ...baseBooking, guestPhone: null };
    const tpl = { name: 'lembrete_lista_hospedes_urgente', active: true };

    await processD3UrgentReminder(noPhone, { tpl, ...stubs });

    expect(stubs.sendTemplate).not.toHaveBeenCalled();
    expect(stubs.sendText).not.toHaveBeenCalled();
    expect(stubs.sendPushToRole).toHaveBeenCalledTimes(1);
    expect(stubs.sendPushToRole).toHaveBeenCalledWith(
      'ADMIN',
      expect.objectContaining({
        title: expect.stringContaining('Alice Silva'),
        type:  'PRESTAY_REMINDER_SENT',
        data:  { bookingId: 'bk_d3_1' },
      }),
    );
  });

  it('uses sendTemplate with [guestName, checkInFmt] when template is active', async () => {
    const tpl = { name: 'lembrete_lista_hospedes_urgente', active: true };

    const result = await processD3UrgentReminder(baseBooking, { tpl, ...stubs });

    expect(stubs.sendTemplate).toHaveBeenCalledTimes(1);
    const [phone, name, vars, bookingId] = stubs.sendTemplate.mock.calls[0];
    expect(phone).toBe('+5531999999999');
    expect(name).toBe('lembrete_lista_hospedes_urgente');
    expect(vars).toEqual(['Alice Silva', '01/05/2026']);
    expect(bookingId).toBe('bk_d3_1');
    expect(stubs.sendText).not.toHaveBeenCalled();
    expect(result.waSent).toBe(true);
  });

  it('falls back to sendText when template is missing or inactive', async () => {
    const result = await processD3UrgentReminder(baseBooking, { tpl: null, ...stubs });

    expect(stubs.sendTemplate).not.toHaveBeenCalled();
    expect(stubs.sendText).toHaveBeenCalledTimes(1);
    const [phone, body, bookingId] = stubs.sendText.mock.calls[0];
    expect(phone).toBe('+5531999999999');
    expect(body).toContain('Alice Silva');
    expect(body).toContain('01/05/2026');
    expect(bookingId).toBe('bk_d3_1');
    expect(result.waSent).toBe(true);
  });

  it('falls back to sendText when template exists but active=false', async () => {
    const tpl = { name: 'lembrete_lista_hospedes_urgente', active: false };

    await processD3UrgentReminder(baseBooking, { tpl, ...stubs });

    expect(stubs.sendTemplate).not.toHaveBeenCalled();
    expect(stubs.sendText).toHaveBeenCalledTimes(1);
  });

  it('always pushes ADMIN per booking regardless of which WA path was used', async () => {
    // Path A: template active
    await processD3UrgentReminder(baseBooking, {
      tpl: { name: 'lembrete_lista_hospedes_urgente', active: true },
      ...stubs,
    });
    // Path B: fallback
    await processD3UrgentReminder({ ...baseBooking, id: 'bk_d3_2' }, {
      tpl: null,
      ...stubs,
    });
    // Path C: no phone
    await processD3UrgentReminder({ ...baseBooking, id: 'bk_d3_3', guestPhone: null }, {
      tpl: null,
      ...stubs,
    });

    expect(stubs.sendPushToRole).toHaveBeenCalledTimes(3);
    const calls = stubs.sendPushToRole.mock.calls;
    expect(calls.every(c => c[0] === 'ADMIN')).toBe(true);
    expect(calls.map(c => c[1].data.bookingId)).toEqual(['bk_d3_1', 'bk_d3_2', 'bk_d3_3']);
    for (const call of calls) {
      expect(call[1].type).toBe('PRESTAY_REMINDER_SENT');
      expect(call[1].body).toMatch(/3 dias/);
    }
  });

  it('swallows sendTemplate errors so the push still fires', async () => {
    stubs.sendTemplate = vi.fn(async () => { throw new Error('Meta down'); });
    const tpl = { name: 'lembrete_lista_hospedes_urgente', active: true };

    const result = await processD3UrgentReminder(baseBooking, { tpl, ...stubs });

    expect(result.waSent).toBe(false);
    expect(stubs.sendPushToRole).toHaveBeenCalledTimes(1);
  });
});
