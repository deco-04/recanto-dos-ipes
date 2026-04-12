'use strict';

let currentBooking = null;
let currentEmail   = '';

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // 1. Try sessionStorage first (set by booking.js after payment)
  let booking = null;
  try {
    const raw = sessionStorage.getItem('rdi_booking_confirmation');
    if (raw) {
      booking = JSON.parse(raw);
      sessionStorage.removeItem('rdi_booking_confirmation'); // consume once
    }
  } catch { /* ignore */ }

  // 2. Fall back to ?booking= URL param → call receipt API
  if (!booking) {
    const params = new URLSearchParams(window.location.search);
    const bookingId = params.get('booking');
    if (bookingId) {
      try {
        const res  = await fetch(`/api/bookings/receipt/${encodeURIComponent(bookingId)}`);
        if (res.ok) booking = await res.json();
      } catch { /* network error — show not-found */ }
    }
  }

  if (!booking) {
    showState('notfound');
    return;
  }

  currentBooking = booking;
  renderBooking(booking);

  // 3. Check if user has an active session
  try {
    const meRes = await fetch('/api/auth/me');
    if (meRes.ok) {
      showSection('cta-dashboard');
    } else {
      // Pre-fill email from booking data
      if (booking.guestEmail) {
        document.getElementById('acc-email').value = booking.guestEmail;
        currentEmail = booking.guestEmail;
      }
      showSection('cta-create-account');
    }
  } catch {
    showSection('cta-create-account');
  }

  showState('confirmed');
})();

// ── Render booking details ─────────────────────────────────────────────────────
function renderBooking(booking) {
  const fmt = (d) => new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });

  document.getElementById('detail-checkin').textContent  = fmt(booking.checkIn);
  document.getElementById('detail-checkout').textContent = fmt(booking.checkOut);
  document.getElementById('detail-nights').textContent   = booking.nights ? `${booking.nights} noite${booking.nights > 1 ? 's' : ''}` : '—';
  document.getElementById('detail-guests').textContent   = booking.guestCount ? `${booking.guestCount} pessoa${booking.guestCount > 1 ? 's' : ''}` : '—';
  document.getElementById('detail-total').textContent    = booking.totalAmount
    ? 'R$ ' + Number(booking.totalAmount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })
    : '—';
  document.getElementById('detail-invoice').textContent  = booking.invoiceNumber || booking.id || '—';

  if (booking.guestEmail) {
    document.getElementById('detail-email').textContent = booking.guestEmail;
  } else {
    document.getElementById('email-reminder').classList.add('hidden');
  }

  if (booking.hasPet) {
    document.getElementById('pet-notice').classList.remove('hidden');
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────
function showState(state) {
  ['loading', 'notfound', 'confirmed'].forEach(s =>
    document.getElementById(`state-${s}`).classList.toggle('hidden', s !== state)
  );
}

function showSection(id) {
  document.getElementById(id).classList.remove('hidden');
}

// ── Account creation OTP flow ─────────────────────────────────────────────────
async function accSendCode() {
  const email = document.getElementById('acc-email').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAccError('acc-email-error', 'Digite um e-mail válido');
    return;
  }
  hideAccError('acc-email-error');
  accSetLoading(true);

  try {
    const res = await fetch('/api/auth/send-code', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, purpose: 'LINK_BOOKING' }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showAccError('acc-email-error', data.error || 'Erro ao enviar código');
      accSetLoading(false);
      return;
    }
    currentEmail = email;
    document.getElementById('acc-sent-to').textContent = email;
    document.getElementById('acc-step-email').classList.add('hidden');
    document.getElementById('acc-step-otp').classList.remove('hidden');
    document.getElementById('acc-code').focus();
  } catch {
    showAccError('acc-email-error', 'Erro de conexão. Tente novamente.');
  }
  accSetLoading(false);
}

async function accVerifyCode() {
  const code = document.getElementById('acc-code').value.trim();
  if (code.length !== 6) {
    showAccError('acc-code-error', 'Digite o código de 6 dígitos');
    return;
  }
  hideAccError('acc-code-error');
  accSetLoading(true);

  try {
    const res = await fetch('/api/auth/verify-code', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, code, purpose: 'LINK_BOOKING' }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showAccError('acc-code-error', data.error || 'Código inválido');
      accSetLoading(false);
      return;
    }
    window.location.href = '/dashboard';
  } catch {
    showAccError('acc-code-error', 'Erro de conexão. Tente novamente.');
    accSetLoading(false);
  }
}

function accBackToEmail() {
  document.getElementById('acc-step-otp').classList.add('hidden');
  document.getElementById('acc-step-email').classList.remove('hidden');
  document.getElementById('acc-code').value = '';
  hideAccError('acc-code-error');
}

function accSetLoading(on) {
  const loadEl  = document.getElementById('acc-loading');
  const emailEl = document.getElementById('acc-step-email');
  const otpEl   = document.getElementById('acc-step-otp');
  if (on) {
    loadEl.classList.remove('hidden');
    emailEl.classList.add('hidden');
    otpEl.classList.add('hidden');
  } else {
    loadEl.classList.add('hidden');
    if (currentEmail) {
      otpEl.classList.remove('hidden');
    } else {
      emailEl.classList.remove('hidden');
    }
  }
}

function showAccError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function hideAccError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// ── .ics calendar download ────────────────────────────────────────────────────
function downloadIcs() {
  if (!currentBooking) return;

  const formatIcsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const checkIn  = formatIcsDate(currentBooking.checkIn);
  const checkOut = formatIcsDate(currentBooking.checkOut);
  const uid      = `booking-${currentBooking.id || Date.now()}@sitiorecantodosipes.com`;
  const now      = formatIcsDate(new Date());
  const invoice  = currentBooking.invoiceNumber || currentBooking.id || '';

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sítio Recanto dos Ipês//Reserva//PT',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${checkIn}`,
    `DTEND:${checkOut}`,
    `SUMMARY:Estadia — Sítio Recanto dos Ipês`,
    `DESCRIPTION:Reserva nº ${invoice}\\nJaboticatubas\\, MG`,
    'LOCATION:Jaboticatubas\\, MG\\, Brasil',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `reserva-recanto-ipes.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Enter key support ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('acc-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') accSendCode();
  });
  document.getElementById('acc-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') accVerifyCode();
  });
  document.getElementById('acc-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
});
