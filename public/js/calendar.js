/**
 * Recanto dos Ipês — Availability Calendar Widget
 * Vanilla JS, uses Tailwind CDN already loaded on the page.
 */
(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    blockedDates: new Set(),
    pricingPeriods: [],
    tiers: {},
    checkIn:    null,
    checkOut:   null,
    guestCount: 1,
    hasPet:     false,
    currentMonth: new Date(),
    selectingCheckOut: false,
    quoteTimer: null,
  };

  const TIER_COLORS = {
    LOW:      { bg: '#F7F7F2', text: '#1A1A1A', label: 'Baixa temporada' },
    MID:      { bg: '#DCFCE7', text: '#166534', label: 'Feriado' },
    HIGH_MID: { bg: '#FEF9C3', text: '#854D0E', label: 'Alta temporada' },
    PEAK:     { bg: '#FEE2E2', text: '#991B1B', label: 'Temporada máxima' },
  };

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    const container = document.getElementById('calendar-widget');
    if (!container) return;

    render(container);
    await Promise.all([loadAvailability(), loadPricing()]);
    renderCalendar();
  }

  async function loadAvailability() {
    try {
      const start = toISO(new Date());
      const end   = toISO(addDays(new Date(), 365));
      const res   = await fetch(`/api/bookings/availability?start=${start}&end=${end}`);
      if (!res.ok) return;
      const data  = await res.json();
      state.blockedDates = new Set(data.blockedDates || []);
    } catch (e) { console.warn('Calendar: failed to load availability', e); }
  }

  async function loadPricing() {
    try {
      const [calRes, tiersRes] = await Promise.all([
        fetch('/api/pricing/calendar'),
        fetch('/api/pricing/tiers'),
      ]);
      if (calRes.ok)   { const d = await calRes.json();   state.pricingPeriods = d.periods || []; }
      if (tiersRes.ok) { const d = await tiersRes.json(); state.tiers = d; }
    } catch (e) { console.warn('Calendar: failed to load pricing', e); }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function render(container) {
    container.innerHTML = `
      <div class="grid lg:grid-cols-2 gap-8 items-start">

        <!-- Calendar panel -->
        <div>
          <!-- Month nav -->
          <div class="flex items-center justify-between mb-4">
            <button id="cal-prev" class="p-2 rounded-full hover:bg-stone/10 transition-colors text-forest" aria-label="Mês anterior">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
              </svg>
            </button>
            <span id="cal-month-label" class="font-serif font-bold text-forest text-lg capitalize"></span>
            <button id="cal-next" class="p-2 rounded-full hover:bg-stone/10 transition-colors text-forest" aria-label="Próximo mês">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          </div>

          <!-- Day-of-week headers -->
          <div class="grid grid-cols-7 mb-1">
            ${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(d =>
              `<div class="text-center text-xs font-semibold text-stone pb-1">${d}</div>`
            ).join('')}
          </div>

          <!-- Calendar grid -->
          <div id="cal-grid" class="grid grid-cols-7 gap-0.5"></div>

          <!-- Pricing legend -->
          <div class="flex flex-wrap gap-2 mt-4" id="cal-legend">
            ${Object.entries(TIER_COLORS).map(([tier, c]) =>
              `<span class="text-xs px-2.5 py-1 rounded-full font-medium" style="background:${c.bg};color:${c.text}">${c.label}</span>`
            ).join('')}
            <span class="text-xs px-2.5 py-1 rounded-full font-medium bg-gray-200 text-gray-500">Indisponível</span>
          </div>
        </div>

        <!-- Summary / options panel -->
        <div class="space-y-5">

          <!-- Selected dates display -->
          <div class="bg-beige rounded-2xl p-5 border border-beige-dark">
            <div class="grid grid-cols-2 gap-3 mb-4">
              <div>
                <div class="text-xs font-semibold text-stone uppercase tracking-wider mb-1">Check-in</div>
                <div id="disp-checkin" class="text-forest font-semibold text-sm">—</div>
              </div>
              <div>
                <div class="text-xs font-semibold text-stone uppercase tracking-wider mb-1">Check-out</div>
                <div id="disp-checkout" class="text-forest font-semibold text-sm">—</div>
              </div>
            </div>
            <p id="cal-hint" class="text-xs text-stone italic">Selecione a data de check-in no calendário</p>
          </div>

          <!-- Guest count -->
          <div class="bg-white rounded-2xl p-5 border border-beige-dark">
            <label class="block text-sm font-semibold text-forest mb-3">Hóspedes</label>
            <div class="flex items-center gap-4">
              <button id="guests-minus" class="w-9 h-9 rounded-full border-2 border-gold flex items-center justify-center text-forest font-bold hover:bg-gold hover:text-white transition-colors text-lg leading-none">−</button>
              <span id="guests-count" class="text-xl font-bold text-forest w-8 text-center">1</span>
              <button id="guests-plus"  class="w-9 h-9 rounded-full border-2 border-gold flex items-center justify-center text-forest font-bold hover:bg-gold hover:text-white transition-colors text-lg leading-none">+</button>
              <span class="text-xs text-stone ml-1">máx. 20</span>
            </div>
            <p class="text-xs text-stone mt-2">Base: até 11 hóspedes · Adicional: R$50/pessoa/noite</p>
          </div>

          <!-- Pet toggle -->
          <div class="bg-white rounded-2xl p-5 border border-beige-dark flex items-center justify-between">
            <div>
              <div class="text-sm font-semibold text-forest">Pet</div>
              <div class="text-xs text-stone">Taxa única de R$50</div>
            </div>
            <button id="pet-toggle" role="switch" aria-checked="false"
              class="relative w-12 h-6 rounded-full bg-stone/30 transition-colors duration-200 focus:outline-none">
              <span class="absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"></span>
            </button>
          </div>

          <!-- Price breakdown -->
          <div id="price-panel" class="bg-forest rounded-2xl p-5 text-white hidden">
            <div id="price-loading" class="text-center text-white/60 text-sm py-2 hidden">Calculando…</div>
            <div id="price-breakdown"></div>
          </div>

          <!-- CTA -->
          <button id="cal-cta"
            class="w-full bg-gold hover:bg-gold-dark text-white font-bold py-4 rounded-2xl transition-all text-base shadow-lg hover:shadow-xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gold"
            disabled>
            Verificar disponibilidade
          </button>

          <p class="text-xs text-stone text-center">
            Ou reserve diretamente pelo
            <a href="https://www.airbnb.com/h/recantodosipesmg" target="_blank" rel="noopener"
               class="text-forest font-semibold underline underline-offset-2 hover:text-gold transition-colors">Airbnb</a>
          </p>
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('cal-prev').addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, -1);
      renderCalendar();
    });
    document.getElementById('cal-next').addEventListener('click', () => {
      state.currentMonth = addMonths(state.currentMonth, 1);
      renderCalendar();
    });

    document.getElementById('guests-minus').addEventListener('click', () => {
      if (state.guestCount > 1) { state.guestCount--; updateGuestDisplay(); scheduleQuote(); }
    });
    document.getElementById('guests-plus').addEventListener('click', () => {
      if (state.guestCount < 20) { state.guestCount++; updateGuestDisplay(); scheduleQuote(); }
    });

    const petBtn = document.getElementById('pet-toggle');
    petBtn.addEventListener('click', () => {
      state.hasPet = !state.hasPet;
      petBtn.setAttribute('aria-checked', String(state.hasPet));
      petBtn.style.backgroundColor = state.hasPet ? '#C5D86D' : '';
      petBtn.querySelector('span').style.transform = state.hasPet ? 'translateX(24px)' : '';
      scheduleQuote();
    });

    document.getElementById('cal-cta').addEventListener('click', () => {
      if (!state.checkIn || !state.checkOut) return;
      const params = new URLSearchParams({
        checkIn:  toISO(state.checkIn),
        checkOut: toISO(state.checkOut),
        guests:   String(state.guestCount),
        pet:      String(state.hasPet),
      });
      window.location.href = `/booking?${params.toString()}`;
    });
  }

  function renderCalendar() {
    const grid  = document.getElementById('cal-grid');
    const label = document.getElementById('cal-month-label');
    if (!grid || !label) return;

    const year  = state.currentMonth.getFullYear();
    const month = state.currentMonth.getMonth();

    label.textContent = new Date(year, month, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const firstDay = new Date(year, month, 1).getDay(); // 0 = Sunday
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    let html = '';

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      html += '<div></div>';
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const date    = new Date(year, month, d);
      const dateStr = toISO(date);
      const isPast  = date < today;
      const isBlocked = state.blockedDates.has(dateStr) || isPast;
      const tier    = !isBlocked ? getTierForDate(dateStr) : null;
      const isCheckIn  = state.checkIn  && toISO(state.checkIn)  === dateStr;
      const isCheckOut = state.checkOut && toISO(state.checkOut) === dateStr;
      const isInRange  = state.checkIn && state.checkOut &&
                         date > state.checkIn && date < state.checkOut;

      let bg    = '#F7F7F2';
      let color = '#1A1A1A';

      if (isBlocked) { bg = '#E5E7EB'; color = '#9CA3AF'; }
      else if (tier && TIER_COLORS[tier]) { bg = TIER_COLORS[tier].bg; color = TIER_COLORS[tier].text; }

      let classes = 'relative flex items-center justify-center rounded-lg text-sm font-medium transition-all select-none ';
      let style   = `background:${bg};color:${color};height:36px;`;
      let attrs   = '';

      if (isBlocked) {
        classes += 'cursor-not-allowed line-through opacity-60';
      } else {
        classes += 'cursor-pointer hover:ring-2 hover:ring-forest';
        attrs    = `data-date="${dateStr}"`;
      }

      if (isCheckIn || isCheckOut) {
        style += 'background:#261C15;color:#ffffff;font-weight:700;';
      } else if (isInRange) {
        style += 'background:#C5D86D33;';
      }

      html += `<div class="${classes}" style="${style}" ${attrs}>${d}</div>`;
    }

    grid.innerHTML = html;

    // Click handlers for date cells
    grid.querySelectorAll('[data-date]').forEach(cell => {
      cell.addEventListener('click', () => handleDateClick(cell.dataset.date));
    });
  }

  function handleDateClick(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');

    if (!state.selectingCheckOut) {
      // First click = check-in
      state.checkIn  = date;
      state.checkOut = null;
      state.selectingCheckOut = true;
      document.getElementById('cal-hint').textContent = 'Agora selecione o check-out';
      document.getElementById('disp-checkin').textContent  = formatDate(date);
      document.getElementById('disp-checkout').textContent = '—';
      document.getElementById('cal-cta').disabled = true;
      document.getElementById('cal-cta').textContent = 'Verificar disponibilidade';
      hidePrice();
    } else {
      // Second click = check-out
      if (date <= state.checkIn) {
        // Reset — clicked before check-in
        state.checkIn  = date;
        state.checkOut = null;
        document.getElementById('disp-checkin').textContent  = formatDate(date);
        document.getElementById('disp-checkout').textContent = '—';
        hidePrice();
        renderCalendar();
        return;
      }

      // Check no blocked dates in range
      const hasBlock = hasBlockedInRange(state.checkIn, date);
      if (hasBlock) {
        document.getElementById('cal-hint').textContent = 'Há datas indisponíveis no período. Escolha outras datas.';
        state.checkOut = null;
        state.selectingCheckOut = false;
        renderCalendar();
        return;
      }

      state.checkOut = date;
      state.selectingCheckOut = false;
      document.getElementById('cal-hint').textContent = '';
      document.getElementById('disp-checkout').textContent = formatDate(date);
      document.getElementById('cal-cta').disabled = false;
      document.getElementById('cal-cta').textContent = 'Reservar agora →';
      scheduleQuote();
    }

    renderCalendar();
  }

  function hasBlockedInRange(start, end) {
    const cur = new Date(start);
    cur.setDate(cur.getDate() + 1);
    while (cur < end) {
      if (state.blockedDates.has(toISO(cur))) return true;
      cur.setDate(cur.getDate() + 1);
    }
    return false;
  }

  function scheduleQuote() {
    if (!state.checkIn || !state.checkOut) return;
    clearTimeout(state.quoteTimer);
    state.quoteTimer = setTimeout(fetchQuote, 400);
  }

  async function fetchQuote() {
    if (!state.checkIn || !state.checkOut) return;

    const panel   = document.getElementById('price-panel');
    const loading = document.getElementById('price-loading');
    panel.classList.remove('hidden');
    loading.classList.remove('hidden');
    document.getElementById('price-breakdown').innerHTML = '';

    try {
      const params = new URLSearchParams({
        checkIn:  toISO(state.checkIn),
        checkOut: toISO(state.checkOut),
        guests:   String(state.guestCount),
        pet:      String(state.hasPet),
      });
      const res  = await fetch(`/api/bookings/quote?${params.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        document.getElementById('price-breakdown').innerHTML =
          `<p class="text-red-300 text-sm">${data.error || 'Erro ao calcular'}</p>`;
        loading.classList.add('hidden');
        return;
      }

      loading.classList.add('hidden');
      renderPriceBreakdown(data);
    } catch (e) {
      loading.classList.add('hidden');
      document.getElementById('price-breakdown').innerHTML =
        '<p class="text-red-300 text-sm">Erro ao calcular preço</p>';
    }
  }

  function renderPriceBreakdown(q) {
    const rows = [
      [`${q.nights} noite${q.nights > 1 ? 's' : ''} × ${q.formatted.baseRatePerNight}`,
       q.formatted.baseSubtotal],
    ];

    if (q.extraGuests > 0) {
      rows.push([
        `${q.extraGuests} hóspede${q.extraGuests > 1 ? 's' : ''} extra × R$50 × ${q.nights}n`,
        q.formatted.extraGuestFee,
      ]);
    }

    if (q.hasPet) {
      rows.push(['Pet (taxa única)', q.formatted.petFee]);
    }

    const html = `
      <div class="space-y-2 text-sm">
        <div class="text-xs text-white/60 uppercase tracking-wider mb-3 font-semibold">${q.seasonName}</div>
        ${rows.map(([label, val]) => `
          <div class="flex justify-between gap-2">
            <span class="text-white/75">${label}</span>
            <span class="font-semibold">${val}</span>
          </div>
        `).join('')}
        <div class="border-t border-white/20 mt-3 pt-3 flex justify-between">
          <span class="font-bold">Total</span>
          <span class="font-bold text-gold text-lg">${q.formatted.totalAmount}</span>
        </div>
      </div>
    `;

    document.getElementById('price-breakdown').innerHTML = html;
  }

  function hidePrice() {
    document.getElementById('price-panel')?.classList.add('hidden');
  }

  function updateGuestDisplay() {
    document.getElementById('guests-count').textContent = String(state.guestCount);
  }

  function getTierForDate(dateStr) {
    for (const period of state.pricingPeriods) {
      if (dateStr >= period.startDate && dateStr <= period.endDate) {
        return period.tier;
      }
    }
    return 'LOW';
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function addMonths(date, n) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + n);
    return d;
  }

  function formatDate(date) {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
