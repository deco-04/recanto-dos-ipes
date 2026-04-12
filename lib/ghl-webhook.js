'use strict';

const https = require('https');
const http  = require('http');

/**
 * Sends a booking confirmation event to GoHighLevel via webhook.
 * GHL workflow handles: CRM contact creation, WhatsApp, email sequences, reminders.
 *
 * Set GHL_WEBHOOK_URL env var to your GHL workflow webhook URL.
 * If not configured, this is a no-op (booking still completes).
 */
async function notifyBookingConfirmed(booking) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:         'booking.confirmed',
    bookingId:     booking.id,
    invoiceNumber: booking.invoiceNumber,
    guestName:     booking.guestName,
    guestEmail:    booking.guestEmail,
    guestPhone:    booking.guestPhone,
    checkIn:       booking.checkIn,
    checkOut:      booking.checkOut,
    nights:        booking.nights,
    guestCount:    booking.guestCount,
    hasPet:        booking.hasPet,
    totalAmount:   Number(booking.totalAmount),
    source:        booking.source,
    createdAt:     booking.createdAt,
  });

  return postJson(url, payload);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = mod.request(opts, res => {
      res.resume(); // drain response
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`GHL webhook returned ${res.statusCode}`));
      }
      resolve();
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('GHL webhook timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Notifies GHL when an OTA booking (Airbnb/Booking.com) is captured from iCal sync.
 * GHL creates a contact + opportunity, then triggers the welcome WhatsApp sequence.
 */
async function notifyOTABooking(booking) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:      'ota_booking.created',
    bookingId:  booking.id,
    externalId: booking.externalId,
    guestName:  booking.guestName,
    guestEmail: booking.guestEmail || null,
    source:     booking.source,     // AIRBNB | BOOKING_COM
    checkIn:    booking.checkIn,
    checkOut:   booking.checkOut,
    nights:     booking.nights,
    createdAt:  booking.createdAt,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] notifyOTABooking error:', e.message)
  );
}

/**
 * Notifies GHL when a new guest creates an account or confirms a co-guest invite.
 * GHL creates/updates contact and links to the bookings pipeline.
 */
async function notifyContactCreated({ user, bookingId }) {
  const url = process.env.GHL_WEBHOOK_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:     'contact.created',
    userId:    user.id,
    email:     user.email,
    name:      user.name  || null,
    phone:     user.phone || null,
    bookingId: bookingId  || null,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] notifyContactCreated error:', e.message)
  );
}

module.exports = { notifyBookingConfirmed, notifyOTABooking, notifyContactCreated };
