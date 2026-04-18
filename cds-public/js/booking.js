'use strict';

let stripe, cardElement;
let currentBookingId    = null;
let currentBookingEmail = null;
let quoteTimer          = null;
let cabinSlug           = null;

const CABIN_LABELS = {
  'cabana-a': 'Cabana A',
  'cabana-b': 'Cabana B',
};

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  const params   = new URLSearchParams(window.location.search);
  const checkIn  = params.get('checkIn');
  const checkOut = params.get('checkOut');
  const guests   = params.get('guests');
  const petCount = parseInt(params.get('petCount')) || 0;
  cabinSlug      = params.get('cabin') || 'cabana-a';

  // Update cabin label
  const cabinLabelEl = document.getElementById('cabin-label');
  if (cabinLabelEl) cabinLabelEl.textContent = CABIN_LABELS[cabinSlug] || 'Cabana';
  const summaryCabinEl = document.getElementById('summary-cabin-name');
  if (summaryCabinEl) summaryCabinEl.textContent = `${CABIN_LABELS[cabinSlug] || 'Cabana'} · Cabanas da Serra · Jaboticatubas, MG`;

  if (checkIn)  document.getElementById('f-checkin').value  = checkIn;
  if (checkOut) document.getElementById('f-checkout').value = checkOut;
  if (guests)   document.getElementById('f-guests').value   = guests;

  if (petCount > 0) {
    document.getElementById('f-pet-toggle').checked = true;
    document.getElementById('pet-count-display').textContent = String(Math.min(petCount, 4));
    updatePetUI();
  }

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
        base: {
          fontSize: '15px', color: '#2D5A4A', fontFamily: 'Inter, sans-serif',
          '::placeholder': { color: '#B0B8B4' },
        },
      },
    });
    cardElement.mount('#stripe-card');
    cardElement.on('change', e => {
      const errEl = document.getElementById('card-error');
      if (e.error) { errEl.textContent = e.error.message; errEl.classList.remove('hidden'); }
      else errEl.classList.add('hidden');
    });
  } else {
    document.getElementById('stripe-card').innerHTML =
      '<p class="text-xs text-stone">Stripe não configurado. Adicione STRIPE_PUBLISHABLE_KEY.</p>';
  }

  if (checkIn && checkOut) fetchQuote();

  ['f-checkin', 'f-checkout', 'f-guests'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      clearTimeout(quoteTimer);
      quoteTimer = setTimeout(fetchQuote, 500);
    });
  });

  document.getElementById('f-pet-toggle')?.addEventListener('change', () => {
    updatePetUI();
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 500);
  });
  document.getElementById('pet-minus')?.addEventListener('click', () => {
    const disp = document.getElementById('pet-count-display');
    const cur  = parseInt(disp.textContent) || 1;
    if (cur > 1) { disp.textContent = String(cur - 1); updatePetLabel(); scheduleQuoteFromPet(); }
  });
  document.getElementById('pet-plus')?.addEventListener('click', () => {
    const disp = document.getElementById('pet-count-display');
    const cur  = parseInt(disp.textContent) || 1;
    if (cur < 4) { disp.textContent = String(cur + 1); updatePetLabel(); scheduleQuoteFromPet(); }
  });

  function scheduleQuoteFromPet() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 500);
  }
})();

// ── Pet helpers ───────────────────────────────────────────────────────────────
function updatePetLabel() {
  const count = parseInt(document.getElementById('pet-count-display').textContent) || 1;
  document.getElementById('pet-label').textContent = count === 1 ? '1 pet' : `${count} pets`;
}

function updatePetUI() {
  const on       = document.getElementById('f-pet-toggle').checked;
  const countRow = document.getElementById('pet-count-row');
  const notice   = document.getElementById('pet-notice');
  const descRow  = document.getElementById('pet-description-row');
  countRow.classList.toggle('hidden', !on);
  notice.classList.toggle('hidden', !on);
  if (descRow) descRow.classList.toggle('hidden', !on);
  document.getElementById('pet-label').textContent = on
    ? (parseInt(document.getElementById('pet-count-display').textContent) === 1 ? '1 pet' : `${document.getElementById('pet-count-display').textContent} pets`)
    : 'Sem pets';
}

function getPetCount() {
  const on = document.getElementById('f-pet-toggle').checked;
  if (!on) return 0;
  return parseInt(document.getElementById('pet-count-display').textContent) || 1;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
}
function fmtCur(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ── Quote ─────────────────────────────────────────────────────────────────────
async function fetchQuote() {
  const checkIn  = document.getElementById('f-checkin').value;
  const checkOut = document.getElementById('f-checkout').value;
  const guests   = document.getElementById('f-guests').value;
  const petCount = getPetCount();

  if (!checkIn || !checkOut) {
    document.getElementById('summary-loading').classList.remove('hidden');
    document.getElementById('summary-content').classList.add('hidden');
    return;
  }

  document.getElementById('summary-loading').classList.remove('hidden');
  document.getElementById('summary-content').classList.add('hidden');

  try {
    const res = await fetch(
      `/api/bookings/quote?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}&petCount=${petCount}&cabinSlug=${encodeURIComponent(cabinSlug)}`,
    );
    if (!res.ok) {
      document.getElementById('summary-loading').querySelector('p').textContent = 'Erro ao calcular cotação.';
      return;
    }
    const q = await res.json();

    // Dates
    document.getElementById('summary-dates').innerHTML = `
      <div class="flex justify-between text-sm">
        <span class="text-white/65">Check-in</span>
        <span class="font-semibold">${fmtDate(checkIn)}</span>
      </div>
      <div class="flex justify-between text-sm mt-1">
        <span class="text-white/65">Check-out</span>
        <span class="font-semibold">${fmtDate(checkOut)}</span>
      </div>
    `;

    // Breakdown
    let rows = '';
    rows += `<div class="flex justify-between text-sm"><span class="text-white/65">${q.nights} noite${q.nights !== 1 ? 's' : ''} × ${q.formatted.baseRatePerNight}</span><span class="font-semibold">${q.formatted.baseSubtotal}</span></div>`;
    if (q.extraGuests > 0) {
      rows += `<div class="flex justify-between text-sm"><span class="text-white/65">${q.extraGuests} hósp. extra</span><span class="font-semibold">${q.formatted.extraGuestFee}</span></div>`;
    }
    if (q.petCount > 0) {
      rows += `<div class="flex justify-between text-sm"><span class="text-white/65">${q.petCount} pet(s) (taxa)</span><span class="font-semibold">${q.formatted.petFee}</span></div>`;
    }
    document.getElementById('summary-breakdown').innerHTML = rows;

    // Total
    document.getElementById('summary-total').innerHTML = `
      <div class="flex justify-between items-baseline">
        <span class="text-sm font-semibold text-white/80">Pré-autorização</span>
        <span class="text-xl font-bold text-ambar font-serif">${q.formatted.totalAmount}</span>
      </div>
    `;

    document.getElementById('summary-loading').classList.add('hidden');
    document.getElementById('summary-content').classList.remove('hidden');
  } catch {
    document.getElementById('summary-loading').querySelector('p').textContent = 'Erro ao calcular cotação.';
  }
}

// ── Submit ────────────────────────────────────────────────────────────────────
async function submitBooking() {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Processando…';
  hideError('form-error');

  const checkIn        = document.getElementById('f-checkin').value;
  const checkOut       = document.getElementById('f-checkout').value;
  const guests         = parseInt(document.getElementById('f-guests').value);
  const petCount       = getPetCount();
  const petDescription = (document.getElementById('f-pet-description')?.value || '').trim() || undefined;
  const name           = document.getElementById('f-name').value.trim();
  const email          = document.getElementById('f-email').value.trim();
  const phone          = document.getElementById('f-phone').value.trim();
  const cpf            = document.getElementById('f-cpf').value.trim();
  const notes          = document.getElementById('f-notes').value.trim();

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
        checkIn, checkOut, guestCount: guests, petCount,
        guestName: name, guestEmail: email, guestPhone: phone,
        guestCpf: cpf || undefined, notes: notes || undefined,
        petDescription: petCount > 0 ? petDescription : undefined,
        cabinSlug,
      }),
    });
    const intentData = await intentRes.json();

    if (!intentRes.ok) {
      showError('form-error', intentData.error || 'Erro ao criar reserva');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    const { clientSecret, bookingId, quote } = intentData;
    currentBookingId    = bookingId;
    currentBookingEmail = email;

    // 2. Confirm card payment
    if (!stripe || !cardElement) {
      showError('form-error', 'Stripe não inicializado. Configure STRIPE_PUBLISHABLE_KEY.');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    const { error: stripeError } = await stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: cardElement, billing_details: { name, email } },
    });

    if (stripeError) {
      showError('form-error', stripeError.message || 'Erro no pagamento');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    // 3. Notify server
    btn.textContent = 'Confirmando…';
    const confirmRes = await fetch('/api/bookings/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentIntentId: intentData.paymentIntentId || clientSecret.split('_secret_')[0], bookingId }),
    });
    const confirmData = await confirmRes.json();

    if (!confirmRes.ok) {
      showError('form-error', confirmData.error || 'Erro ao confirmar reserva');
      btn.disabled = false; btn.textContent = 'Confirmar e pagar';
      return;
    }

    // 4. Save confirmation data for the next page
    sessionStorage.setItem('cds_booking_confirmation', JSON.stringify({
      checkIn, checkOut,
      guestCount: guests, hasPet: petCount > 0, petDescription,
      totalAmount: quote?.totalAmount || confirmData.booking?.totalAmount,
      cabinSlug,
      cabinLabel: CABIN_LABELS[cabinSlug] || 'Cabana',
    }));

    window.location.href = '/reserva-solicitada';
  } catch (err) {
    showError('form-error', 'Erro inesperado. Tente novamente.');
    btn.disabled = false; btn.textContent = 'Confirmar e pagar';
  }
}
