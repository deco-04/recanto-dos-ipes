'use strict';

const fmtDate   = d => new Date(d).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
const fmtBRL    = v => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(v));
const countdown = d => {
  const days = Math.ceil((new Date(d) - new Date()) / (1000*60*60*24));
  if (days === 0) return 'Hoje!';
  if (days === 1) return 'Amanhã';
  return `${days} dias`;
};

// Warm, personalized countdown message shown on upcoming booking cards
const warmMessage = d => {
  const days = Math.ceil((new Date(d) - new Date()) / (1000*60*60*24));
  if (days <= 0) return null;
  if (days === 1) return '🌸 Amanhã é o grande dia! Já estamos preparando tudo com carinho para a sua chegada.';
  if (days === 2) return '🎒 Só mais 2 dias! Hora de separar as malas e se preparar para relaxar.';
  if (days <= 6) return `🍃 Falta pouquinho! Em ${days} dias você estará na Serra do Cipó, curtindo cada momento.`;
  if (days <= 13) return `✨ Estamos ansiosos para receber vocês em ${days} dias! A piscina aquecida e a sauna já aguardam.`;
  if (days <= 30) return `🌿 Que delícia de esperar! Em ${days} dias vocês chegam ao Recanto dos Ipês.`;
  return `🌄 Sua estadia está confirmada! Ainda ${days} dias para a experiência que vocês vão adorar.`;
};

// ── State ────────────────────────────────────────────────────────────────────
let currentUser = null;

// ── Bootstrap ────────────────────────────────────────────────────────────────
(async function init() {
  const meRes = await fetch('/api/auth/me');
  if (!meRes.ok) {
    window.location.replace('/login?returnTo=/dashboard');
    return;
  }
  const { user } = await meRes.json();
  currentUser = user;

  document.getElementById('nav-user').textContent = user.email;
  document.getElementById('nav-user').classList.remove('hidden');
  document.getElementById('user-greeting').textContent =
    `Olá${user.name ? ', ' + user.name : ''}! Bem-vindo(a) de volta.`;

  populateProfileView(user);

  // Load all dashboard data in parallel
  const [currentRes, upcomingRes, pastRes, pendingRes] = await Promise.all([
    fetch('/api/dashboard/current'),
    fetch('/api/dashboard/upcoming'),
    fetch('/api/dashboard/past'),
    fetch('/api/dashboard/pending'),
  ]);

  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('main-content').classList.remove('hidden');

  // Init push: silently sync if already granted, show banner if permission not yet decided
  if (typeof silentPushSync === 'function') silentPushSync().catch(() => {});
  if (typeof _initPushBanner === 'function') _initPushBanner();

  // Show set-password banner for OTP users who haven't created a password
  // (check sessionStorage to avoid showing again if dismissed)
  if (!sessionStorage.getItem('pw-banner-dismissed')) {
    fetch('/api/auth/has-password')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.hasPassword === false) {
          document.getElementById('set-password-banner').classList.remove('hidden');
        }
      })
      .catch(() => {/* silently ignore */});
  }

  let hasAny = false;

  if (currentRes.ok) {
    const { booking } = await currentRes.json();
    if (booking) { renderCurrentStay(booking); hasAny = true; }
  } else if (!currentRes.ok && currentRes.status !== 401) {
    showSectionError('current-section', 'current-error', 'Não foi possível carregar a estadia atual.', () => window.location.reload());
  }

  if (pendingRes.ok) {
    const { bookings: pending } = await pendingRes.json();
    if (pending?.length > 0) { renderPending(pending); hasAny = true; }
  }

  if (upcomingRes.ok) {
    const { bookings: upcoming } = await upcomingRes.json();
    if (upcoming?.length > 0) { renderUpcoming(upcoming); hasAny = true; }
  } else if (!upcomingRes.ok && upcomingRes.status !== 401) {
    showSectionError('upcoming-section', 'upcoming-error', 'Não foi possível carregar as próximas reservas.', () => window.location.reload());
    hasAny = true;
  }

  if (pastRes.ok) {
    const { bookings: past } = await pastRes.json();
    if (past?.length > 0) { renderPast(past); hasAny = true; }
  } else if (!pastRes.ok && pastRes.status !== 401) {
    showSectionError('past-section', 'past-error', 'Não foi possível carregar o histórico.', () => window.location.reload());
    hasAny = true;
  }

  if (!hasAny) {
    document.getElementById('empty-state').classList.remove('hidden');
  }
})();

function showSectionError(sectionId, errorId, msg, retryFn) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  section.classList.remove('hidden');
  let el = document.getElementById(errorId);
  if (!el) {
    el = document.createElement('div');
    el.id = errorId;
    section.appendChild(el);
  }
  el.className = 'bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3';
  el.innerHTML = `<span>${msg}</span><button onclick="(${retryFn})()" class="text-xs font-medium underline">Tentar novamente</button>`;
}

// ── Profile ───────────────────────────────────────────────────────────────────
function populateProfileView(user) {
  const fields = [
    { label: 'Nome', value: user.name || '—' },
    { label: 'E-mail', value: user.email },
    { label: 'Telefone', value: user.phone || '—' },
    { label: 'CPF', value: user.cpf ? formatCPF(user.cpf) : '—' },
  ];
  document.getElementById('profile-fields').innerHTML = fields.map(f => `
    <div class="bg-beige rounded-xl p-3">
      <p class="text-xs text-stone mb-0.5">${f.label}</p>
      <p class="font-medium text-forest text-sm">${f.value}</p>
    </div>
  `).join('');
}

function formatCPF(digits) {
  const d = digits.replace(/\D/g, '');
  if (d.length !== 11) return digits;
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
}

function toggleProfile() {
  const section = document.getElementById('profile-section');
  section.classList.toggle('hidden');
  if (!section.classList.contains('hidden')) cancelProfile();
}

function editProfile() {
  document.getElementById('profile-view').classList.add('hidden');
  document.getElementById('profile-form').classList.remove('hidden');
  document.getElementById('profile-name').value  = currentUser.name  || '';
  document.getElementById('profile-phone').value = currentUser.phone || '';
  document.getElementById('profile-cpf').value   = currentUser.cpf ? formatCPF(currentUser.cpf) : '';
  document.getElementById('profile-error').classList.add('hidden');

  const cpfInput = document.getElementById('profile-cpf');
  cpfInput.removeEventListener('input', cpfMaskHandler);
  cpfInput.addEventListener('input', cpfMaskHandler);
}

function cancelProfile() {
  document.getElementById('profile-form').classList.add('hidden');
  document.getElementById('profile-view').classList.remove('hidden');
}

function cpfMaskHandler(e) {
  let v = e.target.value.replace(/\D/g, '').slice(0, 11);
  if (v.length > 9) v = v.slice(0,3)+'.'+v.slice(3,6)+'.'+v.slice(6,9)+'-'+v.slice(9);
  else if (v.length > 6) v = v.slice(0,3)+'.'+v.slice(3,6)+'.'+v.slice(6);
  else if (v.length > 3) v = v.slice(0,3)+'.'+v.slice(3);
  e.target.value = v;
}

async function saveProfile(e) {
  e.preventDefault();
  const btn = document.getElementById('profile-save-btn');
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  document.getElementById('profile-error').classList.add('hidden');

  const body = {
    name:  document.getElementById('profile-name').value.trim()  || undefined,
    phone: document.getElementById('profile-phone').value.trim() || undefined,
    cpf:   document.getElementById('profile-cpf').value.trim()   || undefined,
  };

  try {
    const res  = await fetch('/api/auth/profile', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();

    if (!res.ok) {
      document.getElementById('profile-error').textContent = data.error || 'Erro ao salvar';
      document.getElementById('profile-error').classList.remove('hidden');
      return;
    }

    currentUser = data.user;
    populateProfileView(data.user);
    cancelProfile();
    document.getElementById('user-greeting').textContent =
      `Olá${data.user.name ? ', ' + data.user.name : ''}! Bem-vindo(a) de volta.`;
  } catch {
    document.getElementById('profile-error').textContent = 'Erro de conexão. Tente novamente.';
    document.getElementById('profile-error').classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar';
  }
}

// ── Pending bookings ──────────────────────────────────────────────────────────
function renderPending(bookings) {
  const section = document.getElementById('pending-section');
  if (!section) return;
  section.classList.remove('hidden');
  const list = document.getElementById('pending-list');
  if (!list) return;
  list.innerHTML = bookings.map(b => `
    <div class="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3">
      <div class="flex-1">
        <p class="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Aguardando confirmação de pagamento</p>
        <p class="text-sm font-semibold text-stone-800">${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}</p>
        <p class="text-xs text-stone-600 mt-0.5">${b.nights} noite${b.nights > 1 ? 's' : ''} · ${b.guestCount} hóspede${b.guestCount > 1 ? 's' : ''}</p>
        ${b.invoiceNumber ? `<p class="text-xs text-stone-400 font-mono mt-0.5">Nº ${b.invoiceNumber}</p>` : ''}
      </div>
      <span class="text-amber-500 text-xl">⏳</span>
    </div>
  `).join('');
}

// ── Invoice download ──────────────────────────────────────────────────────────
async function downloadInvoice(bookingId) {
  try {
    const res = await fetch(`/api/dashboard/invoice/${bookingId}`);
    if (!res.ok) {
      if (res.status === 429) alert('Muitas tentativas. Aguarde antes de tentar novamente.');
      return;
    }
    const { invoice } = await res.json();

    const fmt = d => new Date(d).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', timeZone:'UTC' });
    const lines = [
      '==============================',
      'SÍTIO RECANTO DOS IPÊS',
      'Jaboticatubas · MG',
      '==============================',
      '',
      `Reserva nº: ${invoice.invoiceNumber}`,
      `Hóspede:    ${invoice.guestName}`,
      `E-mail:     ${invoice.guestEmail}`,
      invoice.guestPhone ? `Telefone:   ${invoice.guestPhone}` : null,
      invoice.guestCpf   ? `CPF:        ${invoice.guestCpf}` : null,
      '',
      `Check-in:   ${fmt(invoice.checkIn)}`,
      `Check-out:  ${fmt(invoice.checkOut)}`,
      `Noites:     ${invoice.nights}`,
      `Hóspedes:   ${invoice.guestCount}`,
      invoice.extraGuests > 0 ? `Extras:     ${invoice.extraGuests}` : null,
      invoice.hasPet ? 'Pet:        Sim' : null,
      '',
      `Diária base:    ${invoice.baseRatePerNight}`,
      invoice.extraGuests > 0 ? `Taxa extra:     ${invoice.extraGuestFee}` : null,
      invoice.hasPet ? `Taxa pet:       ${invoice.petFee}` : null,
      `Total:          ${invoice.totalAmount}`,
      '',
      invoice.notes ? `Observações: ${invoice.notes}` : null,
      '',
      '==============================',
    ].filter(l => l !== null).join('\n');

    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `recibo-${invoice.invoiceNumber || bookingId}.txt`;
    a.click(); URL.revokeObjectURL(url);
  } catch {
    alert('Erro ao baixar recibo. Tente novamente.');
  }
}

// ── Current stay ──────────────────────────────────────────────────────────────
function renderCurrentStay(b) {
  const isCoGuest = b.role === 'CO_GUEST';
  document.getElementById('current-section').classList.remove('hidden');
  document.getElementById('current-card').innerHTML = `
    <div class="flex items-start justify-between mb-4 flex-wrap gap-2">
      <div>
        <p class="text-xs text-white/60 uppercase tracking-widest mb-1">Estadia em andamento</p>
        <p class="font-serif text-xl font-bold">Sítio Recanto dos Ipês</p>
        <p class="text-white/70 text-sm mt-1">Jaboticatubas, MG</p>
      </div>
      <div class="flex flex-col items-end gap-1.5">
        <span class="bg-gold text-forest text-xs font-bold px-3 py-1 rounded-full">Hospedado agora</span>
        ${isCoGuest ? '<span class="bg-white/15 text-white text-xs px-2.5 py-1 rounded-full">Acompanhante</span>' : ''}
      </div>
    </div>
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div><p class="text-white/60 text-xs">Check-in</p><p class="font-semibold">${fmtDate(b.checkIn)}</p></div>
      <div><p class="text-white/60 text-xs">Check-out</p><p class="font-semibold">${fmtDate(b.checkOut)}</p></div>
      <div><p class="text-white/60 text-xs">Hóspedes</p><p class="font-semibold">${b.guestCount}</p></div>
      ${!isCoGuest ? `<div><p class="text-white/60 text-xs">Total pago</p><p class="font-semibold">${fmtBRL(b.totalAmount)}</p></div>` : ''}
    </div>
    ${b.hasPet ? '<div class="flex items-center gap-2 mt-3 text-sm text-white/70"><span class="text-base">🐾</span><span>Pet incluído nesta reserva</span></div>' : ''}
    <div class="flex items-center justify-between mt-4">
      <p class="text-white/40 text-xs font-mono">Reserva nº ${b.invoiceNumber}</p>
      ${!isCoGuest ? `<button onclick="downloadInvoice('${b.id}')" class="text-xs text-white/60 hover:text-white transition-colors">⬇ Recibo</button>` : ''}
    </div>
    ${renderGuestSection(b.id, [], true, !isCoGuest)}
  `;
  loadGuests(b.id);
}

// ── Upcoming stays ────────────────────────────────────────────────────────────
function renderUpcoming(bookings) {
  document.getElementById('upcoming-section').classList.remove('hidden');
  document.getElementById('upcoming-card').innerHTML = bookings.map((b, i) => {
    const isCoGuest = b.role === 'CO_GUEST';
    const canCancel = !isCoGuest && b.source === 'DIRECT';
    const msg = warmMessage(b.checkIn);
    return `
    <div class="${i > 0 ? 'mt-6 pt-6 border-t border-beige-dark' : ''}">
      ${msg ? `<div class="bg-gold/10 border border-gold/30 rounded-xl px-4 py-3 mb-4 text-sm text-forest/80 leading-snug">${msg}</div>` : ''}
      <div class="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <p class="font-serif text-lg font-bold text-forest">Sítio Recanto dos Ipês</p>
          <p class="text-stone text-sm">Jaboticatubas, MG</p>
        </div>
        <div class="flex items-center gap-2 flex-wrap justify-end">
          ${isCoGuest ? '<span class="bg-beige border border-beige-dark text-stone text-xs px-2.5 py-1 rounded-full">Acompanhante</span>' : ''}
          <span class="bg-gold/20 text-gold-dark text-sm font-bold px-3 py-1 rounded-full">${countdown(b.checkIn)}</span>
        </div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Check-in</p><p class="font-semibold text-forest">${fmtDate(b.checkIn)}</p></div>
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Check-out</p><p class="font-semibold text-forest">${fmtDate(b.checkOut)}</p></div>
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Noites</p><p class="font-semibold text-forest">${b.nights}</p></div>
        <div class="bg-beige rounded-xl p-3">
          <p class="text-xs text-stone mb-1">Hóspedes</p>
          <p class="font-semibold text-forest">${b.guestCount}</p>
        </div>
      </div>
      ${b.hasPet ? `
      <div class="flex items-center gap-2 mt-3 text-sm text-forest/70">
        <span class="text-base">🐾</span>
        <span>Pet incluído nesta reserva</span>
      </div>` : ''}
      <div class="flex items-center justify-between mt-4 pt-4 border-t border-beige-dark flex-wrap gap-2">
        <div>
          ${!isCoGuest ? `<p class="text-xs text-stone font-mono">Reserva nº ${b.invoiceNumber}</p>
          <button onclick="downloadInvoice('${b.id}')" class="text-xs text-stone hover:text-forest transition-colors mt-0.5">⬇ Baixar recibo</button>` : `<p class="text-xs text-stone font-mono">Reserva nº ${b.invoiceNumber}</p>`}
        </div>
        <div class="flex items-center gap-3">
          ${canCancel ? `<button onclick="openCancelModal('${b.id}')" class="text-xs text-red-500 hover:text-red-700 transition-colors border border-red-200 hover:border-red-400 px-3 py-1.5 rounded-lg">Cancelar</button>` : ''}
          ${!isCoGuest ? `<p class="font-bold text-forest text-lg">${fmtBRL(b.totalAmount)}</p>` : ''}
        </div>
      </div>
      ${renderGuestSection(b.id, [], false, !isCoGuest)}
    </div>`;
  }).join('');
  bookings.forEach(b => loadGuests(b.id));
}

// ── Past stays ────────────────────────────────────────────────────────────────
function renderPast(bookings) {
  document.getElementById('past-section').classList.remove('hidden');
  document.getElementById('past-list').innerHTML = bookings.map(b => {
    const isCoGuest = b.role === 'CO_GUEST';
    return `
    <div class="bg-white rounded-2xl p-5 border border-beige-dark flex items-center justify-between gap-4 flex-wrap">
      <div>
        <p class="font-semibold text-forest text-sm">${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}</p>
        <p class="text-stone text-xs mt-0.5">${b.nights} noite${b.nights > 1 ? 's' : ''} · ${b.guestCount} hóspede${b.guestCount > 1 ? 's' : ''}</p>
        <p class="text-xs text-stone/60 font-mono mt-0.5">${b.invoiceNumber}</p>
        ${isCoGuest ? '<span class="inline-block mt-1 text-xs bg-beige border border-beige-dark text-stone px-2 py-0.5 rounded-full">Acompanhante</span>' : ''}
      </div>
      <div class="text-right">
        ${!isCoGuest ? `<p class="font-bold text-forest">${fmtBRL(b.totalAmount)}</p>` : ''}
        <span class="text-xs px-2 py-0.5 rounded-full ${b.status === 'CONFIRMED' ? 'bg-green-100 text-green-700' : 'bg-stone/10 text-stone'}">
          ${b.status === 'CONFIRMED' ? 'Concluída' : b.status}
        </span>
        ${!isCoGuest ? `<button onclick="downloadInvoice('${b.id}')" class="block text-xs text-stone hover:text-forest transition-colors mt-1 ml-auto">⬇ Recibo</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ── Co-guest section (rendered inside booking cards) ──────────────────────────
// isOwner: true = full controls (invite/remove/resend), false = read-only list
function renderGuestSection(bookingId, guests, dark, isOwner = true) {
  const textMuted = dark ? 'text-white/60' : 'text-stone';
  const textMain  = dark ? 'text-white'    : 'text-forest';
  const borderCol = dark ? 'border-white/20' : 'border-beige-dark';
  const badgePending   = dark ? 'bg-white/10 text-white/70' : 'bg-amber-50 text-amber-700';
  const badgeConfirmed = dark ? 'bg-gold/30 text-white'     : 'bg-green-50 text-green-700';

  const guestItems = guests.map(g => `
    <div class="flex items-center justify-between gap-2 py-1.5">
      <div class="flex items-center gap-2">
        <div class="w-7 h-7 rounded-full bg-gold/30 flex items-center justify-center text-xs font-bold text-forest flex-shrink-0">
          ${g.name.charAt(0).toUpperCase()}
        </div>
        <span class="text-sm ${textMain}">${g.name}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs px-2 py-0.5 rounded-full ${g.status === 'CONFIRMADO' ? badgeConfirmed : badgePending}">
          ${g.status === 'CONFIRMADO' ? 'Confirmado' : 'Aguardando'}
        </span>
        ${isOwner && g.status === 'PENDENTE' ? `
          <button onclick="removeGuest('${bookingId}','${g.id}')" class="text-xs ${textMuted} hover:opacity-100 opacity-60">✕</button>
        ` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div class="mt-4 pt-4 border-t ${borderCol}">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-semibold uppercase tracking-wider ${textMuted}">Acompanhantes</p>
        ${isOwner ? `<button onclick="openInviteModal('${bookingId}')"
          class="text-xs font-medium ${textMain} border ${borderCol} px-2.5 py-1 rounded-lg hover:opacity-80 transition-opacity">
          + Convidar
        </button>` : ''}
      </div>
      <div id="guests-${bookingId}">
        ${guests.length === 0 ? `<p class="text-xs ${textMuted} italic">${isOwner ? 'Nenhum acompanhante adicionado.' : 'Nenhum acompanhante confirmado ainda.'}</p>` : guestItems}
      </div>
    </div>
  `;
}

async function loadGuests(bookingId) {
  const container = document.getElementById(`guests-${bookingId}`);
  if (!container) return;

  const dark = container.closest('.bg-forest') !== null;
  const textMuted = dark ? 'text-white/60' : 'text-stone';
  const textMain  = dark ? 'text-white'    : 'text-forest';
  const badgePending   = dark ? 'bg-white/10 text-white/70' : 'bg-amber-50 text-amber-700';
  const badgeConfirmed = dark ? 'bg-gold/30 text-white'     : 'bg-green-50 text-green-700';

  try {
    const res = await fetch(`/api/dashboard/bookings/${bookingId}/guests`);
    if (!res.ok) {
      container.innerHTML = `<p class="text-xs text-red-500">Erro ao carregar acompanhantes. <button onclick="loadGuests('${bookingId}')" class="underline">Tentar novamente</button></p>`;
      return;
    }
    const { guests, isOwner } = await res.json();

    if (guests.length === 0) {
      container.innerHTML = `<p class="text-xs ${textMuted} italic">${isOwner ? 'Nenhum acompanhante adicionado.' : 'Nenhum acompanhante confirmado ainda.'}</p>`;
      return;
    }
    container.innerHTML = guests.map(g => `
      <div class="flex items-center justify-between gap-2 py-1.5">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-full bg-gold/30 flex items-center justify-center text-xs font-bold text-forest flex-shrink-0">
            ${g.name.charAt(0).toUpperCase()}
          </div>
          <span class="text-sm ${textMain}">${g.name}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs px-2 py-0.5 rounded-full ${g.status === 'CONFIRMADO' ? badgeConfirmed : badgePending}">
            ${g.status === 'CONFIRMADO' ? 'Confirmado' : 'Aguardando'}
          </span>
          ${isOwner && g.status === 'PENDENTE' ? `
            <button onclick="resendInvite('${bookingId}','${g.id}', this)"
              class="text-xs ${textMuted} hover:opacity-100 opacity-60" title="Reenviar convite">↺</button>
            <button onclick="removeGuest('${bookingId}','${g.id}')"
              class="text-xs ${textMuted} hover:opacity-100 opacity-60" title="Remover">✕</button>
          ` : ''}
        </div>
      </div>
    `).join('');
  } catch {
    container.innerHTML = `<p class="text-xs text-red-500">Erro ao carregar acompanhantes.</p>`;
  }
}

// ── Cancel booking modal ───────────────────────────────────────────────────────
let _cancelBookingId = null;

async function openCancelModal(bookingId) {
  _cancelBookingId = bookingId;
  const modal = document.getElementById('cancel-modal');
  const body  = document.getElementById('cancel-modal-body');
  body.innerHTML = `<div class="flex items-center justify-center py-6">
    <svg class="spin w-7 h-7 text-gold" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
    </svg></div>`;
  modal.classList.remove('hidden');

  try {
    const res = await fetch(`/api/bookings/${bookingId}/cancel-preview`);
    const data = await res.json();

    if (!res.ok) {
      body.innerHTML = `<p class="text-sm text-red-600 py-2">${data.error || 'Erro ao calcular reembolso.'}</p>
        <button onclick="closeCancelModal()" class="mt-3 w-full border border-beige-dark rounded-xl py-2.5 text-sm text-stone hover:text-forest">Fechar</button>`;
      return;
    }

    const { daysUntil, refundPercent, refundAmount, totalAmount } = data;
    const refundMsg = refundPercent === 100
      ? `Você receberá um reembolso integral de <strong>${fmtBRL(refundAmount)}</strong>.`
      : refundPercent === 50
        ? `Você receberá reembolso de 50% — <strong>${fmtBRL(refundAmount)}</strong> de ${fmtBRL(totalAmount)} pagos.`
        : `Esta reserva <strong>não tem direito a reembolso</strong> (cancelamento com menos de 48h de antecedência).`;

    body.innerHTML = `
      <div class="bg-beige rounded-xl p-4 mb-4">
        <p class="text-xs text-stone mb-1">Antecedência</p>
        <p class="font-semibold text-forest">${daysUntil >= 0 ? daysUntil + ' dias antes do check-in' : 'Check-in já passou'}</p>
      </div>
      <p class="text-sm text-stone leading-relaxed mb-4">${refundMsg}</p>
      <p class="text-xs text-stone/70 mb-5">O reembolso será processado na forma de pagamento original em até 5–10 dias úteis.</p>
      <p class="text-xs font-semibold text-red-600 mb-3">Esta ação não pode ser desfeita.</p>
      <div class="flex gap-3">
        <button onclick="confirmCancel()" id="cancel-confirm-btn"
          class="flex-1 bg-red-600 text-white py-3 rounded-xl text-sm font-semibold hover:bg-red-700 transition-colors">
          Confirmar cancelamento
        </button>
        <button onclick="closeCancelModal()"
          class="flex-1 border border-beige-dark text-stone py-3 rounded-xl text-sm hover:text-forest transition-colors">
          Voltar
        </button>
      </div>`;
  } catch {
    body.innerHTML = `<p class="text-sm text-red-600 py-2">Erro de conexão. Tente novamente.</p>
      <button onclick="closeCancelModal()" class="mt-3 w-full border border-beige-dark rounded-xl py-2.5 text-sm text-stone">Fechar</button>`;
  }
}

function closeCancelModal() {
  document.getElementById('cancel-modal').classList.add('hidden');
  _cancelBookingId = null;
}

async function confirmCancel() {
  if (!_cancelBookingId) return;
  const btn = document.getElementById('cancel-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelando…'; }

  try {
    const res  = await fetch(`/api/bookings/${_cancelBookingId}/cancel`, { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      const body = document.getElementById('cancel-modal-body');
      body.innerHTML = `<p class="text-sm text-red-600 py-2">${data.error || 'Erro ao cancelar.'}</p>
        <button onclick="closeCancelModal()" class="mt-3 w-full border border-beige-dark rounded-xl py-2.5 text-sm text-stone">Fechar</button>`;
      return;
    }

    closeCancelModal();
    window.location.reload(); // Refresh to reflect new status
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar cancelamento'; }
    alert('Erro de conexão. Tente novamente.');
  }
}

// ── Co-guest invite modal ─────────────────────────────────────────────────────
function openInviteModal(bookingId) {
  document.getElementById('invite-booking-id').value = bookingId;
  document.getElementById('invite-name').value  = '';
  document.getElementById('invite-email').value = '';
  document.getElementById('invite-phone').value = '';
  document.getElementById('invite-error').classList.add('hidden');
  document.getElementById('invite-submit').disabled = false;
  document.getElementById('invite-submit').textContent = 'Enviar convite';
  document.getElementById('invite-modal').classList.remove('hidden');
}

function closeInviteModal() {
  document.getElementById('invite-modal').classList.add('hidden');
}

async function submitInvite(e) {
  e.preventDefault();
  const bookingId = document.getElementById('invite-booking-id').value;
  const btn = document.getElementById('invite-submit');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  document.getElementById('invite-error').classList.add('hidden');

  try {
    const res = await fetch(`/api/dashboard/bookings/${bookingId}/guests`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:  document.getElementById('invite-name').value.trim(),
        email: document.getElementById('invite-email').value.trim(),
        phone: document.getElementById('invite-phone').value.trim() || undefined,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      document.getElementById('invite-error').textContent = data.error || 'Erro ao enviar convite';
      document.getElementById('invite-error').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Enviar convite';
      return;
    }

    closeInviteModal();
    loadGuests(bookingId);
  } catch {
    document.getElementById('invite-error').textContent = 'Erro de conexão. Tente novamente.';
    document.getElementById('invite-error').classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Enviar convite';
  }
}

async function removeGuest(bookingId, guestId) {
  try {
    const res = await fetch(`/api/dashboard/bookings/${bookingId}/guests/${guestId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Erro ao remover acompanhante.');
      return;
    }
    loadGuests(bookingId);
  } catch {
    alert('Erro de conexão. Tente novamente.');
  }
}

async function resendInvite(bookingId, guestId, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch(`/api/dashboard/bookings/${bookingId}/guests/${guestId}/resend`, { method: 'POST' });
    if (res.ok) {
      btn.textContent = '✓';
      setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 3000);
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Erro ao reenviar convite.');
      btn.disabled = false; btn.textContent = orig;
    }
  } catch {
    alert('Erro de conexão. Tente novamente.');
    btn.disabled = false; btn.textContent = orig;
  }
}

// ── Set-password banner ───────────────────────────────────────────────────────
function dismissPasswordBanner() {
  sessionStorage.setItem('pw-banner-dismissed', '1');
  document.getElementById('set-password-banner').classList.add('hidden');
}

async function setPassword() {
  const pw  = document.getElementById('banner-password').value;
  const pw2 = document.getElementById('banner-password-confirm').value;
  const err = document.getElementById('banner-pw-error');
  const ok  = document.getElementById('banner-pw-success');
  const btn = document.getElementById('banner-pw-btn');

  err.classList.add('hidden');
  ok.classList.add('hidden');

  if (!pw || pw.length < 6) {
    err.textContent = 'A senha deve ter pelo menos 6 caracteres.';
    err.classList.remove('hidden');
    return;
  }
  if (pw !== pw2) {
    err.textContent = 'As senhas não conferem.';
    err.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Salvando…';

  try {
    const res  = await fetch('/api/auth/set-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password: pw }),
    });
    const data = await res.json();

    if (!res.ok) {
      err.textContent = data.error || 'Erro ao salvar senha.';
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Salvar senha';
      return;
    }

    // Hide the form, show success message, auto-close banner after 6s
    document.getElementById('set-pw-form').classList.add('hidden');
    ok.classList.remove('hidden');
    sessionStorage.setItem('pw-banner-dismissed', '1');
    setTimeout(() => document.getElementById('set-password-banner').classList.add('hidden'), 6000);
  } catch {
    err.textContent = 'Erro de conexão. Tente novamente.';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Salvar senha';
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}
