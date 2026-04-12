'use strict';

let currentEmail = '';
let currentTab   = 'email';

function setTab(tab) {
  currentTab = tab;
  document.getElementById('panel-email').classList.toggle('hidden', tab !== 'email');
  document.getElementById('panel-google').classList.toggle('hidden', tab !== 'google');
  document.getElementById('tab-email').className  = tab === 'email'
    ? 'flex-1 py-2 rounded-lg text-sm font-semibold transition-all bg-white text-forest shadow-sm'
    : 'flex-1 py-2 rounded-lg text-sm font-semibold transition-all text-stone';
  document.getElementById('tab-google').className = tab === 'google'
    ? 'flex-1 py-2 rounded-lg text-sm font-semibold transition-all bg-white text-forest shadow-sm'
    : 'flex-1 py-2 rounded-lg text-sm font-semibold transition-all text-stone';
}

async function sendCode() {
  const email = document.getElementById('input-email').value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError('email-error', 'Digite um e-mail válido');
    return;
  }
  hideError('email-error');
  setLoading(true, 'Enviando código…');

  try {
    const res  = await fetch('/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      showError('email-error', data.error || 'Erro ao enviar código');
      return;
    }

    currentEmail = email;
    document.getElementById('code-sent-to').textContent = email;
    document.getElementById('step-email').classList.add('hidden');
    document.getElementById('step-code').classList.remove('hidden');
    document.getElementById('input-code').focus();
  } catch {
    setLoading(false);
    showError('email-error', 'Erro de conexão. Tente novamente.');
  }
}

async function verifyCode() {
  const code = document.getElementById('input-code').value.trim();
  if (code.length !== 6) {
    showError('code-error', 'Digite o código de 6 dígitos');
    return;
  }
  hideError('code-error');
  setLoading(true, 'Verificando…');

  try {
    const res  = await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail, code }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      showError('code-error', data.error || 'Código inválido');
      return;
    }

    // Redirect to dashboard or returnTo (validated to be same-origin)
    const params = new URLSearchParams(window.location.search);
    const returnTo = params.get('returnTo') || '/dashboard';
    const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
    window.location.href = safeReturn;
  } catch {
    setLoading(false);
    showError('code-error', 'Erro de conexão. Tente novamente.');
  }
}

async function resendCode() {
  const btn = document.getElementById('resend-btn');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  setLoading(true, 'Reenviando código…');

  try {
    const res = await fetch('/api/auth/resend-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentEmail }),
    });
    const data = await res.json();
    setLoading(false);
    btn.textContent = res.ok ? 'Código reenviado ✓' : data.error || 'Erro ao reenviar';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Reenviar código'; }, 5000);
  } catch {
    setLoading(false);
    btn.disabled = false;
    btn.textContent = 'Reenviar código';
  }
}

function backToEmail() {
  document.getElementById('step-email').classList.remove('hidden');
  document.getElementById('step-code').classList.add('hidden');
  document.getElementById('input-code').value = '';
  hideError('code-error');
}

function setLoading(on, msg) {
  const loadEl = document.getElementById('email-loading');
  const stepEl = document.getElementById('step-email');
  const codeEl = document.getElementById('step-code');
  if (on) {
    document.getElementById('loading-msg').textContent = msg || 'Aguarde…';
    loadEl.classList.remove('hidden');
    loadEl.classList.add('flex');
    stepEl.classList.add('hidden');
    codeEl.classList.add('hidden');
  } else {
    loadEl.classList.add('hidden');
    loadEl.classList.remove('flex');
    // Restore correct step
    if (currentEmail && !codeEl.classList.contains('hidden')) {
      codeEl.classList.remove('hidden');
    } else {
      stepEl.classList.remove('hidden');
    }
  }
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// Show error from URL param (e.g. Google OAuth failure)
(function checkUrlError() {
  const params = new URLSearchParams(window.location.search);
  const error  = params.get('error');
  if (error) {
    const container = document.getElementById('url-error');
    const msg       = document.getElementById('url-error-msg');
    msg.textContent = error === 'google'
      ? 'Ocorreu um erro ao autenticar com o Google. Tente pelo e-mail ou tente novamente.'
      : 'Ocorreu um erro. Tente novamente.';
    container.classList.remove('hidden');
    // Clean URL so refresh doesn't re-show the error
    history.replaceState(null, '', window.location.pathname);
  }
})();

// Allow pressing Enter in inputs
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('input-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendCode();
  });
  document.getElementById('input-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') verifyCode();
  });
  // Auto-format code input
  document.getElementById('input-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
});
