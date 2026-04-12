/**
 * Recanto dos Ipês — Availability & Pricing Calendar Widget
 * - 1-year rolling window (today → today+12 months)
 * - Price per night shown on every available day
 * - Tier color coding: Feriado / Alta temporada / Temporada máxima
 * - Auto-refreshes availability + pricing every 5 minutes
 * - Dynamic demand indicator when <30% of month is available
 */
(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────
  const REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const MAX_MONTHS_AHEAD = 12;
  const MAX_GUESTS       = 20;
  const BASE_LIMIT       = 11;

  const TIER = {
    LOW: {
      bg:     '#F7F7F2',
      border: '#E4E6C3',
      text:   '#4A4A3A',
      badge:  '#E4E6C3',
      badgeText: '#4A4A3A',
      label:  'Baixa temporada',
      dot:    '#9BAB52',
    },
    MID: {
      bg:     '#F0FDF4',
      border: '#86EFAC',
      text:   '#166534',
      badge:  '#DCFCE7',
      badgeText: '#166534',
      label:  'Feriado',
      dot:    '#22C55E',
    },
    HIGH_MID: {
      bg:     '#FFFBEB',
      border: '#FCD34D',
      text:   '#92400E',
      badge:  '#FEF3C7',
      badgeText: '#92400E',
      label:  'Alta temporada',
      dot:    '#F59E0B',
    },
    PEAK: {
      bg:     '#FFF1F2',
      border: '#FDA4AF',
      text:   '#9F1239',
      badge:  '#FFE4E6',
      badgeText: '#9F1239',
      label:  'Temporada máxima',
      dot:    '#F43F5E',
    },
  };

  const PRICE_DISPLAY = {
    LOW:      'R$720',
    MID:      'R$850',
    HIGH_MID: 'R$1.050',
    PEAK:     'R$1.300',
  };

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    blockedDates:   new Set(),
    pricingPeriods: [],      // [{startDate, endDate, tier, pricePerNight, name}]
    checkIn:        null,
    checkOut:       null,
    guestCount:     2,
    petCount:       0,
    currentMonth:   new Date(),
    selectingCheckOut: false,
    quoteTimer:     null,
    refreshTimer:   null,
    loading:        true,
  };

  // Clamp currentMonth to [today, today+12months]
  const TODAY = new Date();
  TODAY.setHours(0, 0, 0, 0);
  const MIN_MONTH = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  const MAX_MONTH = new Date(TODAY.getFullYear(), TODAY.getMonth() + MAX_MONTHS_AHEAD, 1);

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    const container = document.getElementById('calendar-widget');
    if (!container) return;

    state.currentMonth = new Date(MIN_MONTH);
    render(container);
    await refresh();

    // Auto-refresh every 5 minutes
    state.refreshTimer = setInterval(refresh, REFRESH_INTERVAL);
  }

  async function refresh() {
    await Promise.all([loadAvailability(), loadPricing()]);
    renderCalendar();
    renderLegend();
  }

  async function loadAvailability() {
    try {
      const start = toISO(TODAY);
      const end   = toISO(new Date(TODAY.getFullYear(), TODAY.getMonth() + 13, 0));
      const res   = await fetch(`/api/bookings/availability?start=${start}&end=${end}`);
      if (!res.ok) return;
      const data  = await res.json();
      state.blockedDates = new Set(data.blockedDates || []);
      state.loading = false;
    } catch (e) {
      console.warn('[Calendar] availability fetch failed', e);
      state.loading = false;
    }
  }

  async function loadPricing() {
    try {
      const res = await fetch('/api/pricing/calendar');
      if (!res.ok) return;
      const data = await res.json();
      state.pricingPeriods = data.periods || [];
    } catch (e) {
      console.warn('[Calendar] pricing fetch failed', e);
    }
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  function render(container) {
    container.innerHTML = `
      <div class="grid lg:grid-cols-[1fr_340px] gap-8 items-start">

        <!-- ── Calendar side ─────────────────────────────────────────── -->
        <div>

          <!-- Month navigation -->
          <div class="flex items-center justify-between mb-5">
            <button id="cal-prev" aria-label="Mês anterior"
              class="w-9 h-9 flex items-center justify-center rounded-full border border-beige-dark hover:bg-beige text-forest transition-colors">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
              </svg>
            </button>

            <div class="text-center">
              <div id="cal-month-label" class="font-serif font-bold text-forest text-lg capitalize"></div>
              <div id="cal-demand-badge" class="hidden text-xs font-semibold mt-0.5"></div>
            </div>

            <button id="cal-next" aria-label="Próximo mês"
              class="w-9 h-9 flex items-center justify-center rounded-full border border-beige-dark hover:bg-beige text-forest transition-colors">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
              </svg>
            </button>
          </div>

          <!-- Day-of-week headers -->
          <div class="grid grid-cols-7 mb-1.5">
            ${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(d =>
              `<div class="text-center text-xs font-semibold text-stone/70 pb-2 tracking-wide">${d}</div>`
            ).join('')}
          </div>

          <!-- Calendar grid -->
          <div id="cal-grid" class="grid grid-cols-7 gap-1"></div>

          <!-- Sync status -->
          <div class="flex items-center gap-1.5 mt-3">
            <span id="cal-sync-dot" class="w-1.5 h-1.5 rounded-full bg-green-400"></span>
            <span id="cal-sync-label" class="text-xs text-stone/60">Sincronizado com Airbnb e Booking.com</span>
          </div>

          <!-- Legend -->
          <div id="cal-legend" class="flex flex-wrap gap-2 mt-4"></div>
        </div>

        <!-- ── Options + summary side ────────────────────────────────── -->
        <div class="space-y-4">

          <!-- Selected dates -->
          <div class="bg-beige rounded-2xl p-5 border border-beige-dark">
            <div class="grid grid-cols-2 gap-4 mb-3">
              <div>
                <div class="text-xs font-semibold text-stone uppercase tracking-wider mb-1">Check-in</div>
                <div id="disp-checkin" class="text-forest font-bold text-sm">—</div>
              </div>
              <div>
                <div class="text-xs font-semibold text-stone uppercase tracking-wider mb-1">Check-out</div>
                <div id="disp-checkout" class="text-forest font-bold text-sm">—</div>
              </div>
            </div>
            <p id="cal-hint" class="text-xs text-stone/70 italic">Selecione a data de check-in no calendário</p>
          </div>

          <!-- Guests -->
          <div class="bg-white rounded-2xl p-5 border border-beige-dark">
            <div class="flex items-center justify-between mb-3">
              <label class="text-sm font-semibold text-forest">Hóspedes</label>
              <span id="guest-extra-note" class="text-xs text-amber-700 hidden">+R$50/pessoa/noite</span>
            </div>
            <div class="flex items-center gap-4">
              <button id="guests-minus"
                class="w-9 h-9 rounded-full border-2 border-gold flex items-center justify-center text-forest font-bold hover:bg-gold hover:text-white transition-colors text-lg leading-none">−</button>
              <span id="guests-count" class="text-xl font-bold text-forest w-8 text-center">2</span>
              <button id="guests-plus"
                class="w-9 h-9 rounded-full border-2 border-gold flex items-center justify-center text-forest font-bold hover:bg-gold hover:text-white transition-colors text-lg leading-none">+</button>
              <span class="text-xs text-stone ml-1">máx. 20 pessoas</span>
            </div>
            <p class="text-xs text-stone/60 mt-2">Preço base inclui até 11 hóspedes</p>
          </div>

          <!-- Pet -->
          <div class="bg-white rounded-2xl p-4 border border-beige-dark">
            <div class="flex items-center justify-between">
              <div class="text-sm font-semibold text-forest">🐾 Vou levar pet(s)</div>
              <button id="pet-toggle" role="switch" aria-checked="false"
                class="relative w-12 h-6 rounded-full bg-stone/25 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-gold focus:ring-offset-1">
                <span class="absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200"></span>
              </button>
            </div>
            <div id="pet-stepper-row" class="hidden mt-3 flex items-center gap-3">
              <button id="pet-minus"
                class="w-8 h-8 rounded-full border border-beige-dark flex items-center justify-center text-forest font-bold hover:bg-beige-dark transition-colors">−</button>
              <span id="pet-count-display" class="text-sm font-semibold text-forest w-4 text-center">1</span>
              <button id="pet-plus"
                class="w-8 h-8 rounded-full border border-beige-dark flex items-center justify-center text-forest font-bold hover:bg-beige-dark transition-colors">+</button>
              <span class="text-xs text-stone/60">máx. 4 pets</span>
            </div>
            <p id="pet-fee-hint" class="hidden text-xs text-stone/60 mt-2">1–2 pets: grátis · 3+ pets: +R$50/2 pets</p>
            <p id="pet-notice" class="hidden text-xs text-stone/60 mt-1">🐾 Pets devem ser supervisionados e dejetos recolhidos durante a estadia.</p>
          </div>

          <!-- Price breakdown -->
          <div id="price-panel" class="rounded-2xl overflow-hidden hidden">
            <div id="price-loading" class="bg-forest/90 p-5 text-center text-white/60 text-sm hidden">
              Calculando preço…
            </div>
            <div id="price-breakdown" class="bg-forest text-white p-5"></div>
          </div>

          <!-- CTA -->
          <button id="cal-cta" disabled
            class="w-full bg-gold hover:bg-gold-dark text-white font-bold py-4 rounded-2xl transition-all text-base shadow-lg hover:shadow-xl disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gold">
            Verificar disponibilidade
          </button>

          <p class="text-xs text-stone/60 text-center leading-relaxed">
            Reserve com segurança — pagamento por cartão de crédito<br>
            ou pelo <a href="https://www.airbnb.com/h/recantodosipesmg" target="_blank" rel="noopener"
              class="text-forest font-semibold underline underline-offset-2 hover:text-gold transition-colors">Airbnb</a>
            ou <a href="https://www.booking.com/hotel/br/sitio-recanto-dos-ipes-com-area-de-lazer-completa-e-piscina-aquecida" target="_blank" rel="noopener"
              class="text-forest font-semibold underline underline-offset-2 hover:text-gold transition-colors">Booking.com</a>
          </p>
        </div>
      </div>
    `;

    // ── Event listeners ──────────────────────────────────────────────────────
    document.getElementById('cal-prev').addEventListener('click', prevMonth);
    document.getElementById('cal-next').addEventListener('click', nextMonth);

    document.getElementById('guests-minus').addEventListener('click', () => {
      if (state.guestCount > 1) { state.guestCount--; updateGuestDisplay(); scheduleQuote(); }
    });
    document.getElementById('guests-plus').addEventListener('click', () => {
      if (state.guestCount < MAX_GUESTS) { state.guestCount++; updateGuestDisplay(); scheduleQuote(); }
    });

    const petBtn       = document.getElementById('pet-toggle');
    const petStepper   = document.getElementById('pet-stepper-row');
    const petFeeHint   = document.getElementById('pet-fee-hint');
    const petNotice    = document.getElementById('pet-notice');
    const petCountDisp = document.getElementById('pet-count-display');

    function updatePetUI() {
      const on = state.petCount > 0;
      petBtn.setAttribute('aria-checked', String(on));
      petBtn.style.backgroundColor = on ? '#C5D86D' : '';
      petBtn.querySelector('span').style.transform = on ? 'translateX(24px)' : '';
      petStepper.classList.toggle('hidden', !on);
      petFeeHint.classList.toggle('hidden', !on);
      petNotice.classList.toggle('hidden', !on);
      if (on) petCountDisp.textContent = String(state.petCount);
    }

    petBtn.addEventListener('click', () => {
      state.petCount = state.petCount > 0 ? 0 : 1;
      updatePetUI();
      scheduleQuote();
    });

    document.getElementById('pet-minus').addEventListener('click', () => {
      if (state.petCount > 1) { state.petCount--; updatePetUI(); scheduleQuote(); }
    });
    document.getElementById('pet-plus').addEventListener('click', () => {
      if (state.petCount < 4) { state.petCount++; updatePetUI(); scheduleQuote(); }
    });

    document.getElementById('cal-cta').addEventListener('click', () => {
      if (!state.checkIn || !state.checkOut) return;
      const params = new URLSearchParams({
        checkIn:  toISO(state.checkIn),
        checkOut: toISO(state.checkOut),
        guests:   String(state.guestCount),
        petCount: String(state.petCount),
      });
      window.location.href = `/booking?${params.toString()}`;
    });
  }

  // ── Month navigation ──────────────────────────────────────────────────────
  function prevMonth() {
    const prev = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() - 1, 1);
    if (prev < MIN_MONTH) return;
    state.currentMonth = prev;
    renderCalendar();
  }

  function nextMonth() {
    const next = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() + 1, 1);
    if (next > MAX_MONTH) return;
    state.currentMonth = next;
    renderCalendar();
  }

  // ── Calendar render ───────────────────────────────────────────────────────
  function renderCalendar() {
    const grid  = document.getElementById('cal-grid');
    const label = document.getElementById('cal-month-label');
    const prevBtn = document.getElementById('cal-prev');
    const nextBtn = document.getElementById('cal-next');
    if (!grid || !label) return;

    const year  = state.currentMonth.getFullYear();
    const month = state.currentMonth.getMonth();

    // Month label
    label.textContent = new Date(year, month, 1)
      .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    // Disable nav buttons at boundaries
    const thisMonth = new Date(year, month, 1);
    prevBtn.disabled = thisMonth <= MIN_MONTH;
    nextBtn.disabled = new Date(year, month + 1, 1) > MAX_MONTH;
    prevBtn.style.opacity = prevBtn.disabled ? '0.3' : '1';
    nextBtn.style.opacity = nextBtn.disabled ? '0.3' : '1';

    // Count available days for demand indicator
    const daysInMonth     = new Date(year, month + 1, 0).getDate();
    const firstDay        = new Date(year, month, 1).getDay();
    let availableCount    = 0;
    let totalFutureDays   = 0;

    // Build cells
    let html = '';
    for (let i = 0; i < firstDay; i++) html += '<div></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const date    = new Date(year, month, d);
      const dateStr = toISO(date);
      const isPast  = date < TODAY;
      const isBlocked = state.blockedDates.has(dateStr) || isPast;
      const tier    = getTierForDate(dateStr);
      const priceDisplay = tier ? PRICE_DISPLAY[tier] : PRICE_DISPLAY.LOW;

      if (!isPast) {
        totalFutureDays++;
        if (!isBlocked) availableCount++;
      }

      const isCheckIn  = state.checkIn  && toISO(state.checkIn)  === dateStr;
      const isCheckOut = state.checkOut && toISO(state.checkOut) === dateStr;
      const isInRange  = state.checkIn && state.checkOut &&
                         date > state.checkIn && date < state.checkOut;
      const isToday    = toISO(date) === toISO(TODAY);

      html += buildDayCell({ d, dateStr, isBlocked, isPast, tier, priceDisplay,
                              isCheckIn, isCheckOut, isInRange, isToday });
    }

    grid.innerHTML = html;

    // Demand badge
    showDemandBadge(availableCount, totalFutureDays, month === TODAY.getMonth() && year === TODAY.getFullYear());

    // Click handlers
    grid.querySelectorAll('[data-date]').forEach(cell => {
      cell.addEventListener('click', () => handleDateClick(cell.dataset.date));
    });
  }

  function buildDayCell({ d, dateStr, isBlocked, isPast, tier, priceDisplay,
                           isCheckIn, isCheckOut, isInRange, isToday }) {
    if (isBlocked) {
      const pastStyle = isPast
        ? 'background:#F3F4F6;color:#D1D5DB;'
        : 'background:#F3F4F6;color:#9CA3AF;';
      return `
        <div class="relative flex flex-col items-center justify-center rounded-lg text-xs select-none cursor-not-allowed"
             style="${pastStyle}height:52px;">
          <span class="${isPast ? 'line-through text-gray-400' : 'text-gray-400'} font-medium text-sm leading-tight">${d}</span>
          ${!isPast ? '<span class="text-gray-300 text-[9px] leading-tight mt-0.5">ocupado</span>' : ''}
        </div>`;
    }

    const t = TIER[tier] || TIER.LOW;

    let bgStyle   = `background:${t.bg};color:${t.text};border:1px solid ${t.border};`;
    let extraClass = '';

    if (isCheckIn || isCheckOut) {
      bgStyle   = 'background:#261C15;color:#ffffff;border:1px solid #261C15;';
      extraClass = 'ring-2 ring-forest ring-offset-1';
    } else if (isInRange) {
      bgStyle = `background:#261C1518;color:${t.text};border:1px solid #261C1530;`;
    }

    const todayDot = isToday
      ? '<span class="absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-gold"></span>'
      : '';

    return `
      <div class="relative flex flex-col items-center justify-center rounded-lg text-xs cursor-pointer
                  hover:ring-2 hover:ring-forest hover:ring-offset-1 transition-all select-none ${extraClass}"
           style="${bgStyle}height:52px;"
           data-date="${dateStr}"
           title="${t.label} · ${priceDisplay}/noite">
        <span class="font-semibold text-sm leading-tight">${d}</span>
        <span class="text-[9px] leading-tight mt-0.5 opacity-75">${priceDisplay}</span>
        ${todayDot}
      </div>`;
  }

  function showDemandBadge(available, total, isCurrentMonth) {
    const badge = document.getElementById('cal-demand-badge');
    if (!badge || total === 0) { badge && badge.classList.add('hidden'); return; }

    const pct = available / total;
    if (pct < 0.30) {
      badge.textContent = '🔥 Alta demanda — poucas datas disponíveis';
      badge.className   = 'text-xs font-semibold mt-0.5 text-rose-600';
      badge.classList.remove('hidden');
    } else if (pct < 0.55) {
      badge.textContent = '⚡ Demanda moderada';
      badge.className   = 'text-xs font-semibold mt-0.5 text-amber-600';
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  function renderLegend() {
    const el = document.getElementById('cal-legend');
    if (!el) return;

    // Only show tiers that are actually in the next 12 months
    const activeTiers = new Set(state.pricingPeriods.map(p => p.tier));
    // Always show at least LOW
    activeTiers.add('LOW');

    const order = ['LOW', 'MID', 'HIGH_MID', 'PEAK'];
    el.innerHTML = order
      .filter(t => activeTiers.has(t))
      .map(t => {
        const c = TIER[t];
        return `<span class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium"
                      style="background:${c.badge};color:${c.badgeText}">
                  <span class="w-2 h-2 rounded-full inline-block" style="background:${c.dot}"></span>
                  ${c.label} · ${PRICE_DISPLAY[t]}/noite
                </span>`;
      }).join('') +
      `<span class="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium bg-gray-100 text-gray-500">
         <span class="w-2 h-2 rounded-full inline-block bg-gray-300"></span>
         Indisponível
       </span>`;
  }

  // ── Date click logic ──────────────────────────────────────────────────────
  function handleDateClick(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');

    if (!state.selectingCheckOut) {
      state.checkIn           = date;
      state.checkOut          = null;
      state.selectingCheckOut = true;
      setHint('Agora selecione a data de check-out');
      document.getElementById('disp-checkin').textContent  = formatDate(date);
      document.getElementById('disp-checkout').textContent = '—';
      document.getElementById('cal-cta').disabled = true;
      document.getElementById('cal-cta').textContent = 'Selecione o check-out';
      hidePrice();
    } else {
      if (date <= state.checkIn) {
        // Restart from new check-in
        state.checkIn  = date;
        state.checkOut = null;
        document.getElementById('disp-checkin').textContent  = formatDate(date);
        document.getElementById('disp-checkout').textContent = '—';
        setHint('Agora selecione a data de check-out');
        hidePrice();
        renderCalendar();
        return;
      }

      if (hasBlockedInRange(state.checkIn, date)) {
        setHint('Há datas indisponíveis neste período. Escolha outras datas.');
        state.checkOut          = null;
        state.selectingCheckOut = false;
        renderCalendar();
        return;
      }

      state.checkOut          = date;
      state.selectingCheckOut = false;
      setHint('');
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

  function setHint(text) {
    const el = document.getElementById('cal-hint');
    if (el) el.textContent = text;
  }

  // ── Quote ─────────────────────────────────────────────────────────────────
  function scheduleQuote() {
    if (!state.checkIn || !state.checkOut) return;
    clearTimeout(state.quoteTimer);
    state.quoteTimer = setTimeout(fetchQuote, 350);
  }

  async function fetchQuote() {
    if (!state.checkIn || !state.checkOut) return;

    const panel   = document.getElementById('price-panel');
    const loading = document.getElementById('price-loading');
    const breakdown = document.getElementById('price-breakdown');
    panel.classList.remove('hidden');
    loading.classList.remove('hidden');
    breakdown.innerHTML = '';

    try {
      const params = new URLSearchParams({
        checkIn:  toISO(state.checkIn),
        checkOut: toISO(state.checkOut),
        guests:   String(state.guestCount),
        petCount: String(state.petCount),
      });
      const res  = await fetch(`/api/bookings/quote?${params.toString()}`);
      const data = await res.json();
      loading.classList.add('hidden');

      if (!res.ok) {
        breakdown.innerHTML = `<p class="text-red-300 text-sm">${data.error || 'Erro ao calcular'}</p>`;
        return;
      }
      renderPriceBreakdown(data);
    } catch (e) {
      loading.classList.add('hidden');
      breakdown.innerHTML = '<p class="text-red-300 text-sm">Erro ao calcular preço</p>';
    }
  }

  function renderPriceBreakdown(q) {
    const tierInfo = TIER[q.tier] || TIER.LOW;
    const rows = [
      [`${q.nights} noite${q.nights > 1 ? 's' : ''} × ${q.formatted.baseRatePerNight}`, q.formatted.baseSubtotal],
    ];
    if (q.extraGuests > 0) {
      rows.push([`${q.extraGuests} hóspede${q.extraGuests > 1 ? 's' : ''} extra × R$50 × ${q.nights}n`, q.formatted.extraGuestFee]);
    }
    if (q.petCount > 2) {
      rows.push([`🐾 ${q.petCount} pets (taxa)`, q.formatted.petFee]);
    }

    document.getElementById('price-breakdown').innerHTML = `
      <div class="space-y-2 text-sm">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-xs font-bold uppercase tracking-wider text-white/50">Temporada</span>
          <span class="text-xs font-semibold px-2 py-0.5 rounded-full"
                style="background:${tierInfo.dot}22;color:${tierInfo.dot}">
            ${tierInfo.label}
          </span>
        </div>
        ${rows.map(([label, val]) => `
          <div class="flex justify-between gap-2">
            <span class="text-white/70">${label}</span>
            <span class="font-semibold tabular-nums">${val}</span>
          </div>`).join('')}
        <div class="border-t border-white/15 mt-3 pt-3 flex justify-between items-end">
          <div>
            <div class="font-bold text-base">Total</div>
            <div class="text-white/50 text-xs">Pagamento seguro por cartão</div>
          </div>
          <span class="font-bold text-2xl" style="color:#C5D86D">${q.formatted.totalAmount}</span>
        </div>
      </div>`;
  }

  function hidePrice() {
    document.getElementById('price-panel')?.classList.add('hidden');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function updateGuestDisplay() {
    document.getElementById('guests-count').textContent = String(state.guestCount);
    const note = document.getElementById('guest-extra-note');
    if (note) {
      note.classList.toggle('hidden', state.guestCount <= BASE_LIMIT);
    }
  }

  function getTierForDate(dateStr) {
    for (const p of state.pricingPeriods) {
      if (dateStr >= p.startDate && dateStr <= p.endDate) return p.tier;
    }
    return 'LOW';
  }

  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatDate(date) {
    return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
