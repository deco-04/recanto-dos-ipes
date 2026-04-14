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

/**
 * Fires when a direct booking lands as REQUESTED (pre-auth held, awaiting admin).
 * GHL workflow: create/update contact → move to "Solicitação" pipeline stage → fire request-received automation.
 *
 * Set GHL_BOOKING_REQUESTED_URL env var to your GHL workflow webhook URL.
 */
async function notifyBookingRequested(booking) {
  const url = process.env.GHL_BOOKING_REQUESTED_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:          'booking.requested',
    bookingId:      booking.id,
    invoiceNumber:  booking.invoiceNumber,
    guestName:      booking.guestName,
    guestEmail:     booking.guestEmail,
    guestPhone:     booking.guestPhone,
    checkIn:        booking.checkIn,
    checkOut:       booking.checkOut,
    nights:         booking.nights,
    guestCount:     booking.guestCount,
    hasPet:         booking.hasPet,
    petDescription: booking.petDescription || null,
    totalAmount:    Number(booking.totalAmount),
    source:         booking.source,
    createdAt:      booking.createdAt,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] notifyBookingRequested error:', e.message)
  );
}

/**
 * Fires when admin declines a booking (REQUESTED → CANCELLED).
 * GHL workflow: move contact to "Recusada/Cancelada" stage → tag recusa-nurture → enter re-engagement sequence.
 *
 * Set GHL_BOOKING_DECLINED_URL env var to your GHL workflow webhook URL.
 */
async function notifyBookingDeclined(booking) {
  const url = process.env.GHL_BOOKING_DECLINED_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:          'booking.declined',
    bookingId:      booking.id,
    invoiceNumber:  booking.invoiceNumber,
    guestName:      booking.guestName,
    guestEmail:     booking.guestEmail,
    guestPhone:     booking.guestPhone,
    checkIn:        booking.checkIn,
    checkOut:       booking.checkOut,
    nights:         booking.nights,
    guestCount:     booking.guestCount,
    hasPet:         booking.hasPet,
    petDescription: booking.petDescription || null,
    totalAmount:    Number(booking.totalAmount),
    source:         booking.source,
    declineReason:  booking.adminDeclineNote || null,
    createdAt:      booking.createdAt,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] notifyBookingDeclined error:', e.message)
  );
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

/**
 * Sends a D-7 WhatsApp reminder to the guest requesting the guest list
 * (names, vehicles, plates) by D-4.
 * Fires GHL_GUEST_LIST_WEBHOOK_URL or falls back to GHL_WEBHOOK_URL.
 */
async function sendGuestListReminder(booking) {
  const url = process.env.GHL_GUEST_LIST_WEBHOOK_URL || process.env.GHL_WEBHOOK_URL;
  if (!url) return;

  const checkInDate  = new Date(booking.checkIn);
  const checkInFmt   = checkInDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const deadline     = new Date(checkInDate);
  deadline.setDate(deadline.getDate() - 4);
  const deadlineFmt  = deadline.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  const payload = JSON.stringify({
    event:      'guest_list.reminder',
    bookingId:  booking.id,
    guestName:  booking.guestName,
    guestPhone: booking.guestPhone,
    checkIn:    booking.checkIn,
    checkInFmt,
    deadlineFmt,
    message:    `Olá ${booking.guestName}! 🏡 Sua reserva no Sítio Recanto dos Ipês está confirmada para ${checkInFmt}.\n\nPara garantir uma entrada tranquila, precisamos da lista de hóspedes até ${deadlineFmt} com:\n• Nome completo de cada hóspede\n• Veículo e placa (se houver)\n\nResponda aqui mesmo! 😊`,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] sendGuestListReminder error:', e.message)
  );
}

/**
 * Sends the formatted guest list to the porteiro via WhatsApp.
 * @param {object} booking - The booking record
 * @param {Array<{name, vehicle?, plate?, isMain?}>} entries - The guest list
 * @param {string} porteiroPhone - Porteiro's WhatsApp number
 */
async function sendPorteiroMessage(booking, entries, porteiroPhone) {
  const url = process.env.GHL_PORTEIRO_WEBHOOK_URL || process.env.GHL_WEBHOOK_URL;
  if (!url || !porteiroPhone) return;

  const checkInDate  = new Date(booking.checkIn);
  const checkOutDate = new Date(booking.checkOut);
  const checkInFmt   = checkInDate.toLocaleDateString('pt-BR',  { day: '2-digit', month: '2-digit', year: 'numeric' });
  const checkOutFmt  = checkOutDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  const hospedeLines = entries.map((e, i) => {
    let line = `${i + 1}. ${e.name}`;
    if (e.vehicle || e.plate) {
      const veh = [e.vehicle, e.plate].filter(Boolean).join(' · ');
      line += ` — ${veh}`;
    }
    return line;
  }).join('\n');

  const message = [
    `🏡 *Lista de Hóspedes — Sítio Recanto dos Ipês*`,
    `Reserva: ${booking.guestName}`,
    `Check-in: ${checkInFmt}`,
    `Check-out: ${checkOutFmt}`,
    ``,
    `*Hóspedes:*`,
    hospedeLines,
    ``,
    `Pet: ${booking.hasPet ? 'Sim' : 'Não'}`,
    `Hóspedes: ${booking.guestCount}`,
  ].join('\n');

  const payload = JSON.stringify({
    event:         'porteiro.guest_list',
    bookingId:     booking.id,
    porteiroPhone,
    message,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] sendPorteiroMessage error:', e.message)
  );
}

/**
 * Sends an outbound WhatsApp message via GHL bridge.
 * @param {string} phone - Recipient's WhatsApp number
 * @param {string} body  - Message text
 * @param {string} conversationId - Internal conversation ID (for GHL matching)
 */
async function sendWhatsAppMessage(phone, body, conversationId) {
  const url = process.env.GHL_WHATSAPP_WEBHOOK_URL || process.env.GHL_WEBHOOK_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:          'inbox.send_whatsapp',
    phone,
    body,
    conversationId,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] sendWhatsAppMessage error:', e.message)
  );
}

/**
 * Sends an outbound Instagram DM via GHL bridge.
 * @param {string} instagramId - Recipient's Instagram user ID (from GHL contact)
 * @param {string} body        - Message text
 * @param {string} conversationId - Internal conversation ID
 */
async function sendInstagramDM(instagramId, body, conversationId) {
  const url = process.env.GHL_INSTAGRAM_WEBHOOK_URL || process.env.GHL_WEBHOOK_URL;
  if (!url) return;

  const payload = JSON.stringify({
    event:          'inbox.send_instagram',
    instagramId,
    body,
    conversationId,
  });

  return postJson(url, payload).catch(e =>
    console.error('[ghl] sendInstagramDM error:', e.message)
  );
}

module.exports = {
  notifyBookingConfirmed,
  notifyBookingRequested,   // ← new
  notifyBookingDeclined,    // ← new
  notifyOTABooking,
  notifyContactCreated,
  sendGuestListReminder,
  sendPorteiroMessage,
  sendWhatsAppMessage,
  sendInstagramDM,
};
