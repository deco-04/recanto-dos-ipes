'use strict';

/**
 * One-off script: push notification to all ADMIN staff about bookings
 * that still have placeholder/missing guest names.
 *
 * Run via: railway run node scripts/notify-incomplete-guests.js
 */

const prisma = require('../lib/db');
const { sendPushToRole } = require('../lib/push');

const PLACEHOLDER_NAMES = [
  'Hóspede Airbnb',
  'Hóspede Booking.com',
  '',
];

async function main() {
  // Find all active bookings with placeholder or missing guest names
  const incomplete = await prisma.booking.findMany({
    where: {
      status: { in: ['CONFIRMED', 'REQUESTED', 'PENDING'] },
      OR: [
        { guestName: null },
        { guestName: '' },
        { guestName: { in: PLACEHOLDER_NAMES } },
      ],
    },
    select: {
      id: true,
      guestName: true,
      checkIn: true,
      source: true,
    },
    orderBy: { checkIn: 'asc' },
  });

  if (incomplete.length === 0) {
    console.log('[notify] No incomplete bookings found — all guests have names ✓');
    return;
  }

  console.log(`[notify] Found ${incomplete.length} booking(s) with missing guest info:`);
  incomplete.forEach(b => {
    const date = b.checkIn.toISOString().split('T')[0];
    console.log(`  · ${b.id.slice(-8)} | ${date} | ${b.source} | name: "${b.guestName || '(vazio)'}"`);
  });

  const title = `${incomplete.length} reserva${incomplete.length > 1 ? 's' : ''} sem dados completos`;
  const body = incomplete.length === 1
    ? `Check-in em ${new Date(incomplete[0].checkIn).toLocaleDateString('pt-BR')} — adicione os dados do hóspede`
    : `${incomplete.length} reservas precisam de nome e dados do hóspede`;

  const sent = await sendPushToRole('ADMIN', {
    title,
    body,
    type: 'INCOMPLETE_GUEST_DATA',
    data: { count: incomplete.length, bookingIds: incomplete.map(b => b.id) },
  });

  console.log(`[notify] Push sent to ${sent} admin(s) ✓`);
}

main()
  .catch(err => { console.error('[notify] Error:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
