'use strict';

const fmtDate   = d => new Date(d).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
const fmtBRL    = v => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(v));
const countdown = d => {
  const days = Math.ceil((new Date(d) - new Date()) / (1000*60*60*24));
  if (days === 0) return 'Hoje!';
  if (days === 1) return 'Amanhã';
  return `${days} dias`;
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
  const [currentRes, upcomingRes, pastRes] = await Promise.all([
    fetch('/api/dashboard/current'),
    fetch('/api/dashboard/upcoming'),
    fetch('/api/dashboard/past'),
  ]);

  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('main-content').classList.remove('hidden');

  let hasAny = false;

  if (currentRes.ok) {
    const { booking } = await currentRes.json();
    if (booking) { renderCurrentStay(booking); hasAny = true; }
  }

  if (upcomingRes.ok) {
    const { bookings: upcoming } = await upcomingRes.json();
    if (upcoming?.length > 0) { renderUpcoming(upcoming); hasAny = true; }
  }

  if (pastRes.ok) {
    const { bookings: past } = await pastRes.json();
    if (past?.length > 0) { renderPast(past); hasAny = true; }
  }

  if (!hasAny) {
    document.getElementById('empty-state').classList.remove('hidden');
  }
})();

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
}

function cancelProfile() {
  document.getElementById('profile-form').classList.add('hidden');
  document.getElementById('profile-view').classList.remove('hidden');
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

// ── Current stay ──────────────────────────────────────────────────────────────
function renderCurrentStay(b) {
  document.getElementById('current-section').classList.remove('hidden');
  document.getElementById('current-card').innerHTML = `
    <div class="flex items-start justify-between mb-4 flex-wrap gap-2">
      <div>
        <p class="text-xs text-white/60 uppercase tracking-widest mb-1">Estadia em andamento</p>
        <p class="font-serif text-xl font-bold">Sítio Recanto dos Ipês</p>
        <p class="text-white/70 text-sm mt-1">Jaboticatubas, MG</p>
      </div>
      <span class="bg-gold text-forest text-xs font-bold px-3 py-1 rounded-full">Hospedado agora</span>
    </div>
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div><p class="text-white/60 text-xs">Check-in</p><p class="font-semibold">${fmtDate(b.checkIn)}</p></div>
      <div><p class="text-white/60 text-xs">Check-out</p><p class="font-semibold">${fmtDate(b.checkOut)}</p></div>
      <div><p class="text-white/60 text-xs">Hóspedes</p><p class="font-semibold">${b.guestCount}</p></div>
      <div><p class="text-white/60 text-xs">Total pago</p><p class="font-semibold">${fmtBRL(b.totalAmount)}</p></div>
    </div>
    <p class="text-white/40 text-xs mt-4 font-mono">Reserva nº ${b.invoiceNumber}</p>
    ${renderGuestSection(b.id, [], true)}
  `;
  loadGuests(b.id);
}

// ── Upcoming stays ────────────────────────────────────────────────────────────
function renderUpcoming(bookings) {
  document.getElementById('upcoming-section').classList.remove('hidden');
  document.getElementById('upcoming-card').innerHTML = bookings.map((b, i) => `
    <div class="${i > 0 ? 'mt-4 pt-4 border-t border-beige-dark' : ''}">
      <div class="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <p class="font-serif text-lg font-bold text-forest">Sítio Recanto dos Ipês</p>
          <p class="text-stone text-sm">Jaboticatubas, MG</p>
        </div>
        <span class="bg-gold/20 text-gold-dark text-sm font-bold px-3 py-1 rounded-full">${countdown(b.checkIn)}</span>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Check-in</p><p class="font-semibold text-forest">${fmtDate(b.checkIn)}</p></div>
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Check-out</p><p class="font-semibold text-forest">${fmtDate(b.checkOut)}</p></div>
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Noites</p><p class="font-semibold text-forest">${b.nights}</p></div>
        <div class="bg-beige rounded-xl p-3"><p class="text-xs text-stone mb-1">Hóspedes</p><p class="font-semibold text-forest">${b.guestCount}</p></div>
      </div>
      <div class="flex items-center justify-between mt-4 pt-4 border-t border-beige-dark flex-wrap gap-2">
        <p class="text-xs text-stone font-mono">Reserva nº ${b.invoiceNumber}</p>
        <p class="font-bold text-forest text-lg">${fmtBRL(b.totalAmount)}</p>
      </div>
      ${renderGuestSection(b.id, [], false)}
    </div>
  `).join('');
  bookings.forEach(b => loadGuests(b.id));
}

// ── Past stays ────────────────────────────────────────────────────────────────
function renderPast(bookings) {
  document.getElementById('past-section').classList.remove('hidden');
  document.getElementById('past-list').innerHTML = bookings.map(b => `
    <div class="bg-white rounded-2xl p-5 border border-beige-dark flex items-center justify-between gap-4 flex-wrap">
      <div>
        <p class="font-semibold text-forest text-sm">${fmtDate(b.checkIn)} → ${fmtDate(b.checkOut)}</p>
        <p class="text-stone text-xs mt-0.5">${b.nights} noite${b.nights > 1 ? 's' : ''} · ${b.guestCount} hóspede${b.guestCount > 1 ? 's' : ''}</p>
        <p class="text-xs text-stone/60 font-mono mt-0.5">${b.invoiceNumber}</p>
      </div>
      <div class="text-right">
        <p class="font-bold text-forest">${fmtBRL(b.totalAmount)}</p>
        <span class="text-xs px-2 py-0.5 rounded-full ${b.status === 'CONFIRMED' ? 'bg-green-100 text-green-700' : 'bg-stone/10 text-stone'}">
          ${b.status === 'CONFIRMED' ? 'Concluída' : b.status}
        </span>
      </div>
    </div>
  `).join('');
}

// ── Co-guest section (rendered inside booking cards) ──────────────────────────
function renderGuestSection(bookingId, guests, dark) {
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
        ${g.status === 'PENDENTE' ? `
          <button onclick="removeGuest('${bookingId}','${g.id}')" class="text-xs ${textMuted} hover:opacity-100 opacity-60">✕</button>
        ` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div class="mt-4 pt-4 border-t ${borderCol}">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-semibold uppercase tracking-wider ${textMuted}">Acompanhantes</p>
        <button onclick="openInviteModal('${bookingId}')"
          class="text-xs font-medium ${textMain} border ${borderCol} px-2.5 py-1 rounded-lg hover:opacity-80 transition-opacity">
          + Convidar
        </button>
      </div>
      <div id="guests-${bookingId}">
        ${guests.length === 0 ? `<p class="text-xs ${textMuted} italic">Nenhum acompanhante adicionado.</p>` : guestItems}
      </div>
    </div>
  `;
}

async function loadGuests(bookingId) {
  try {
    const res = await fetch(`/api/dashboard/bookings/${bookingId}/guests`);
    if (!res.ok) return;
    const { guests } = await res.json();
    const container = document.getElementById(`guests-${bookingId}`);
    if (!container) return;
    // Determine if we're in a dark card (current stay)
    const dark = container.closest('.bg-forest') !== null;
    const textMuted = dark ? 'text-white/60' : 'text-stone';
    const textMain  = dark ? 'text-white'    : 'text-forest';
    const badgePending   = dark ? 'bg-white/10 text-white/70' : 'bg-amber-50 text-amber-700';
    const badgeConfirmed = dark ? 'bg-gold/30 text-white'     : 'bg-green-50 text-green-700';
    const borderCol = dark ? 'border-white/20' : 'border-beige-dark';

    if (guests.length === 0) {
      container.innerHTML = `<p class="text-xs ${textMuted} italic">Nenhum acompanhante adicionado.</p>`;
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
          ${g.status === 'PENDENTE' ? `
            <button onclick="removeGuest('${bookingId}','${g.id}')"
              class="text-xs ${textMuted} hover:opacity-100 opacity-60">✕</button>
          ` : ''}
        </div>
      </div>
    `).join('');
  } catch { /* silent — guests are non-critical */ }
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
    await fetch(`/api/dashboard/bookings/${bookingId}/guests/${guestId}`, { method: 'DELETE' });
    loadGuests(bookingId);
  } catch { /* silent */ }
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}
