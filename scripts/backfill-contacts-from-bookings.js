'use strict';

/**
 * Idempotent backfill: convert every existing Booking with a guestPhone into
 * a row in the Contact table.
 *
 * Rules (same as the live upsert helper):
 *   - Phone is normalized to E.164 via lib/phone.js (defaults to +55).
 *   - Existing Contact rows are updated (name/email if missing, lastSeenAt
 *     bumped to the latest booking, bookingCount incremented).
 *   - Bookings without a phone are skipped (logged separately).
 *
 * Usage (Railway one-off):
 *   railway ssh --service recanto-dos-ipes "node scripts/backfill-contacts-from-bookings.js"
 *
 * Re-runnable without worry; it never creates duplicates.
 */

const prisma = require('../lib/db');
const { toE164 } = require('../lib/phone');

async function main() {
  const bookings = await prisma.booking.findMany({
    select: {
      id:         true,
      guestName:  true,
      guestEmail: true,
      guestPhone: true,
      propertyId: true,
      source:     true,
      createdAt:  true,
    },
    orderBy: { createdAt: 'asc' },
  });

  let created     = 0;
  let updated     = 0;
  let skipped     = 0;
  let skippedNoPhone = 0;

  // Group bookings per phone so we can compute true bookingCount from history.
  const byPhone = new Map();
  for (const b of bookings) {
    if (!b.guestPhone) { skippedNoPhone += 1; continue; }
    const phone = toE164(b.guestPhone);
    if (!phone || phone.length < 4) { skipped += 1; continue; }
    const entry = byPhone.get(phone) || {
      phoneE164: phone,
      name:       null,
      email:      null,
      propertyId: null,
      source:     'BOOKING',
      firstSeen:  b.createdAt,
      lastSeen:   b.createdAt,
      count:      0,
    };
    // Keep the earliest booking's property as the "home property" tag.
    if (!entry.propertyId && b.propertyId) entry.propertyId = b.propertyId;
    if (!entry.name       && b.guestName)  entry.name       = b.guestName;
    if (!entry.email      && b.guestEmail) entry.email      = b.guestEmail;
    if (b.createdAt < entry.firstSeen) entry.firstSeen = b.createdAt;
    if (b.createdAt > entry.lastSeen)  entry.lastSeen  = b.createdAt;
    if (b.source === 'AIRBNB' || b.source === 'BOOKING_COM') entry.source = 'ICAL';
    entry.count += 1;
    byPhone.set(phone, entry);
  }

  for (const [, entry] of byPhone) {
    const existing = await prisma.contact.findUnique({ where: { phoneE164: entry.phoneE164 } });
    if (existing) {
      await prisma.contact.update({
        where: { phoneE164: entry.phoneE164 },
        data: {
          name:         existing.name  ?? entry.name,
          email:        existing.email ?? entry.email,
          propertyId:   existing.propertyId ?? entry.propertyId,
          lastSeenAt:   entry.lastSeen > existing.lastSeenAt ? entry.lastSeen : existing.lastSeenAt,
          firstSeenAt:  entry.firstSeen < existing.firstSeenAt ? entry.firstSeen : existing.firstSeenAt,
          // Don't double-count if we've backfilled before — set to max of existing and computed.
          bookingCount: Math.max(existing.bookingCount, entry.count),
        },
      });
      updated += 1;
    } else {
      await prisma.contact.create({
        data: {
          phoneE164:    entry.phoneE164,
          name:         entry.name,
          email:        entry.email,
          propertyId:   entry.propertyId,
          source:       entry.source,
          firstSeenAt:  entry.firstSeen,
          lastSeenAt:   entry.lastSeen,
          bookingCount: entry.count,
        },
      });
      created += 1;
    }
  }

  console.log(`[backfill-contacts] bookings=${bookings.length} uniquePhones=${byPhone.size} created=${created} updated=${updated} skippedInvalid=${skipped} skippedNoPhone=${skippedNoPhone}`);
}

main()
  .catch(err => { console.error('[backfill-contacts] failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
