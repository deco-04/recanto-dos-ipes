import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeUpsertContactFromBooking } from '../lib/contacts.js';

// Factory-based unit tests — inject a fake Prisma so the real ./db module
// (which instantiates a live connection) is never touched.
function makeFakePrisma() {
  const upsert = vi.fn();
  return { upsert, client: { contact: { upsert: (args) => upsert(args) } } };
}

describe('upsertContactFromBooking', () => {
  let fake;
  let upsertFn;

  beforeEach(() => {
    fake = makeFakePrisma();
    upsertFn = makeUpsertContactFromBooking(fake.client);
  });

  it('returns null when guestPhone is empty/undefined', async () => {
    expect(await upsertFn({ guestPhone: '',   propertyId: 'p' })).toBeNull();
    expect(await upsertFn({ guestPhone: null, propertyId: 'p' })).toBeNull();
    expect(await upsertFn({                   propertyId: 'p' })).toBeNull();
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it('normalizes Brazilian 11-digit phone to +55 and upserts', async () => {
    fake.upsert.mockResolvedValue({ id: 'contact-1', phoneE164: '+5531999998888' });

    await upsertFn({
      guestPhone: '(31) 9 9999-8888',
      guestName: 'Maria',
      guestEmail: 'maria@example.com',
      propertyId: 'prop-rdi',
      source: 'BOOKING',
    });

    expect(fake.upsert).toHaveBeenCalledTimes(1);
    const args = fake.upsert.mock.calls[0][0];
    expect(args.where.phoneE164).toBe('+5531999998888');
    expect(args.create.phoneE164).toBe('+5531999998888');
    expect(args.create.name).toBe('Maria');
    expect(args.create.email).toBe('maria@example.com');
    expect(args.create.propertyId).toBe('prop-rdi');
    expect(args.create.source).toBe('BOOKING');
  });

  it('preserves explicit country code when provided', async () => {
    fake.upsert.mockResolvedValue({ id: 'c2' });
    await upsertFn({ guestPhone: '+13035551234', guestName: 'US guest', propertyId: 'p' });
    expect(fake.upsert.mock.calls[0][0].where.phoneE164).toBe('+13035551234');
  });

  it('update branch bumps bookingCount and refreshes lastSeenAt', async () => {
    fake.upsert.mockResolvedValue({ id: 'c3' });
    await upsertFn({ guestPhone: '31988887777', guestName: 'Ana', propertyId: 'p' });
    const args = fake.upsert.mock.calls[0][0];
    expect(args.update.bookingCount).toEqual({ increment: 1 });
    expect(args.update.lastSeenAt instanceof Date).toBe(true);
  });

  it('does not overwrite existing name with undefined on update', async () => {
    fake.upsert.mockResolvedValue({ id: 'c4' });
    await upsertFn({ guestPhone: '31988887777', propertyId: 'p' });
    const args = fake.upsert.mock.calls[0][0];
    // guestName is undefined → update.name must be undefined so Prisma doesn't overwrite it
    expect(args.update.name).toBeUndefined();
    expect(args.update.email).toBeUndefined();
  });

  it('defaults source to BOOKING when not provided', async () => {
    fake.upsert.mockResolvedValue({ id: 'c5' });
    await upsertFn({ guestPhone: '31988887777', guestName: 'Z', propertyId: 'p' });
    expect(fake.upsert.mock.calls[0][0].create.source).toBe('BOOKING');
  });

  it('accepts ICAL / MANUAL / GHL sources', async () => {
    fake.upsert.mockResolvedValue({ id: 'c6' });
    await upsertFn({ guestPhone: '31988887777', source: 'ICAL',   propertyId: 'p' });
    await upsertFn({ guestPhone: '31988887776', source: 'MANUAL', propertyId: 'p' });
    await upsertFn({ guestPhone: '31988887775', source: 'GHL',    propertyId: 'p' });
    expect(fake.upsert.mock.calls[0][0].create.source).toBe('ICAL');
    expect(fake.upsert.mock.calls[1][0].create.source).toBe('MANUAL');
    expect(fake.upsert.mock.calls[2][0].create.source).toBe('GHL');
  });
});
