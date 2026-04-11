'use strict';

let stripe, cardElement;
let currentBookingId  = null;
let currentBookingEmail = null;
let quoteTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  // Read URL params
  const params   = new URLSearchParams(window.location.search);
  const checkIn  = params.get('checkIn');
  const checkOut = params.get('checkOut');
  const guests   = params.get('guests');
  const pet      = params.get('pet');

  if (checkIn)  document.getElementById('f-checkin').value  = checkIn;
  if (checkOut) document.getElementById('f-checkout').value = checkOut;
  if (guests)   document.getElementById('f-guests').value   = guests;
  if (pet)      document.getElementById('f-pet').value      = pet;

  // Fetch Stripe publishable key from server
  let pk = '';
  try {
    const configRes = await fetch('/api/config/stripe');
    if (configRes.ok) {
      const cfg = await configRes.json();
      pk = cfg.publishableKey || '';
    }
  } catch {}

  if (pk) {
    stripe      = Stripe(pk);
    const elements = stripe.elements();
    cardElement = elements.create('card', {
      style: {
        base: { fontSize: '15px', color: '#261C15', fontFamily: 'Lato, sans-serif',
                '::placeholder': { color: '#9A9A9A' } },
      },
    });
    cardElement.mount('#stripe-card');
    cardElement.on('change', e => {
      const errEl = document.getElementById('card-error');
      if (e.error) { errEl.textContent = e.error.message; errEl.classList.remove('hidden'); }
      else          errEl.classList.add('hidden');
    });
  } else {
    document.getElementById('stripe-card').innerHTML =
      '<p class="text-xs text-stone">Stripe não configurado. Adicione STRIPE_PUBLISHABLE_KEY.</p>';
  }

  // Load initial quote
  if (checkIn && checkOut) fetchQuote();

  // Re-quote when dates/guests/pet change
  ['f-checkin','f-checkout','f-guests','f-pet'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      clearTimeout(quoteTimer);
      quoteTimer = setTimeout(fetchQuote, 500);
    });
  });
})();

// ── Quote ─────────────────────────────────────────────────────────────────────
async function fetchQuote() {
  const checkIn  = document.getElementById('f-checkin').value;
  const checkOut = document.getElementById('f-checkout').value;
  const guests   = document.getElementById('f-guests').value;
  const pet      = document.getElementById('f-pet').value;

  if (!checkIn || !checkOut) return;

  showSummary('loading');

  try {
    const res  = await fetch(`/api/bookings/quote?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}&pet=${pet}`);
    const data = await res.json();

    if (!res.ok) { showSummary('error', data.error); return; }

    renderSummary(data);
    showSummary('content');
  } catch {
    showSummary('error', 'Erro ao calcular preço');
  }
}

function renderSummary(q) {
  const rows = [`<div class="flex justify-between"><span class="text-white/75">${q.nights} noite${q.nights > 1 ? 's' : ''} × ${q.formatted.baseRatePerNight}</span><span class="font-semibold">${q.formatted.baseSubtotal}</span></div>`];
  if (q.extraGuests > 0) {
    rows.push(`<div class="flex justify-between"><span class="text-white/75">${q.extraGuests} extra${q.extraGuests > 1 ? 's' : ''} × R$50 × ${q.nights}n</span><span class="font-semibold">${q.formatted.extraGuestFee}</span></div>`);
  }
  if (q.hasPet) {
    rows.push(`<div class="flex justify-between"><span class="text-white/75">Pet (taxa única)</span><span class="font-semibold">${q.formatted.petFee}</span></div>`);
  }
  document.getElementById('summary-rows').innerHTML = rows.join('');
  document.getElementById('summary-total').textContent   = q.formatted.totalAmount;
  document.getElementById('summary-season').textContent  = q.seasonName;
}

function showSummary(state, msg) {
  document.getElementById('summary-loading').classList.toggle('hidden', state !== 'loading');
  document.getElementById('summary-content').classList.toggle('hidden', state !== 'content');
  const errEl = document.getElementById('summary-error');
  errEl.classList.toggle('hidden', state !== 'error');
  if (msg) errEl.textContent = msg;
}

// ── Submit booking ────────────────────────────────────────────────────────────
async function submitBooking() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Processando…';
  hideError('form-error');

  const checkIn  = document.getElementById('f-checkin').value;
  const checkOut = document.getElementById('f-checkout').value;
  const guests   = parseInt(document.getElementById('f-guests').value);
  const pet      = document.getElementById('f-pet').value === 'true';
  const name     = document.getElementById('f-name').value.trim();
  const email    = document.getElementById('f-email').value.trim();
  const phone    = document.getElementById('f-phone').value.trim();
  const cpf      = document.getElementById('f-cpf').value.trim();
  const notes    = document.getElementById('f-notes').value.trim();

  if (!checkIn || !checkOut || !name || !email || !phone) {
    showError('form-error', 'Preencha todos os campos obrigatórios');
    btn.disabled = false; btn.textContent = 'Confirmar e pagar';
    return;
  }

  try {
    // 1. Create PaymentIntent
    const intentRes = await fetch('/api/bookings/intent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkIn, checkOut, guestCount: guests, hasPet: pet,
        guestName: name, guestEmail: email, guestPhone: phone,
        guestCpf: cpf || undefined, notes: notes || undefined,
      }),
    });
    const intentData = await intentRes.json();

    if (!intentRes.ok) {
      showError('form-error', intentData.error || 'Erro ao criar reserva');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    const { clientSecret, bookingId } = intentData;
    currentBookingId    = bookingId;
    currentBookingEmail = email;

    // 2. Confirm card payment
    if (!stripe || !cardElement) {
      showError('form-error', 'Stripe não inicializado. Configure STRIPE_PUBLISHABLE_KEY.');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    const { error: stripeError } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card: cardElement,
        billing_details: { name, email },
      },
    });

    if (stripeError) {
      showError('form-error', stripeError.message || 'Falha no pagamento');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    // 3. Confirm on our server
    const confirmRes  = await fetch('/api/bookings/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: clientSecret.split('_secret_')[0], bookingId }),
    });
    const confirmData = await confirmRes.json();

    if (!confirmRes.ok) {
      // Payment succeeded but DB confirm failed — show a warning (not a payment error)
      console.warn('Confirm error:', confirmData);
    }

    // 4. Show success modal
    showSuccessModal(confirmData.booking || { invoiceNumber: bookingId, checkIn, checkOut, guestCount: guests });
    document.getElementById('success-email').value = email;

  } catch (err) {
    showError('form-error', 'Erro inesperado. Tente novamente ou entre em contato.');
    btn.disabled = false; btn.textContent = 'Confirmar e pagar';
    console.error(err);
  }
}

function showSuccessModal(booking) {
  const info = document.getElementById('success-booking-info');
  const fmt = (d) => new Date(d).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
  info.innerHTML = `
    <div class="space-y-1 text-sm">
      <div class="flex justify-between"><span class="text-stone">Check-in</span><span class="font-semibold text-forest">${fmt(booking.checkIn || booking.checkIn)}</span></div>
      <div class="flex justify-between"><span class="text-stone">Check-out</span><span class="font-semibold text-forest">${fmt(booking.checkOut || booking.checkOut)}</span></div>
      <div class="flex justify-between"><span class="text-stone">Hóspedes</span><span class="font-semibold text-forest">${booking.guestCount}</span></div>
      <div class="flex justify-between"><span class="text-stone">Total</span><span class="font-semibold text-forest">${booking.totalAmount ? 'R$ ' + Number(booking.totalAmount).toLocaleString('pt-BR', {minimumFractionDigits:2}) : '—'}</span></div>
      <div class="flex justify-between"><span class="text-stone">Reserva nº</span><span class="text-xs font-mono text-stone">${booking.invoiceNumber || currentBookingId}</span></div>
    </div>
  `;
  document.getElementById('success-modal').classList.remove('hidden');
}

// ── Account creation ──────────────────────────────────────────────────────────
async function createAccount() {
  const email = document.getElementById('success-email').value.trim();
  if (!email) return;

  document.getElementById('success-sent-to').textContent = email;
  currentBookingEmail = email;

  const res  = await fetch('/api/auth/send-code', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, purpose: 'LINK_BOOKING' }),
  });

  if (res.ok) {
    document.getElementById('create-account-form').classList.add('hidden');
    document.getElementById('create-account-otp').classList.remove('hidden');
  }
}

async function verifyAccountCode() {
  const code = document.getElementById('success-code').value.trim();

  const res  = await fetch('/api/auth/verify-code', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: currentBookingEmail, code, purpose: 'LINK_BOOKING' }),
  });

  if (res.ok && currentBookingId) {
    // Link booking to new account
    await fetch(`/api/bookings/${currentBookingId}/link-account`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    window.location.href = '/dashboard';
  }
}

function skipAccount() {
  window.location.href = '/';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
