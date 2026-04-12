'use strict';

/**
 * iCal export — GET /api/ical/direct
 *
 * Returns a valid RFC 5545 iCal feed of all CONFIRMED direct bookings.
 * Import this URL into Airbnb and Booking.com so those platforms block
 * the dates automatically (reverse sync).
 *
 * Secured with a token query parameter so it isn't publicly discoverable.
 * Set ICAL_SECRET env var; falls back to ADMIN_SECRET.
 */

const express = require('express');
const prisma  = require('../lib/db');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a JS Date as iCal DATE value (YYYYMMDD) — no time, no timezone */
function toIcalDate(d) {
  const date = new Date(d);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Escape iCal text values (RFC 5545 §3.3.11) */
function escapeText(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Fold long iCal lines at 75 octets (RFC 5545 §3.1) */
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const chars = [...line]; // unicode-safe
  const chunks = [];
  let current  = '';
  for (const ch of chars) {
    const candidate = current + ch;
    if (Buffer.byteLength(candidate, 'utf8') > 75) {
      chunks.push(current);
      current = ' ' + ch; // continuation lines start with a space
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.join('\r\n');
}

// ── GET /api/ical/direct ──────────────────────────────────────────────────────
router.get('/direct', async (req, res) => {
  // Validate token
  const secret = process.env.ICAL_SECRET || process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).send('iCal export not configured (ICAL_SECRET not set)');
  }
  if (req.query.token !== secret) {
    return res.status(401).send('Unauthorized');
  }

  try {
    const bookings = await prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        source: 'DIRECT',
      },
      select: {
        id:            true,
        invoiceNumber: true,
        checkIn:       true,
        checkOut:      true,
        guestName:     true,
        createdAt:     true,
        updatedAt:     true,
      },
      orderBy: { checkIn: 'asc' },
    });

    const now    = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') + 'Z';
    const prodId = '-//Sítio Recanto dos Ipês//Direct Bookings//PT';
    const calUrl = process.env.PUBLIC_URL
      ? `${process.env.PUBLIC_URL}/api/ical/direct`
      : 'https://sitiorecantodosipes.com/api/ical/direct';

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${prodId}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Sítio Recanto dos Ipês — Reservas Diretas`,
      `X-WR-TIMEZONE:America/Sao_Paulo`,
      `REFRESH-INTERVAL;VALUE=DURATION:PT4H`,
      `X-PUBLISHED-TTL:PT4H`,
      `SOURCE:${calUrl}`,
    ];

    for (const b of bookings) {
      // Unique, stable UID — survives booking updates
      const uid = `sri-direct-${b.id}@sitiorecantodosipes.com`;

      // DTEND for all-day blocking: Airbnb/Booking treat DTEND as exclusive
      // so check-out day itself is NOT blocked, matching OTA conventions.
      const dtStart = toIcalDate(b.checkIn);
      const dtEnd   = toIcalDate(b.checkOut);

      // DTSTAMP: time the event was last updated (RFC 5545 required field)
      const dtstamp = b.updatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') + 'Z';

      // Summary: "Reserved" hides guest details from OTA platforms
      const summary = escapeText('Reserved');

      lines.push('BEGIN:VEVENT');
      lines.push(foldLine(`UID:${uid}`));
      lines.push(`DTSTAMP:${dtstamp}`);
      lines.push(`DTSTART;VALUE=DATE:${dtStart}`);
      lines.push(`DTEND;VALUE=DATE:${dtEnd}`);
      lines.push(foldLine(`SUMMARY:${summary}`));
      lines.push(`TRANSP:OPAQUE`);
      lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    const icsBody = lines.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="recanto-direct-bookings.ics"');
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.send(icsBody);
  } catch (err) {
    console.error('[ical-export] error:', err);
    res.status(500).send('Erro ao gerar calendário');
  }
});

module.exports = router;
