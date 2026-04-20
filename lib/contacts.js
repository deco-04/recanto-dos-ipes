'use strict';

/**
 * Contact upsert helper — call whenever a booking lands a phone number so
 * the staff-app address book (/admin/contatos) stays in sync.
 *
 * Keyed on E.164 phone number (lib/phone.js → toE164 defaults to +55 when no
 * country code is present, which matches our majority-Brazilian guest base).
 *
 * Design decisions:
 *  - `update.name` / `update.email` are left undefined when the caller doesn't
 *    pass a value so Prisma doesn't overwrite an existing name with null.
 *  - `bookingCount` increments on every upsert — that's the point: the list
 *    should surface repeat guests at the top.
 *  - `propertyId` on update is NOT changed — keep the "home property" tag,
 *    even if the same guest later books at a different sister property.
 *  - Exposes a factory (`makeUpsertContactFromBooking`) so unit tests can
 *    inject a fake Prisma without wrestling with Vitest's CJS/ESM bridge.
 */

const { toE164 } = require('./phone');

function makeUpsertContactFromBooking(prisma) {
  return async function upsertContactFromBooking({
    guestPhone,
    guestName,
    guestEmail,
    propertyId,
    source = 'BOOKING',
  }) {
    if (!guestPhone) return null;
    const phoneE164 = toE164(guestPhone);
    if (!phoneE164 || phoneE164.length < 4) return null;

    return prisma.contact.upsert({
      where:  { phoneE164 },
      update: {
        // undefined → Prisma leaves the column untouched; null would overwrite.
        name:         guestName  || undefined,
        email:        guestEmail || undefined,
        lastSeenAt:   new Date(),
        bookingCount: { increment: 1 },
      },
      create: {
        phoneE164,
        name:       guestName  || null,
        email:      guestEmail || null,
        propertyId: propertyId || null,
        source,
      },
    });
  };
}

// Default export wired to the real Prisma singleton.
const prisma = require('./db');
const upsertContactFromBooking = makeUpsertContactFromBooking(prisma);

module.exports = { upsertContactFromBooking, makeUpsertContactFromBooking };
