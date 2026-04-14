'use strict';

const https      = require('https');
const http       = require('http');
const ical       = require('node-ical');
const { createHash } = require('crypto');
const prisma     = require('./db');
const { notifyOTABooking } = require('./ghl-webhook');
const { sendPushToRole }   = require('./push');
const { createOtaTask }    = require('./tasks');

// Domains allowed as iCal redirect targets (prevents SSRF via redirect)
const ICAL_ALLOWED_DOMAINS = ['airbnb.com', 'booking.com', 'bookingbutton.com', 'icalendar.com'];

function isAllowedIcalHost(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return ICAL_ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Fetches an iCal URL and returns its text content.
 * Follows at most ONE redirect, and only to whitelisted domains.
 */
function fetchIcal(url, _redirected = false) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (_redirected) {
          return reject(new Error('iCal fetch: too many redirects'));
        }
        const redirectUrl = res.headers.location;
        if (!isAllowedIcalHost(redirectUrl)) {
          return reject(new Error(`iCal fetch: redirect to disallowed host blocked (${redirectUrl})`));
        }
        return fetchIcal(redirectUrl, true).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`iCal fetch failed: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('iCal fetch timed out')); });
    req.on('error', reject);
  });
}

/**
 * Parses a guest name from Airbnb iCal SUMMARY field.
 * Airbnb format: "FirstName L. (CONFIRMATIONCODE)" → "FirstName L."
 * Booking.com format: "CLOSED - 1 Night, 2 Guests" → use fallback
 */
function parseGuestName(summary, source) {
  if (!summary) return source === 'AIRBNB' ? 'Hóspede Airbnb' : 'Hóspede Booking.com';

  // Airbnb: "FirstName L. (ABC123)"
  const airbnbMatch = summary.match(/^(.+?)\s*\([A-Z0-9]+\)\s*$/);
  if (airbnbMatch) return airbnbMatch[1].trim();

  // Skip Booking.com hold events
  const lower = summary.toLowerCase();
  if (lower.includes('closed') || lower.includes('not available') || lower === 'blocked') {
    return null; // signal: skip this event
  }

  return summary.trim() || (source === 'AIRBNB' ? 'Hóspede Airbnb' : 'Hóspede Booking.com');
}

/**
 * Extracts all booked dates (as YYYY-MM-DD strings) from parsed iCal events.
 */
function extractBlockedDates(parsed) {
  const dates = new Set();

  for (const event of Object.values(parsed)) {
    if (event.type !== 'VEVENT') continue;

    let start = event.start;
    let end   = event.end || event.start;

    if (!start) continue;
    if (!(start instanceof Date)) start = new Date(start);
    if (!(end instanceof Date))   end   = new Date(end);

    const cur = new Date(start);
    cur.setHours(12, 0, 0, 0);
    const last = new Date(end);
    last.setHours(12, 0, 0, 0);

    while (cur < last) {
      dates.add(cur.toISOString().split('T')[0]);
      cur.setDate(cur.getDate() + 1);
    }
  }

  return dates;
}

/**
 * Extracts OTA reservation events (with guest info) from parsed iCal.
 * Returns array of { uid, guestName, checkIn, checkOut, nights } objects.
 */
function extractOTAReservations(parsed, source) {
  const reservations = [];

  for (const event of Object.values(parsed)) {
    if (event.type !== 'VEVENT') continue;

    const uid     = (event.uid || '').toString();
    const summary = (event.summary || '').toString();

    const guestName = parseGuestName(summary, source);
    if (!guestName) continue; // skip hold/blocked events

    let start = event.start;
    let end   = event.end || event.start;

    if (!start) continue;
    if (!(start instanceof Date)) start = new Date(start);
    if (!(end instanceof Date))   end   = new Date(end);

    const checkIn  = new Date(start); checkIn.setHours(12, 0, 0, 0);
    const checkOut = new Date(end);   checkOut.setHours(12, 0, 0, 0);
    const nights   = Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));

    if (nights < 1) continue;

    reservations.push({ uid, guestName, checkIn, checkOut, nights });
  }

  return reservations;
}

/** Format a JS Date as DD/MM for push notification bodies */
function fmtDate(date) {
  const d = new Date(date);
  const day   = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

/** Human-readable source label */
function srcLabel(source) {
  return source === 'AIRBNB' ? 'Airbnb' : 'Booking.com';
}

/**
 * Syncs an iCal feed into BlockedDate table AND creates/updates Booking records.
 *
 * Change detection:
 *  - New UID in feed (not in DB)  → create Booking + push notification to ADMIN
 *  - UID in DB but gone from feed → cancel Booking + push notification to ADMIN
 *
 * @param {'AIRBNB'|'BOOKING_COM'} source
 * @param {string} url - iCal URL
 */
async function syncIcal(source, url) {
  if (!url) {
    console.log(`[ical-sync] No URL configured for ${source}, skipping.`);
    return { source, synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: null };
  }

  try {
    console.log(`[ical-sync] Fetching ${source} iCal…`);
    const text   = await fetchIcal(url);
    const parsed = ical.parseICS(text);
    const dates  = extractBlockedDates(parsed);
    const reservations = extractOTAReservations(parsed, source);

    console.log(`[ical-sync] ${source}: ${dates.size} blocked dates, ${reservations.length} reservations`);

    // ── 1. Upsert BlockedDates ────────────────────────────────────────────────
    let synced = 0;
    const now = new Date();

    for (const dateStr of dates) {
      await prisma.blockedDate.upsert({
        where: { date_source: { date: new Date(dateStr), source } },
        update: { syncedAt: now },
        create: { date: new Date(dateStr), source, syncedAt: now },
      });
      synced++;
    }

    // Delete BlockedDate rows no longer in the feed (cancellations on the calendar level)
    const existingBlocked = await prisma.blockedDate.findMany({
      where: { source },
      select: { id: true, date: true },
    });

    const toDelete = existingBlocked.filter(row => !dates.has(row.date.toISOString().split('T')[0]));
    if (toDelete.length > 0) {
      await prisma.blockedDate.deleteMany({ where: { id: { in: toDelete.map(r => r.id) } } });
      console.log(`[ical-sync] ${source}: removed ${toDelete.length} cancelled dates from calendar`);
    }

    // ── 2. Pre-fetch existing CONFIRMED OTA Booking records ───────────────────
    // Doing one query upfront is more efficient than N individual findUnique calls.
    const existingOTABookings = await prisma.booking.findMany({
      where: {
        source,
        status:    'CONFIRMED',
        externalId: { not: null },
      },
      select: { id: true, externalId: true, guestName: true, checkIn: true, checkOut: true, nights: true },
    });

    // Map: externalId (UID) → booking record
    const existingByUid = new Map(existingOTABookings.map(b => [b.externalId, b]));

    // Set of UIDs currently in the feed (for cancellation detection)
    const feedUids = new Set(reservations.map(r => r.uid).filter(Boolean));

    // ── 3. Process reservations from the feed ─────────────────────────────────
    let bookingsCreated = 0;

    for (const r of reservations) {
      if (!r.uid) continue;

      const existing = existingByUid.get(r.uid);

      if (existing) {
        // Update mutable fields in case they changed (name, dates)
        await prisma.booking.update({
          where: { id: existing.id },
          data:  { guestName: r.guestName, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights },
        });
        continue;
      }

      // ── New reservation: create Booking record ────────────────────────────
      const invoiceNumber = `${source.slice(0, 3)}-${createHash('sha256').update(r.uid).digest('hex').slice(0, 10).toUpperCase()}`;

      let booking;
      try {
        booking = await prisma.booking.create({
          data: {
            externalId:       r.uid,
            guestName:        r.guestName,
            guestEmail:       '',   // unknown from iCal — populated when guest registers
            guestPhone:       '',   // unknown from iCal
            checkIn:          r.checkIn,
            checkOut:         r.checkOut,
            nights:           r.nights,
            guestCount:       1,   // unknown from iCal
            extraGuests:      0,
            hasPet:           false,
            baseRatePerNight: 0,
            extraGuestFee:    0,
            petFee:           0,
            totalAmount:      0,
            status:           'CONFIRMED',
            source,
            invoiceNumber,
          },
        });
      } catch (err) {
        if (err.code === 'P2002') {
          // Race condition: concurrent sync run created this booking first — skip silently
          console.log(`[ical-sync] ${source}: booking ${r.uid.slice(-8)} already created by concurrent run`);
          continue;
        }
        throw err;
      }

      bookingsCreated++;

      // ── Auto-create incomplete-data task for ADMIN ────────────────────────
      createOtaTask(booking.id, source, r.guestName, r.checkIn)
        .catch(e => console.error(`[ical-sync] createOtaTask error:`, e.message));

      // ── GHL webhook (non-blocking) ────────────────────────────────────────
      notifyOTABooking(booking).catch(e =>
        console.error(`[ical-sync] GHL notify error for ${r.uid}:`, e.message)
      );
    }

    if (bookingsCreated > 0) {
      console.log(`[ical-sync] ${source}: created ${bookingsCreated} new booking record(s)`);
    }

    // ── 4. Detect cancelled OTA bookings (UIDs in DB but gone from feed) ─────
    // Only process bookings whose UIDs are no longer present in the current iCal feed.
    const cancelledBookings = existingOTABookings.filter(b => !feedUids.has(b.externalId));
    let bookingsCancelled = 0;

    for (const b of cancelledBookings) {
      await prisma.booking.update({
        where: { id: b.id },
        data:  { status: 'CANCELLED' },
      });

      const label = srcLabel(source);
      sendPushToRole('ADMIN', {
        title: `Reserva cancelada — ${label}`,
        body:  `${b.guestName} · ${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)} · Datas agora disponíveis`,
        type:  'OTA_BOOKING_CANCELLED',
        data:  { bookingId: b.id, source },
      }).catch(e => console.error(`[ical-sync] push (cancellation) error:`, e.message));

      bookingsCancelled++;
    }

    if (bookingsCancelled > 0) {
      console.log(`[ical-sync] ${source}: cancelled ${bookingsCancelled} OTA booking record(s)`);
    }

    return { source, synced, deleted: toDelete.length, bookingsCreated, bookingsCancelled, error: null };
  } catch (err) {
    console.error(`[ical-sync] ${source} sync failed:`, err.message);
    return { source, synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: err.message };
  }
}

/**
 * Syncs all configured iCal sources.
 */
async function syncAll() {
  const results = await Promise.allSettled([
    syncIcal('AIRBNB',      process.env.AIRBNB_ICAL_URL),
    syncIcal('BOOKING_COM', process.env.BOOKING_COM_ICAL_URL),
  ]);
  return results.map(r => r.value ?? r.reason);
}

module.exports = { syncIcal, syncAll };
