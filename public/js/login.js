'use strict';

let currentEmail = '';
let currentTab   = 'email';
// Track which OTP step is visible so setLoading can restore it correctly
let activeStep   = 'email'; // 'email' | 'code'

// ── Tab switching ─────────────────────────────────────────────────────────────
function setTab(tab) {
  currentTab = tab;

  // Show / hide panels
  document.getElementById('panel-email').classList.toggle('hidden', tab !== 'email');
  document.getElementById('panel-password').classList.toggle('hidden', tab !== 'password');
  document.getElementById('panel-google').classList.toggle('hidden', tab !== 'google');

  // Active tab style — all use text-xs to match the HTML buttons
  const ACTIVE   = 'flex-1 py-2 rounded-lg text-xs font-semibold transition-all bg-white text-forest shadow-sm';
  const INACTIVE = 'flex-1 py-2 rounded-lg text-xs font-semibold transition-all text-stone';

  document.getElementById('tab-email').className    = tab === 'email'    ? ACTIVE : INACTIVE;
  document.getElementById('tab-password').className = tab === 'password' ? ACTIVE : INACTIVE;
  document.getElementById('tab-google').className   = tab === 'google'   ? ACTIVE : INACTIVE;
}

// ── Send OTP code ─────────────────────────────────────────────────────────────
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      // Rate-limit: show countdown if server provides minutesLeft
      const msg = data.minutesLeft
        ? `Muitas tentativas. Aguarde ${data.minutesLeft} min e tente novamente.`
        : (data.error || 'Erro ao enviar código');
      showError('email-error', msg);
      return;
    }

    currentEmail = email;
    activeStep   = 'code';
    document.getElementById('code-sent-to').textContent = email;
    document.getElementById('step-email').classList.add('hidden');
    document.getElementById('step-code').classList.remove('hidden');
    document.getElementById('input-code').focus();
  } catch {
    setLoading(false);
    showError('email-error', 'Erro de conexão. Tente novamente.');
  }
}

// ── Verify OTP code ───────────────────────────────────────────────────────────
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: currentEmail, code }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      showError('code-error', data.error || 'Código inválido ou expirado');
      return;
    }

    // Redirect to dashboard or returnTo (validated to be same-origin)
    const params     = new URLSearchParams(window.location.search);
    const returnTo   = params.get('returnTo') || '/dashboard';
    const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
    window.location.href = safeReturn;
  } catch {
    setLoading(false);
    showError('code-error', 'Erro de conexão. Tente novamente.');
  }
}

// ── Resend OTP code ───────────────────────────────────────────────────────────
async function resendCode() {
  const btn = document.getElementById('resend-btn');
  btn.disabled    = true;
  btn.textContent = 'Enviando…';

  try {
    const res  = await fetch('/api/auth/resend-code', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: currentEmail }),
    });
    const data = await res.json();

    if (res.ok) {
      btn.textContent = 'Código reenviado ✓';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Reenviar código'; }, 5000);
    } else if (data.minutesLeft) {
      // Show countdown for rate limit
      btn.textContent = `Aguarde ${data.minutesLeft} min`;
      startResendCountdown(btn, data.minutesLeft);
    } else {
      btn.textContent = data.error || 'Erro ao reenviar';
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Reenviar código'; }, 4000);
    }
  } catch {
    btn.disabled    = false;
    btn.textContent = 'Reenviar código';
  }
}

// Countdown timer displayed on the resend button while rate-limited
function startResendCountdown(btn, totalMinutes) {
  let seconds = totalMinutes * 60;
  const tick  = setInterval(() => {
    seconds--;
    if (seconds <= 0) {
      clearInterval(tick);
      btn.disabled    = false;
      btn.textContent = 'Reenviar código';
    } else {
      const m = Math.floor(seconds / 60);
      const s = String(seconds % 60).padStart(2, '0');
      btn.textContent = `Aguarde ${m}:${s}`;
    }
  }, 1000);
}

// ── Back to email step ────────────────────────────────────────────────────────
function backToEmail() {
  activeStep = 'email';
  document.getElementById('step-email').classList.remove('hidden');
  document.getElementById('step-code').classList.add('hidden');
  document.getElementById('input-code').value = '';
  hideError('code-error');
}

// ── Password login ────────────────────────────────────────────────────────────
async function loginPassword() {
  const email    = document.getElementById('pw-email').value.trim();
  const password = document.getElementById('pw-password').value;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showError('pw-error', 'Digite um e-mail válido');
    return;
  }
  if (!password || password.length < 6) {
    showError('pw-error', 'Senha deve ter ao menos 6 caracteres');
    return;
  }
  hideError('pw-error');

  const btn = document.querySelector('#panel-password button[onclick="loginPassword()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Entrando…'; }

  try {
    const res  = await fetch('/api/auth/login-password', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar com senha'; }
      showError('pw-error', data.error || 'E-mail ou senha incorretos');
      return;
    }

    // Success — redirect
    const params     = new URLSearchParams(window.location.search);
    const returnTo   = params.get('returnTo') || '/dashboard';
    const safeReturn = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
    window.location.href = safeReturn;
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = 'Entrar com senha'; }
    showError('pw-error', 'Erro de conexão. Tente novamente.');
  }
}

// ── Loading overlay (OTP panel only) ─────────────────────────────────────────
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
    // Restore whichever step was active before loading
    if (activeStep === 'code') {
      codeEl.classList.remove('hidden');
    } else {
      stepEl.classList.remove('hidden');
    }
  }
}

// ── Error helpers ─────────────────────────────────────────────────────────────
function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function hideError(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// ── "Primeiro acesso" info panel ──────────────────────────────────────────────
function toggleFirstAccess() {
  document.getElementById('first-access-panel').classList.toggle('hidden');
}

// ── Show error from URL param (e.g. Google OAuth failure) ─────────────────────
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

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // OTP email step
  document.getElementById('input-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendCode();
  });

  // OTP code step
  document.getElementById('input-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') verifyCode();
  });
  // Strip non-digits and cap at 6 chars
  document.getElementById('input-code')?.addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });

  // Password panel — Tab from email into password field, Enter on password → login
  document.getElementById('pw-email')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('pw-password')?.focus();
  });
  document.getElementById('pw-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') loginPassword();
  });
});
