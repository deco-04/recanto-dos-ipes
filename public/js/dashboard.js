'use strict';

const fmtDate   = d => new Date(d).toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
const fmtBRL    = v => new Intl.NumberFormat('pt-BR', { style:'currency', currency:'BRL' }).format(Number(v));
const countdown = d => {
  const days = Math.ceil((new Date(d) - new Date()) / (1000*60*60*24));
  if (days === 0) return 'Hoje!';
  if (days === 1) return 'Amanhã';
  return `${days} dias`;
};

(async function init() {
  // Check authentication
  const meRes = await fetch('/api/auth/me');
  if (!meRes.ok) {
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('error-state').classList.remove('hidden');
    return;
  }
  const { user } = await meRes.json();
  document.getElementById('nav-user').textContent = user.email;
  document.getElementById('nav-user').classList.remove('hidden');
  document.getElementById('user-greeting').textContent =
    `Olá${user.name ? ', ' + user.name : ''}! Bem-vindo(a) de volta.`;

  // Load all dashboard data in parallel
  const [currentRes, upcomingRes, pastRes] = await Promise.all([
    fetch('/api/dashboard/current'),
    fetch('/api/dashboard/upcoming'),
    fetch('/api/dashboard/past'),
  ]);

  document.getElementById('loading-state').classList.add('hidden');
  document.getElementById('main-content').classList.remove('hidden');

  // Current stay
  if (currentRes.ok) {
    const { booking } = await currentRes.json();
    if (booking) renderCurrentStay(booking);
  }

  // Upcoming
  if (upcomingRes.ok) {
    const { bookings: upcomingBookings } = await upcomingRes.json();
    if (upcomingBookings?.length > 0) renderUpcoming(upcomingBookings);
    else document.getElementById('no-upcoming').classList.remove('hidden');
  }

  // Past
  if (pastRes.ok) {
    const { bookings } = await pastRes.json();
    if (bookings.length > 0) renderPast(bookings);
    else document.getElementById('no-past').classList.remove('hidden');
  }
})();

function renderCurrentStay(b) {
  document.getElementById('current-section').classList.remove('hidden');
  document.getElementById('current-card').innerHTML = `
    <div class="flex items-start justify-between mb-4">
      <div>
        <p class="text-xs text-white/60 uppercase tracking-widest mb-1">Estadia em andamento</p>
        <p class="font-serif text-xl font-bold">Sítio Recanto dos Ipês</p>
        <p class="text-white/70 text-sm mt-1">Jaboticatubas, MG</p>
      </div>
      <span class="bg-gold text-forest text-xs font-bold px-3 py-1 rounded-full">Check-in hoje</span>
    </div>
    <div class="grid grid-cols-2 gap-4 text-sm">
      <div><p class="text-white/60 text-xs">Check-in</p><p class="font-semibold">${fmtDate(b.checkIn)}</p></div>
      <div><p class="text-white/60 text-xs">Check-out</p><p class="font-semibold">${fmtDate(b.checkOut)}</p></div>
      <div><p class="text-white/60 text-xs">Hóspedes</p><p class="font-semibold">${b.guestCount}</p></div>
      <div><p class="text-white/60 text-xs">Total pago</p><p class="font-semibold">${fmtBRL(b.totalAmount)}</p></div>
    </div>
    <p class="text-white/40 text-xs mt-4 font-mono">Reserva nº ${b.invoiceNumber}</p>
  `;
}

function renderUpcoming(bookings) {
  document.getElementById('upcoming-section').classList.remove('hidden');
  document.getElementById('upcoming-card').innerHTML = bookings.map((b, i) => `
    <div class="${i > 0 ? 'mt-4 pt-4 border-t border-beige-dark' : ''}">
      <div class="flex items-start justify-between mb-4">
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
      <div class="flex items-center justify-between mt-4 pt-4 border-t border-beige-dark">
        <p class="text-xs text-stone font-mono">Reserva nº ${b.invoiceNumber}</p>
        <p class="font-bold text-forest text-lg">${fmtBRL(b.totalAmount)}</p>
      </div>
    </div>
  `).join('');
}

function renderPast(bookings) {
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

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}
