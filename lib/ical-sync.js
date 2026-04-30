'use strict';

const https      = require('https');
const ical       = require('node-ical');
const { createHash } = require('crypto');
const prisma     = require('./db');
const { notifyOTABooking } = require('./ghl-webhook');
const { sendPushToRole }   = require('./push');
const { createOtaTask }    = require('./tasks');
const { shouldSkip, recordRateLimited, recordSuccess } = require('./ical-backoff');

// OTAs (especially Airbnb) rate-limit empty/bot User-Agents. Identifying as a
// real booking system reduces 429 rates significantly.
const ICAL_USER_AGENT = 'RecantoDosIpes-BookingSync/2.1 (+https://sitiorecantodosipes.com)';

// 24h dedupe window for OTA cancellation push notifications. Trade-off: a
// booking cancelled twice within 24h (rare — e.g., admin manually re-imports
// then cancels again) will only generate ONE push. This is acceptable to
// prevent spam during transient feed issues, deploy restarts, or status
// regression bugs.
const CANCELLATION_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Admin manual-override window for the cancellation filter. If an admin
// PATCHed a booking's status within this window, the next iCal sync
// MUST NOT re-cancel it even when the OTA feed disagrees. Prevents the
// "Roberta Magalhães keeps reverting to CANCELLED every hour" bug
// (reported 2026-04-30) — Booking.com/Airbnb feeds occasionally drop a
// UID for hours due to rate-limits, timezone edge cases, or upstream
// cancellations that get reversed; admin's intent should win.
const MANUAL_OVERRIDE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Only HTTPS URLs are allowed. Follows at most ONE redirect, only to whitelisted domains.
 */
function fetchIcal(url, _redirected = false) {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https://')) {
      return reject(new Error(`iCal fetch: only HTTPS URLs are allowed (${url})`));
    }
    const req = https.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': ICAL_USER_AGENT, 'Accept': 'text/calendar, text/plain, */*' },
    }, res => {
      if (res.statusCode === 429) {
        // Consume response body to free the socket, then surface a typed error
        // so syncIcal can record backoff for this source.
        res.resume();
        const err = new Error(`iCal fetch failed: HTTP 429`);
        err.code = 'ICAL_RATE_LIMITED';
        return reject(err);
      }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (_redirected) {
          return reject(new Error('iCal fetch: too many redirects'));
        }
        const redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('https://') || !isAllowedIcalHost(redirectUrl)) {
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
 * Builds the data object for prisma.booking.create when importing an OTA
 * reservation from an iCal feed. Pure function — no side effects — so it can
 * be unit-tested in isolation without Prisma or network.
 *
 * Required fields:
 *   - source:        'AIRBNB' | 'BOOKING_COM' (OTA channel, never 'DIRECT' here)
 *   - reservation:   { uid, guestName, checkIn, checkOut, nights } from extractOTAReservations()
 *   - propertyId:    the Property cuid this OTA feed belongs to — MUST be non-empty
 *                    (callers resolve via slug lookup). Without this, the Booking
 *                    row would land with propertyId=null and be invisible in the
 *                    staff app's property-filtered list.
 *   - invoiceNumber: deterministic short ID derived from r.uid — used as the
 *                    unique key for dedup across concurrent sync runs
 */
function buildOtaBookingData({ source, reservation, propertyId, invoiceNumber }) {
  if (source !== 'AIRBNB' && source !== 'BOOKING_COM') {
    throw new Error(`buildOtaBookingData: invalid source '${source}' (expected 'AIRBNB' or 'BOOKING_COM')`);
  }
  if (!propertyId) {
    throw new Error(`buildOtaBookingData: propertyId is required (got ${propertyId === '' ? 'empty string' : propertyId})`);
  }
  return {
    externalId:       reservation.uid,
    guestName:        reservation.guestName,
    guestEmail:       '',   // unknown from iCal — populated when guest registers
    guestPhone:       '',   // unknown from iCal — admin fills via OTA task
    checkIn:          reservation.checkIn,
    checkOut:         reservation.checkOut,
    nights:           reservation.nights,
    guestCount:       0,    // unknown from iCal — admin must confirm
    extraGuests:      0,
    hasPet:           false,
    baseRatePerNight: 0,
    extraGuestFee:    0,
    petFee:           0,
    totalAmount:      0,
    status:           'CONFIRMED',
    source,
    propertyId,
    invoiceNumber,
  };
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
 * @param {string} propertyId - Property cuid this feed belongs to (attached to
 *                 each new Booking row so the staff app can filter by property)
 */
/**
 * Pure helper: partitions existing OTA bookings into "should be cancelled"
 * and "protected by recent admin override" sets.
 *
 * The cancellation filter has multiple guards stacked:
 *   1. Status must be CONFIRMED (already-cancelled bookings stay cancelled).
 *   2. UID must NOT appear in the current feed (truly missing).
 *   3. Checkout must be in the future (past stays age off the feed naturally
 *      and should remain CONFIRMED for revenue accounting).
 *   4. Cancellation dedupe — skip if we notified about this same cancellation
 *      within the dedupe window (prevents push spam from feed flapping).
 *   5. NEW (2026-04-30): admin manual-override skip — if the admin recently
 *      PATCHed status to CONFIRMED, leave it alone even when feed disagrees.
 *
 * The "protected" set is returned separately so the caller can log how
 * many bookings the override is guarding.
 *
 * @param {object} args
 * @param {Array} args.existingOTABookings   bookings with externalId set
 * @param {Set<string>} args.feedUids         UIDs currently present in the feed
 * @param {Date} args.now                     current time (injectable for tests)
 * @param {number} args.cancellationDedupeWindowMs
 * @param {number} args.manualOverrideWindowMs
 * @returns {{ toCancel: Array, protectedByOverride: Array }}
 */
function partitionOTABookingsForCancellation({
  existingOTABookings,
  feedUids,
  now,
  cancellationDedupeWindowMs,
  manualOverrideWindowMs,
}) {
  const dedupeHorizon       = new Date(now.getTime() - cancellationDedupeWindowMs);
  const overrideHorizon     = new Date(now.getTime() - manualOverrideWindowMs);

  const eligibleByBaseRules = b =>
    b.status === 'CONFIRMED' &&
    !feedUids.has(b.externalId) &&
    new Date(b.checkOut) > now;

  const stillWithinDedupe = b =>
    b.lastCancellationNotifiedAt && b.lastCancellationNotifiedAt >= dedupeHorizon;

  const stillWithinManualOverride = b =>
    b.statusManuallyOverriddenAt && b.statusManuallyOverriddenAt >= overrideHorizon;

  const candidates = existingOTABookings.filter(eligibleByBaseRules);

  return {
    toCancel:            candidates.filter(b => !stillWithinDedupe(b) && !stillWithinManualOverride(b)),
    protectedByOverride: candidates.filter(stillWithinManualOverride),
  };
}

async function syncIcal(source, url, propertyId) {
  if (!url) {
    console.log(`[ical-sync] No URL configured for ${source}, skipping.`);
    return { source, synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: null };
  }

  // Respect in-memory cooldown after a prior 429. Gives the OTA time to lift
  // the rate limit instead of hammering every cron cycle and spamming logs.
  if (shouldSkip(source)) {
    console.log(`[ical-sync] ${source}: in 429 cooldown, skipping this cycle`);
    return { source, synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: null, skipped: true };
  }

  try {
    // Validate URL against allowlist before fetching (SSRF prevention)
    if (!url.startsWith('https://') || !isAllowedIcalHost(url)) {
      throw new Error(`[ical-sync] ${source} iCal URL not allowed: ${url}`);
    }
    console.log(`[ical-sync] Fetching ${source} iCal…`);
    let text;
    try {
      text = await fetchIcal(url);
    } catch (fetchErr) {
      if (fetchErr.code === 'ICAL_RATE_LIMITED') {
        recordRateLimited(source);
        console.warn(`[ical-sync] ${source}: rate limited (HTTP 429) — backing off ~4h`);
        return { source, synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: fetchErr.message, rateLimited: true };
      }
      throw fetchErr;
    }
    recordSuccess(source);
    const parsed = ical.parseICS(text);
    const dates  = extractBlockedDates(parsed);
    const reservations = extractOTAReservations(parsed, source);

    console.log(`[ical-sync] ${source}: ${dates.size} blocked dates, ${reservations.length} reservations`);

    // Diagnostic: when we see events but 0 reservations, log a few SUMMARY fields
    // so we can figure out whether Booking.com changed their iCal format (e.g.
    // stopped sending guest names for real bookings) — without this, sync runs
    // silently and real bookings are silently dropped into BlockedDate.
    if (reservations.length === 0 && dates.size > 0) {
      const vevents = Object.values(parsed).filter(e => e.type === 'VEVENT');
      const sample = vevents.slice(0, 5).map(e => {
        const summary = (e.summary || '').toString();
        const uid = (e.uid || '').toString().slice(0, 40);
        return `  SUMMARY=${JSON.stringify(summary.slice(0, 60))} UID=${uid}`;
      }).join('\n');
      console.warn(`[ical-sync] ${source}: 0 reservations parsed from ${vevents.length} events — sample SUMMARY values:\n${sample}`);
    }

    // ── 1. Replace BlockedDates with current feed (deleteMany + createMany) ──
    // Avoids needing the @@unique([date, source]) DB constraint for upsert.
    const now = new Date();
    const dateObjects = [...dates].map(dateStr => ({
      date: new Date(dateStr),
      source,
      syncedAt: now,
    }));

    await prisma.$transaction([
      prisma.blockedDate.deleteMany({ where: { source } }),
      prisma.blockedDate.createMany({ data: dateObjects }),
    ]);
    const synced = dateObjects.length;
    console.log(`[ical-sync] ${source}: replaced blocked dates → ${synced} active`);

    // ── 2. Pre-fetch ALL OTA Booking records for this source ──────────────────
    // Includes CANCELLED so that bookings which reappear in the feed (OTA
    // temporarily removed then re-added) get re-confirmed instead of triggering
    // a duplicate INSERT → P2002 on invoiceNumber.
    const existingOTABookings = await prisma.booking.findMany({
      where: {
        source,
        externalId: { not: null },
      },
      select: {
        id: true, externalId: true, status: true, guestName: true,
        checkIn: true, checkOut: true, nights: true,
        lastCancellationNotifiedAt: true,
        // Used by the cancellation filter below to respect admin manual
        // overrides (Roberta-bug fix 2026-04-30).
        statusManuallyOverriddenAt: true,
      },
    });

    // Map: externalId (UID) → booking record
    const existingByUid = new Map(existingOTABookings.map(b => [b.externalId, b]));

    // Set of UIDs currently in the feed (for cancellation detection — only CONFIRMED)
    const feedUids = new Set(reservations.map(r => r.uid).filter(Boolean));

    // ── 3. Process reservations from the feed ─────────────────────────────────
    let bookingsCreated = 0;

    for (const r of reservations) {
      if (!r.uid) continue;

      const existing = existingByUid.get(r.uid);

      if (existing) {
        // Re-confirm if booking was previously cancelled (OTA re-added it).
        // Never overwrite guestName — admin may have manually corrected the OTA placeholder.
        const updateData = { checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights };
        if (existing.status === 'CANCELLED') updateData.status = 'CONFIRMED';
        await prisma.booking.update({ where: { id: existing.id }, data: updateData });
        continue;
      }

      // ── New reservation: create Booking record ────────────────────────────
      const invoiceNumber = `${source.slice(0, 3)}-${createHash('sha256').update(r.uid).digest('hex').slice(0, 10).toUpperCase()}`;

      let booking;
      try {
        booking = await prisma.booking.create({
          data: buildOtaBookingData({ source, reservation: r, propertyId, invoiceNumber }),
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
    // Only evaluate FUTURE bookings: past stays naturally age off the iCal feed after
    // checkout and should remain CONFIRMED. Cancelling them would corrupt historical revenue.
    //
    // Safety guard: if the feed returned 0 reservations but the DB has ≥2 confirmed future
    // OTA bookings, the feed is likely temporarily empty (network hiccup, rate-limit, OTA
    // server issue). Skip all cancellations to prevent a mass false-cancel storm.
    const confirmedFutureCount = existingOTABookings.filter(b =>
      b.status === 'CONFIRMED' && new Date(b.checkOut) > now
    ).length;

    if (reservations.length === 0 && confirmedFutureCount >= 2) {
      console.warn(`[ical-sync] ${source}: feed returned 0 reservations but DB has ${confirmedFutureCount} confirmed future booking(s) — skipping cancellation to avoid false storm`);
      return { source, synced, deleted: 0, bookingsCreated, bookingsCancelled: 0, error: null };
    }

    // Use the pure helper so the cancellation filter is unit-testable.
    const { toCancel: cancelledBookings, protectedByOverride: protectedFromCancel } =
      partitionOTABookingsForCancellation({
        existingOTABookings,
        feedUids,
        now,
        cancellationDedupeWindowMs: CANCELLATION_NOTIFICATION_WINDOW_MS,
        manualOverrideWindowMs:     MANUAL_OVERRIDE_WINDOW_MS,
      });

    // Surface override-protected skips in the logs so prolonged feed
    // disagreements are visible without burying the signal in routine output.
    if (protectedFromCancel.length > 0) {
      console.log(`[ical-sync] ${source}: ${protectedFromCancel.length} booking(s) absent from feed but protected by recent admin manual override — leaving CONFIRMED`);
    }
    let bookingsCancelled = 0;

    // Step 1: Mark cancellation in DB (status only — do not stamp the notify
    // timestamp yet, so a push failure can still be retried on the next cycle).
    for (const b of cancelledBookings) {
      await prisma.booking.update({
        where: { id: b.id },
        data:  { status: 'CANCELLED' },
      });
      bookingsCancelled++;
    }

    // Step 2: Send a single batched push notification, then stamp lastCancellationNotifiedAt
    // only on success. If the push fails, the next sync cycle finds these bookings as
    // status=CANCELLED so the existing status filter excludes them — meaning a failed
    // push will NOT be retried automatically. The 24h dedupe purely guards against
    // transient regressions where status flips back to CONFIRMED.
    if (bookingsCancelled > 0) {
      console.log(`[ical-sync] ${source}: cancelled ${bookingsCancelled} OTA booking record(s)`);
      const label = srcLabel(source);
      const names = cancelledBookings.slice(0, 2).map(b => b.guestName).join(', ');
      const extra = cancelledBookings.length > 2 ? ` e mais ${cancelledBookings.length - 2}` : '';
      const bodyText = bookingsCancelled === 1
        ? `${cancelledBookings[0].guestName} · ${fmtDate(cancelledBookings[0].checkIn)} → ${fmtDate(cancelledBookings[0].checkOut)}`
        : `${names}${extra} · Datas agora disponíveis`;

      let pushSucceeded = false;
      try {
        await sendPushToRole('ADMIN', {
          title: `${bookingsCancelled} reserva${bookingsCancelled > 1 ? 's' : ''} cancelada${bookingsCancelled > 1 ? 's' : ''} — ${label}`,
          body:  bodyText,
          type:  'OTA_BOOKING_CANCELLED',
          data:  { source, count: bookingsCancelled },
        });
        pushSucceeded = true;
      } catch (e) {
        console.error(`[ical-sync] push (cancellation) error:`, e.message);
      }

      // Stamp lastCancellationNotifiedAt only after the push actually went through.
      if (pushSucceeded) {
        const stampedAt = new Date();
        await prisma.booking.updateMany({
          where: { id: { in: cancelledBookings.map(b => b.id) } },
          data:  { lastCancellationNotifiedAt: stampedAt },
        });
      }
    }

    return { source, synced, deleted: 0, bookingsCreated, bookingsCancelled, error: null };
  } catch (err) {
    console.error(`[ical-sync] ${source} sync failed:`, err.message);
    return { source, synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: err.message };
  }
}

/**
 * Syncs all configured iCal sources — sequentially to avoid invoice number
 * collisions when the same booking UID appears in both feeds (channel manager scenario).
 *
 * Currently both feeds belong to the SRI property (slug='recanto-dos-ipes').
 * When multi-property iCal sync lands, this resolves per-feed via configured
 * URLs on the Property model instead.
 */
async function syncAll() {
  const sri = await prisma.property.findUnique({
    where:  { slug: 'recanto-dos-ipes' },
    select: { id: true },
  });
  const propertyId = sri?.id ?? null;
  if (!propertyId) {
    // Without a resolvable property, skip OTA sync rather than create orphan
    // bookings. BlockedDate sync could proceed (no FK), but that half-done
    // state is worse than a clean skip — admins would see blocked dates with
    // no matching reservations.
    console.error('[ical-sync] SRI property not found by slug=recanto-dos-ipes — skipping iCal sync to avoid creating propertyId=null bookings');
    return [
      { source: 'AIRBNB',      synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: 'SRI property missing' },
      { source: 'BOOKING_COM', synced: 0, deleted: 0, bookingsCreated: 0, bookingsCancelled: 0, error: 'SRI property missing' },
    ];
  }
  const airbnb     = await syncIcal('AIRBNB',      process.env.AIRBNB_ICAL_URL,      propertyId);
  const bookingCom = await syncIcal('BOOKING_COM', process.env.BOOKING_COM_ICAL_URL, propertyId);
  return [airbnb, bookingCom];
}

module.exports = {
  syncIcal,
  syncAll,
  // Exposed for unit tests (pure functions, safe to export).
  buildOtaBookingData,
  parseGuestName,
  extractBlockedDates,
  isAllowedIcalHost,
  partitionOTABookingsForCancellation,
  // Exposed for tests that want to assert on the production window values.
  MANUAL_OVERRIDE_WINDOW_MS,
  CANCELLATION_NOTIFICATION_WINDOW_MS,
};
