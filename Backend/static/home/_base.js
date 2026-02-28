/* ═══════════════════════════════════════════════════════════════
   Purp — Web Dashboard _base.js  v2.0
   Todas as funções da extensão adaptadas para contexto web.
   Sem chrome.storage, sem chrome.runtime — 100% localStorage + fetch.
   ════════════════════════════════════════════════════════════════ */

// ── Config ───────────────────────────────────────────────────────
const API_BASE         = 'https://purp-production.up.railway.app';
const FREE_ASSET_LIMIT = 4;
const REFRESH_MS       = 60_000;

// ── Helpers ──────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

const formatUSD = (v) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v ?? 0);
const formatPct = (v) => `${v >= 0 ? '+' : ''}${(v || 0).toFixed(2)}%`;

// ── State ────────────────────────────────────────────────────────
let authToken             = null;
let currentUser           = null;
let assetForSale          = null;
let mainChart             = null;
let detailChart           = null;
let refreshTimer          = null;
let searchTimer           = null;
let portfolioCount        = 0;
let portfolioSymbols      = new Set();
let rebalanceSymbols      = [];
let watchlistSymbols      = new Set();
let watchlistIdBySymbol    = {};
let lastMarketStocks      = [];
let lastMarketCryptos     = [];
let hideSensitiveValues   = true;
let selectedAddAssetType  = null;
let activeTaxTab          = 'tlh';
let importSelectedFile    = null;
let importSelectedBroker  = '';
let _divCardBuilt         = false;
let _divShowAllAssets     = false;
let _detailSymbol         = '';
let _detailPeriod         = '1mo';
let detailChartMode       = 'line';

const FEATURED_STOCKS  = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA'];
const FEATURED_CRYPTOS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];
const MONTHS_SHORT     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ════════════════════════════════════════════════════════════════
// SESSION — sem chrome.storage, 100% localStorage
// ════════════════════════════════════════════════════════════════

function saveSession(token, user) {
  authToken   = token;
  currentUser = user;
  localStorage.setItem('auth_token', token || '');
  localStorage.setItem('purp_user',  JSON.stringify(user || null));
}

function loadSession(callback) {
  const token = localStorage.getItem('auth_token');
  const raw   = localStorage.getItem('purp_user');
  if (token && raw) {
    try {
      authToken   = token;
      currentUser = JSON.parse(raw);
      callback(true);
      return;
    } catch (_) {}
  }
  callback(false);
}

function clearSession() {
  authToken       = null;
  currentUser     = null;
  portfolioCount  = 0;
  portfolioSymbols = new Set();
  stopRefresh();
  localStorage.removeItem('auth_token');
  localStorage.removeItem('purp_user');
  localStorage.removeItem('pending_email');
}

function ensureAuth() {
  if (!authToken) {
    window.location.href = '/';
  }
}

// ── Plan helpers ─────────────────────────────────────────────────
const isPremium = () => !!(currentUser?.is_premium) || ['investor','tax_pro'].includes(currentUser?.plan);
const isTaxPro  = () => currentUser?.plan === 'tax_pro';

// Converte o campo detail do FastAPI para string legível (pode vir como array em erros 422)
function apiErrorDetail(detail, fallback = 'Algo deu errado. Tente novamente.') {
  if (!detail) return fallback;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    return detail.map(d => d.msg || d.message || JSON.stringify(d)).join('; ');
  }
  return fallback;
}

// ════════════════════════════════════════════════════════════════
// ERROR MAPPING — actionable messages by HTTP status code
// ════════════════════════════════════════════════════════════════

const ERROR_MAP = {
  400: 'Invalid request — check the data entered.',
  402: 'Plan limit reached. Upgrade to add more assets.',
  403: 'Permission denied. Check your API key in Settings.',
  404: 'Resource not found.',
  409: 'Conflict — this item already exists.',
  422: 'Validation error — check the fields and try again.',
  429: 'Too many requests — wait a moment and try again.',
  500: 'Server error — our team has been notified.',
  502: 'Service temporarily unavailable. Try again shortly.',
  503: 'API connection failed — price data may be delayed.',
};

function _errorMsgForStatus(status, path) {
  if (status === 403 && (path.includes('/broker') || path.includes('/analysis') || path.includes('/exchange'))) {
    return 'API key permission error — go to Settings and verify your key.';
  }
  return ERROR_MAP[status] || `Unexpected error (${status}).`;
}

// ── Form draft helpers (used by graceful expire) ──────────────────
function _saveFormDraft() {
  const draft = {};
  const fields = ['symbol-input', 'amount-input', 'price-input', 'date-input'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) draft[id] = el.value;
  });
  if (Object.keys(draft).length) {
    sessionStorage.setItem('purp_form_draft', JSON.stringify(draft));
  }
}

function _restoreFormDraft() {
  try {
    const raw = sessionStorage.getItem('purp_form_draft');
    if (!raw) return;
    const draft = JSON.parse(raw);
    Object.entries(draft).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    });
    sessionStorage.removeItem('purp_form_draft');
    toast('Your unsaved form data has been restored.', 'info', 4000);
  } catch (_) {}
}

// ════════════════════════════════════════════════════════════════
// API FETCH — error mapping + graceful 401
// ════════════════════════════════════════════════════════════════

let _expireCountdown = null;

function gracefulExpire() {
  if (_expireCountdown) return; // already running
  _saveFormDraft();
  let secs = 5;
  toast(`Session expired — redirecting in ${secs}s… (or sign in below)`, 'warning', 5500);
  _expireCountdown = setInterval(() => {
    secs -= 1;
    if (secs <= 0) {
      clearInterval(_expireCountdown);
      _expireCountdown = null;
      clearSession();
      window.location.href = '/';
    }
  }, 1000);
}

async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401) {
      gracefulExpire();
      return null;
    }
    if (!res.ok && res.status !== 402) {
      // 402 is handled inline by callers (upgrade modal); all others get a toast
      const msg = _errorMsgForStatus(res.status, path);
      // Try to get backend detail for 422/400
      if (res.status === 422 || res.status === 400) {
        try {
          const body = await res.clone().json();
          const detail = apiErrorDetail(body?.detail);
          if (detail && detail !== 'Algo deu errado. Tente novamente.') {
            toast(detail, 'error');
            return res;
          }
        } catch (_) {}
      }
      toast(msg, 'error');
    }
    return res;
  } catch (e) {
    console.error('Network error:', e);
    toast('Connection error — check your internet connection.', 'error');
    return null;
  }
}

function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(authToken ? {
      'X-Auth-Token':   authToken,
      'Authorization':  `Bearer ${authToken}`,
    } : {}),
    ...extra,
  };
}

function assetIconUrl(icon, symbol) {
  const sym = (symbol || '').toUpperCase() || '';
  if (icon && icon.startsWith('http')) return icon;
  return API_BASE + (icon && icon.startsWith('/') ? icon : '/logo/' + sym);
}

// ════════════════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════════════════

function toast(msg, type = 'info', duration = 3500) {
  let container = $('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText =
      'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(container);
  }
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const colors = {
    success: 'rgba(16,185,129,.15)',
    error:   'rgba(239,68,68,.15)',
    warning: 'rgba(245,158,11,.15)',
    info:    'rgba(124,58,237,.15)',
  };
  const borders = {
    success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#7c3aed',
  };
  const el = document.createElement('div');
  el.style.cssText = `
    display:flex;align-items:center;gap:10px;padding:12px 16px;
    background:${colors[type] || colors.info};
    border:1px solid ${borders[type] || borders.info};
    border-radius:12px;color:#f1f0f5;font-size:13px;
    backdrop-filter:blur(10px);max-width:320px;
    animation:toastIn .25s ease;
  `;
  el.innerHTML = `<span style="font-weight:700;">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all .3s ease';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ── Error helpers ─────────────────────────────────────────────────
function showError(elId, msg) {
  const el = $(elId); if (!el) return;
  el.textContent = msg; el.classList.remove('hidden');
}
function clearError(elId) {
  const el = $(elId); if (!el) return;
  el.textContent = ''; el.classList.add('hidden');
}

// ════════════════════════════════════════════════════════════════
// REFRESH
// ════════════════════════════════════════════════════════════════

function startRefresh() {
  stopRefresh();
  const path = (window.location.pathname || '').replace(/\/$/, '') || '/home';
  refreshTimer = setInterval(() => {
    if (!authToken) return;
    fetchPortfolio();
    if (path === '/home') {
      if ($('mainChart')) loadMainChart(true);
      if (typeof loadDividendCard === 'function') loadDividendCard();
    } else if (path === '/home/market' && $('market-stocks-list')) {
      loadMarketWatch();
    } else if (path === '/home/alerts' && $('alerts-list')) {
      loadAlerts();
    }
  }, REFRESH_MS);
}
function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ════════════════════════════════════════════════════════════════
// LOGIN / REGISTER  (para páginas com formulário inline)
// ════════════════════════════════════════════════════════════════

function showLoginScreen() {
  $('login-screen')?.classList.remove('hidden');
  $('app-shell')?.classList.add('hidden');
}
function hideLoginScreen() {
  $('login-screen')?.classList.add('hidden');
}

function toggleAuthMode() {
  $('login-form')?.classList.toggle('hidden');
  $('register-form')?.classList.toggle('hidden');
}

async function handleLogin() {
  const email    = $('login-email')?.value.trim().toLowerCase() || '';
  const password = $('login-password')?.value || '';
  clearError('login-error');

  if (!email || !password) {
    showError('login-error', 'Please fill in email and password.'); return;
  }

  const btn = $('btn-login');
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Entrando…'; }

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      saveSession(data.token, data.user);

      if (data.requires_verification) {
        const emailForVerify = data.user?.email || email;
        localStorage.setItem('pending_email', emailForVerify);
        showVerifyScreen(data.token, emailForVerify, (verifiedUser, newToken) => {
          const updated = { ...data.user, ...verifiedUser, is_verified: true };
          saveSession(newToken || data.token, updated);
          finalizeLoginUI();
          toast('Email verified! Welcome 🎉', 'success', 5000);
        });
        return;
      }

      finalizeLoginUI();
      _restoreFormDraft();
      toast('Welcome back! 🎉', 'success', 3000);
    } else {
      showError('login-error', apiErrorDetail(data.detail, 'Email ou senha incorretos.'));
    }
  } catch (err) {
    showError('login-error', 'Falha na conexão com o servidor.');
  } finally {
    if (btn) { btn.disabled = false; if (orig) btn.textContent = orig; }
  }
}

async function handleRegister() {
  const fullName = $('reg-full-name')?.value.trim() || '';
  const email    = $('reg-email')?.value.trim()     || '';
  const password = $('reg-password')?.value         || '';
  clearError('register-error');

  if (!fullName || !email || !password) {
    showError('register-error', 'All fields are required.'); return;
  }
  if (fullName.length < 3) {
    showError('register-error', 'Full name must be at least 3 characters.'); return;
  }
  if (password.length < 4) {
    showError('register-error', 'Password must be at least 4 characters.'); return;
  }
  if (!email.includes('@')) {
    showError('register-error', 'Enter a valid email.'); return;
  }

  const btn = $('btn-register');
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }

  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ full_name: fullName, email, password }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      saveSession(data.token, data.user);
      localStorage.setItem('pending_email', email);

      if (data.requires_verification) {
        const emailForVerify = data.email || data.user?.email || email;
        showVerifyScreen(data.token, emailForVerify, (verifiedUser, newToken) => {
          const updated = { ...data.user, ...verifiedUser, is_verified: true };
          saveSession(newToken || data.token, updated);
          finalizeLoginUI();
          toast('Account created and verified! Welcome to Purp 🎉', 'success', 5000);
        });
        return;
      }

      finalizeLoginUI();
      _restoreFormDraft();
      toast('Account created! 🎉', 'success', 5000);
    } else {
      showError('register-error', apiErrorDetail(data.detail, data.message || `Erro ${res.status}`));
    }
  } catch (err) {
    showError('register-error', `Falha de conexão: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; if (orig) btn.textContent = orig; }
  }
}

function finalizeLoginUI() {
  hideLoginScreen();
  const shell = $('app-shell');
  if (shell) shell.classList.remove('hidden');
  updateProfileBar();
  fetchPortfolio(); // necessário para profile bar em todas as páginas
  // Carrega dados específicos da página atual (navegação por páginas separadas)
  const path = (window.location.pathname || '').replace(/\/$/, '') || '/home';
  if (path === '/home') {
    if ($('mainChart')) loadMainChart();
    checkAIStatus();
  } else if (path === '/home/market') {
    loadMarketWatch();
  } else if (path === '/home/alerts') {
    loadAlerts();
  } else if (path === '/home/transactions') {
    loadTransactions();
  }
  startRefresh(); // refresh periódico (fetchPortfolio + dados da página atual)
}

async function handleLogout() {
  clearSession();
  window.location.href = '/';
}

// ════════════════════════════════════════════════════════════════
// VERIFY SCREEN  (inline — sem dependência de Verify-screen.JS)
// ════════════════════════════════════════════════════════════════

let _vfyToken = null;
let _vfyTimer = null;

function buildVerifyScreen(email) {
  const masked = (() => {
    if (!email) return '—';
    const [local, domain] = email.split('@');
    if (!domain) return email;
    const vis = local.length <= 2 ? local[0] : local.slice(0, 2);
    return `${vis}${'●'.repeat(Math.max(0, Math.min(local.length - 2, 4)))}@${domain}`;
  })();

  const el = document.createElement('div');
  el.id = 'verify-screen';
  el.style.cssText =
    'position:fixed;inset:0;background:#0a0914;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;padding:24px;z-index:9999;font-family:sans-serif;';
  el.innerHTML = `
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-60%);width:280px;height:280px;
      background:radial-gradient(circle,rgba(124,58,237,.16) 0%,transparent 70%);pointer-events:none;"></div>
    <div style="width:60px;height:60px;background:linear-gradient(135deg,#7c3aed,#a78bfa);border-radius:16px;
      display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:18px;
      box-shadow:0 8px 28px rgba(124,58,237,.4);">🔐</div>
    <h2 style="color:#f1f0f5;font-size:17px;font-weight:800;margin:0 0 6px;text-align:center;">Verifique seu email</h2>
    <p style="color:rgba(241,240,245,.4);font-size:11px;margin:0 0 22px;text-align:center;line-height:1.55;">
      Enviamos um código de 6 dígitos para<br>
      <span style="color:#a78bfa;font-weight:700;">${masked}</span>
    </p>
    <div id="vfy-inputs" style="display:flex;gap:7px;margin-bottom:16px;">
      ${[0,1,2,3,4,5].map(i =>
        `<input id="vd${i}" type="text" inputmode="numeric" maxlength="1"
          style="width:38px;height:46px;background:rgba(124,58,237,.1);border:2px solid rgba(124,58,237,.28);
          border-radius:9px;color:#fff;font-size:20px;font-weight:900;text-align:center;outline:none;
          font-family:monospace;caret-color:transparent;transition:border-color .15s,background .15s;">`
      ).join('')}
    </div>
    <div id="vfy-error" style="color:#f87171;font-size:11px;min-height:15px;margin:0 0 10px;text-align:center;display:none;"></div>
    <button id="vfy-btn" style="width:100%;max-width:232px;padding:11px;
      background:linear-gradient(135deg,#7c3aed,#a78bfa);border:none;border-radius:11px;
      color:#fff;font-size:13px;font-weight:700;cursor:pointer;
      box-shadow:0 4px 18px rgba(124,58,237,.35);margin-bottom:12px;">Verificar conta</button>
    <div style="text-align:center;">
      <span style="color:rgba(241,240,245,.3);font-size:11px;">Não recebeu? </span>
      <button id="vfy-resend-btn" style="background:none;border:none;color:#a78bfa;font-size:11px;font-weight:700;cursor:pointer;padding:0;">Reenviar código</button>
      <span id="vfy-countdown" style="color:rgba(241,240,245,.25);font-size:11px;display:none;"></span>
    </div>
    <button id="vfy-back" style="background:none;border:none;color:rgba(241,240,245,.2);font-size:10px;cursor:pointer;margin-top:14px;padding:0;">← Usar outra conta</button>`;
  return el;
}

function showVerifyScreen(token, email, onSuccess) {
  _vfyToken = token;
  document.getElementById('verify-screen')?.remove();

  if (!document.getElementById('vfy-shake-style')) {
    const s = document.createElement('style');
    s.id = 'vfy-shake-style';
    s.textContent = `@keyframes vfyShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`;
    document.head.appendChild(s);
  }

  const screen = buildVerifyScreen(email);
  document.body.appendChild(screen);
  setTimeout(() => document.getElementById('vd0')?.focus(), 100);

  const getCode = () => [0,1,2,3,4,5].map(i => document.getElementById(`vd${i}`)?.value || '').join('');

  const showVfyError = (msg) => {
    const el = $('vfy-error'); if (el) { el.textContent = msg; el.style.display = 'block'; }
  };
  const clearVfyError = () => {
    const el = $('vfy-error'); if (el) el.style.display = 'none';
  };
  const shakeInputs = () => {
    const c = $('vfy-inputs'); if (!c) return;
    c.style.animation = 'vfyShake .32s ease';
    c.addEventListener('animationend', () => { c.style.animation = ''; }, { once: true });
    [0,1,2,3,4,5].forEach(i => {
      const el = document.getElementById(`vd${i}`);
      if (el) { el.style.borderColor = '#f87171'; el.style.background = 'rgba(248,113,113,.1)'; }
    });
    setTimeout(() => {
      [0,1,2,3,4,5].forEach(i => {
        const el = document.getElementById(`vd${i}`);
        if (el) { el.style.borderColor = 'rgba(124,58,237,.28)'; el.style.background = 'rgba(124,58,237,.1)'; }
      });
    }, 900);
  };

  [0,1,2,3,4,5].forEach(i => {
    const el = document.getElementById(`vd${i}`);
    if (!el) return;
    el.addEventListener('focus', () => {
      el.style.borderColor = '#a78bfa'; el.style.background = 'rgba(124,58,237,.18)';
    });
    el.addEventListener('input', e => {
      const val = e.target.value.replace(/\D/g, '');
      el.value = val ? val[0] : '';
      if (val && i < 5) document.getElementById(`vd${i+1}`)?.focus();
      clearVfyError();
      if (getCode().length === 6) setTimeout(submitCode, 100);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !el.value && i > 0)
        document.getElementById(`vd${i-1}`)?.focus();
      if (e.key === 'Enter') submitCode();
    });
    el.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData)
        .getData('text').replace(/\D/g, '').slice(0, 6);
      text.split('').forEach((ch, idx) => {
        const d = document.getElementById(`vd${idx}`);
        if (d) d.value = ch;
      });
      if (text.length > 0) document.getElementById(`vd${Math.min(text.length, 5)}`)?.focus();
      if (text.length === 6) setTimeout(submitCode, 100);
    });
  });

  async function submitCode() {
    const code = getCode();
    if (code.length !== 6) { showVfyError('Digite todos os 6 dígitos.'); return; }
    const btn = $('vfy-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }
    try {
      const res = await fetch(`${API_BASE}/auth/verify-email`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_vfyToken}` },
        body:    JSON.stringify({ email, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        [0,1,2,3,4,5].forEach(i => {
          const el = document.getElementById(`vd${i}`);
          if (el) { el.style.borderColor = '#4ade80'; el.style.background = 'rgba(74,222,128,.12)'; }
        });
        if (btn) { btn.textContent = '✓ Verificado!'; btn.style.background = 'linear-gradient(135deg,#16a34a,#4ade80)'; }
        setTimeout(() => {
          document.getElementById('verify-screen')?.remove();
          if (_vfyTimer) clearInterval(_vfyTimer);
          onSuccess(data.user || {}, data.token || null);
        }, 800);
      } else {
        showVfyError(apiErrorDetail(data.detail, 'Código inválido. Tente novamente.'));
        shakeInputs();
        if (btn) { btn.disabled = false; btn.textContent = 'Verificar conta'; }
      }
    } catch (_) {
      showVfyError('Erro de rede. Verifique sua conexão.');
      if (btn) { btn.disabled = false; btn.textContent = 'Verificar conta'; }
    }
  }

  $('vfy-btn')?.addEventListener('click', submitCode);

  $('vfy-resend-btn')?.addEventListener('click', async () => {
    const resendBtn = $('vfy-resend-btn');
    const countdown = $('vfy-countdown');
    try {
      if (resendBtn) resendBtn.style.display = 'none';
      if (countdown) { countdown.style.display = 'inline'; countdown.textContent = 'Enviando…'; }
      const res = await fetch(`${API_BASE}/auth/resend-verification`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${_vfyToken}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (countdown) countdown.textContent = apiErrorDetail(err.detail, 'Aguarde um momento.');
        setTimeout(() => {
          if (resendBtn) resendBtn.style.display = 'inline';
          if (countdown) countdown.style.display = 'none';
        }, 3000);
        return;
      }
      let secs = 60;
      if (_vfyTimer) clearInterval(_vfyTimer);
      _vfyTimer = setInterval(() => {
        secs--;
        if (countdown) countdown.textContent = `Reenviar em ${secs}s`;
        if (secs <= 0) {
          clearInterval(_vfyTimer);
          if (resendBtn) { resendBtn.style.display = 'inline'; resendBtn.textContent = 'Reenviar código'; }
          if (countdown) countdown.style.display = 'none';
        }
      }, 1000);
    } catch (_) {
      if (resendBtn) resendBtn.style.display = 'inline';
      if (countdown) countdown.style.display = 'none';
    }
  });

  $('vfy-back')?.addEventListener('click', () => {
    document.getElementById('verify-screen')?.remove();
    if (_vfyTimer) clearInterval(_vfyTimer);
    clearSession();
    showLoginScreen();
  });
}

// ════════════════════════════════════════════════════════════════
// PROFILE BAR
// ════════════════════════════════════════════════════════════════

function updateProfileBar() {
  const name = currentUser?.full_name || currentUser?.username || '—';
  const nameEl = $('profile-full-name') || $('shell-user-name');
  if (nameEl) nameEl.textContent = name;
  const avatarEl = $('profile-avatar') || $('shell-avatar');
  if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();
  const headerAvatar = $('profile-avatar-header');
  if (headerAvatar) headerAvatar.textContent = name.charAt(0).toUpperCase();

  const plan    = currentUser?.plan || 'free';
  const planEl  = $('profile-plan') || $('shell-plan-badge');
  if (planEl) {
    if (plan === 'tax_pro') {
      planEl.textContent = 'Tax Pro'; planEl.className = 'plan-badge tax-pro';
    } else if (plan === 'investor') {
      planEl.textContent = 'Investor'; planEl.className = 'plan-badge premium';
    } else {
      planEl.textContent = 'Free'; planEl.className = 'plan-badge';
    }
  }

  const countEl = $('profile-count');
  if (countEl) {
    countEl.textContent = isPremium()
      ? `${portfolioCount} assets`
      : `${portfolioCount}/${FREE_ASSET_LIMIT} assets`;
  }
  const upgradeBtn = $('btn-upgrade');
  if (upgradeBtn) upgradeBtn.style.display = isPremium() ? 'none' : '';

  // Proactive limit warning when one slot remains
  if (!isPremium() && portfolioCount === FREE_ASSET_LIMIT - 1) {
    if (!sessionStorage.getItem('purp_limit_warned')) {
      sessionStorage.setItem('purp_limit_warned', '1');
      setTimeout(() => {
        toast(
          `You have ${portfolioCount}/${FREE_ASSET_LIMIT} free assets — upgrade to Investor or Tax Pro for unlimited tracking.`,
          'warning',
          6500
        );
      }, 1200);
    }
  }

  const importCard = $('import-csv-card');
  if (importCard) importCard.style.display = isPremium() ? '' : 'none';

  updateTaxToolsVisibility();
  _renderAssetLimitBar();
}

function _renderAssetLimitBar() {
  const container = $('asset-limit-bar-container');
  if (!container) return;
  if (isPremium() || portfolioCount === 0) {
    container.innerHTML = '';
    return;
  }
  const pct = Math.min(100, (portfolioCount / FREE_ASSET_LIMIT) * 100);
  const isClose = portfolioCount >= FREE_ASSET_LIMIT - 1;
  container.innerHTML = `
    <div class="asset-limit-bar" style="${isClose ? 'border-color:rgba(245,158,11,0.4);background:rgba(245,158,11,0.09);' : ''}">
      <span style="flex-shrink:0;">${portfolioCount}/${FREE_ASSET_LIMIT} assets</span>
      <div class="asset-limit-bar__track">
        <div class="asset-limit-bar__fill" style="width:${pct}%;${isClose ? 'background:linear-gradient(90deg,#f59e0b,#ef4444);' : ''}"></div>
      </div>
      ${isClose ? '<span style="flex-shrink:0;font-size:10px;cursor:pointer;text-decoration:underline;" onclick="openUpgradeModal()">Upgrade</span>' : ''}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// SHELL NAVIGATION — sidebar drawer (mobile), links para páginas
// ════════════════════════════════════════════════════════════════

function initShellNav() {
  const hamburger = $('btn-hamburger');
  const sidebar   = $('sidebar');
  const overlay   = $('sidebar-overlay');

  function openSidebar() {
    sidebar?.classList.add('open');
    overlay?.classList.add('show');
    hamburger?.classList.add('open');
    hamburger?.setAttribute('aria-expanded', 'true');
  }
  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('show');
    hamburger?.classList.remove('open');
    hamburger?.setAttribute('aria-expanded', 'false');
  }

  hamburger?.addEventListener('click', () => {
    sidebar?.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  overlay?.addEventListener('click', closeSidebar);

  $('btn-privacy-toggle-mobile')?.addEventListener('click', () => {
    hideSensitiveValues = !hideSensitiveValues;
    updatePrivacyToggle();
  });
}

function closeMenu() {
  $('sidebar')?.classList.remove('open');
  $('sidebar-overlay')?.classList.remove('show');
  $('btn-hamburger')?.classList.remove('open');
  $('btn-hamburger')?.setAttribute('aria-expanded', 'false');
}

// ════════════════════════════════════════════════════════════════
// UPGRADE / FEATURE GATE MODALS
// ════════════════════════════════════════════════════════════════

function mountGateModal() {
  if ($('feature-gate-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'feature-gate-modal';
  modal.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;place-items:center;z-index:9990;padding:16px;';
  modal.innerHTML = `
    <div style="width:min(100%,420px);background:#110f20;border:1px solid rgba(255,255,255,.12);
      border-radius:14px;padding:20px;color:#f5f4ff;">
      <h3 id="gate-title" style="margin:0 0 8px;font-size:16px;">Upgrade necessário</h3>
      <p id="gate-msg" style="font-size:13px;color:rgba(255,255,255,.6);margin:0 0 16px;"></p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="gate-close" type="button" style="padding:10px;border-radius:10px;
          border:1px solid rgba(255,255,255,.18);background:transparent;color:#d9d6e8;cursor:pointer;">
          Agora não</button>
        <button id="gate-upgrade" type="button" style="padding:10px;border-radius:10px;border:0;
          background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:700;cursor:pointer;">
          Fazer upgrade</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) closeGateModal(); });
  $('gate-close')?.addEventListener('click', closeGateModal);
  $('gate-upgrade')?.addEventListener('click', () => {
    createCheckout(modal.dataset.plan || 'investor');
    closeGateModal();
  });
}

function showUpgradeModal(reason, plan = 'investor') {
  mountGateModal();
  const modal = $('feature-gate-modal');
  modal.dataset.plan = plan;
  const titleEl = $('gate-title');
  const msgEl   = $('gate-msg');
  if (titleEl) titleEl.textContent = plan === 'tax_pro' ? 'Tax Pro necessário' : 'Premium necessário';
  if (msgEl)   msgEl.textContent   = reason || 'Esta função requer um plano pago.';
  modal.style.display = 'grid';
}

function closeGateModal() {
  const modal = $('feature-gate-modal');
  if (modal) modal.style.display = 'none';
}

// Legacy compat
function hideUpgradeModal() { closeGateModal(); }
function showTaxProUpgradeModal() { showUpgradeModal('Esta função requer o plano Tax Pro.', 'tax_pro'); }
function hideTaxProUpgradeModal() { closeGateModal(); }

async function createCheckout(plan) {
  if (!authToken) { window.location.href = '/'; return; }
  const btn = $('btn-upgrade-confirm') || $('btn-taxpro-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Carregando…'; }
  try {
    const res = await apiFetch('/stripe/create-checkout', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ plan }),
    });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.checkout_url || data.url)) {
      window.open(data.checkout_url || data.url, '_blank');
    } else {
      toast(apiErrorDetail(data.detail, 'Could not open checkout.'), 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upgrade'; }
  }
}

async function handleUpgrade()       { await createCheckout('investor'); }
async function handleTaxProUpgrade() { await createCheckout('tax_pro'); }

function bindFeatureGates() {
  mountGateModal();
  qsa('[data-requires-plan]').forEach(el => {
    el.addEventListener('click', e => {
      const required = el.getAttribute('data-requires-plan');
      const allowed  = required === 'tax_pro' ? isTaxPro() : isPremium();
      if (allowed) return;
      e.preventDefault();
      showUpgradeModal(
        required === 'tax_pro'
          ? 'Esta função requer o plano Tax Pro.'
          : 'Esta função requer Investor ou Tax Pro.',
        required === 'tax_pro' ? 'tax_pro' : 'investor'
      );
    });
  });
}

function bindPlanButtons() {
  qsa('[data-checkout-plan]').forEach(btn => {
    btn.addEventListener('click', () => createCheckout(btn.getAttribute('data-checkout-plan')));
  });
}

// ════════════════════════════════════════════════════════════════
// PRIVACY TOGGLE
// ════════════════════════════════════════════════════════════════

function getEyeIconSvg(hidden) {
  return hidden
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12c.74-2.08 2.06-3.93 3.77-5.33"/><path d="M9.9 4.24A10.9 10.9 0 0 1 12 4c5 0 9.27 3.11 11 8a11.8 11.8 0 0 1-2.08 3.35"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function applyVisibilityMask() {
  qsa('.sensitive-value').forEach(el =>
    el.classList.toggle('is-hidden', hideSensitiveValues)
  );
}

function updatePrivacyToggle() {
  // Sincroniza os dois botões de privacidade (sidebar + mobile topbar)
  ['privacy-icon', 'privacy-icon-mobile'].forEach(id => {
    const icon = $(id);
    if (icon) icon.innerHTML = getEyeIconSvg(hideSensitiveValues);
  });
  applyVisibilityMask();
}

// ════════════════════════════════════════════════════════════════
// CHARTS
// ════════════════════════════════════════════════════════════════

async function loadMainChart(skipAnim = false) {
  if (!authToken) return;
  const ctx = $('mainChart')?.getContext('2d');
  if (!ctx) return;
  if (mainChart) { mainChart.destroy(); mainChart = null; }

  const period = qs('.pill.active')?.dataset.p || '1mo';
  const bench  = $('benchmark-select')?.value || '^GSPC';
  const res = await apiFetch(
    `/portfolio/history?period=${period}&benchmark=${encodeURIComponent(bench)}`,
    { headers: authHeaders() }
  );
  if (!res || !res.ok) return;
  const data = await res.json();
  if (!data.portfolio?.length) return;

  const s0 = data.portfolio[0], b0 = data.benchmark?.[0] || 1;
  const normP = data.portfolio.map(v => ((v - s0) / (s0 || 1)) * 100);
  const normB = (data.benchmark || []).map(v => ((v - b0) / (b0 || 1)) * 100);
  const benchChange = normB.length ? normB[normB.length - 1] : 0;

  const benchEl = $('benchmark-change');
  if (benchEl) {
    benchEl.textContent = `Benchmark: ${formatPct(benchChange)}`;
    benchEl.classList.toggle('pos', benchChange > 0);
    benchEl.classList.toggle('neg', benchChange < 0);
  }

  if (typeof Chart === 'undefined') return;
  mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dates,
      datasets: [
        { label: 'Portfólio', data: normP, borderColor: '#a78bfa', borderWidth: 2, pointRadius: 0, tension: 0.4 },
        { label: bench, data: normB, borderColor: '#444', borderWidth: 1, borderDash: [4,4], pointRadius: 0, tension: 0.4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: skipAnim ? false : { duration: 400 },
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
  applyVisibilityMask();
}

async function loadDetailChart(symbol, period) {
  const ctx = $('detailChart')?.getContext('2d');
  if (!ctx) return;
  if (detailChart) { detailChart.destroy(); detailChart = null; }

  const res = await apiFetch(`/history/${encodeURIComponent(symbol)}?period=${period}`);
  if (!res || !res.ok) return;
  const data = await res.json();
  if (!data.prices?.length) return;

  _detailSymbol = symbol;
  _detailPeriod = period;

  if (detailChartMode === 'candles') {
    const dates = data.dates || [];
    const prices = data.prices || [];
    const open  = [];
    const high  = [];
    const low   = [];
    const close = [...prices];
    for (let i = 0; i < prices.length; i++) {
      open.push(i === 0 ? prices[0] : prices[i - 1]);
      high.push(Math.max(open[i], close[i]));
      low.push(Math.min(open[i], close[i]));
    }
    const upColor   = 'rgba(16,185,129,0.9)';
    const downColor = 'rgba(239,68,68,0.9)';
    const wickColor = 'rgba(255,255,255,0.25)';
    const wicks    = dates.map((_, i) => [low[i], high[i]]);
    const bodyUpNarrow   = dates.map((_, i) => close[i] >= open[i] ? [open[i], close[i]] : null);
    const bodyDownNarrow = dates.map((_, i) => close[i] < open[i] ? [open[i], close[i]] : null);

    if (typeof Chart === 'undefined') return;
    detailChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: dates,
        datasets: [
          { label: 'Wick',  data: wicks, backgroundColor: wickColor, barThickness: 1, order: 1 },
          { label: 'Up',    data: bodyUpNarrow,   backgroundColor: upColor,   barThickness: 6, order: 2 },
          { label: 'Down',  data: bodyDownNarrow, backgroundColor: downColor, barThickness: 6, order: 3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { display: true, position: 'right', grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: 'rgba(255,255,255,0.3)', font: { family: 'DM Mono', size: 9 } } },
        },
      },
    });
    applyVisibilityMask();
    return;
  }

  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, 'rgba(124,58,237,0.4)');
  grad.addColorStop(1, 'rgba(124,58,237,0)');

  if (typeof Chart === 'undefined') return;
  detailChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dates || [],
      datasets: [{
        data: data.prices, borderColor: '#7c3aed', backgroundColor: grad,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, fill: true, tension: 0.4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: true, position: 'right', grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: 'rgba(255,255,255,0.3)', font: { family: 'DM Mono', size: 9 } } },
      },
    },
  });
  applyVisibilityMask();
}

function renderSpark(canvasId, data, color) {
  const ctx = $(canvasId)?.getContext('2d');
  if (!ctx || !data?.length || typeof Chart === 'undefined') return;
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{ data, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: false }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
}

// ════════════════════════════════════════════════════════════════
// PORTFOLIO SCORE
// ════════════════════════════════════════════════════════════════

async function loadPortfolioScore() {
  if (!authToken) return;
  const res = await apiFetch('/portfolio/score', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const score = await res.json();

  const overall = Number(score.overall || 0);
  const dash    = 283 - (Math.max(0, Math.min(100, overall)) / 100) * 283;

  const overallEl = $('score-overall');
  if (overallEl) overallEl.textContent = `${overall}`;
  const gradeEl = $('score-grade');
  if (gradeEl) gradeEl.textContent = score.grade || '—';
  const gaugeEl = $('score-gauge-value');
  if (gaugeEl) gaugeEl.style.strokeDashoffset = `${dash}`;

  const setBar = (id, val, labelId) => {
    const v = Number(val || 0);
    if ($(id)) $(id).style.width = `${Math.max(0, Math.min(100, v))}%`;
    if ($(labelId)) $(labelId).textContent = `${Math.round(v)}`;
  };
  setBar('bar-diversification', score.diversification, 'score-diversification');
  setBar('bar-risk',            score.risk_adjusted,    'score-risk');
  setBar('bar-consistency',     score.consistency,      'score-consistency');

  if (score.tax_efficiency == null) {
    if ($('bar-tax'))   $('bar-tax').style.width = '0%';
    if ($('score-tax')) $('score-tax').textContent = '—';
  } else {
    setBar('bar-tax', score.tax_efficiency, 'score-tax');
  }

  const insightsEl = $('score-insights');
  if (insightsEl) {
    const items = Array.isArray(score.insights) ? score.insights : [];
    insightsEl.innerHTML = items.length
      ? items.map(txt => `<li>${txt}</li>`).join('')
      : '<li>Seu portfólio está estável. Continue monitorando diversificação e consistência.</li>';
  }
  const labelEl = $('score-label');
  if (labelEl) {
    const g = (score.grade || '').toUpperCase();
    labelEl.textContent = { A: 'Excellent', B: 'Good', C: 'Fair', D: 'Poor' }[g] || g || '—';
  }
  if ($('score-risk-level')) $('score-risk-level').textContent = 'Moderate';
  const change30El = $('score-change-30d');
  if (change30El) {
    apiFetch('/portfolio/history?period=1mo', { headers: authHeaders() }).then(r => {
      if (!r || !r.ok) return r;
      return r.json().then(d => {
        const p = d.portfolio || [];
        if (p.length >= 2 && p[0]) {
          const ch = ((p[p.length - 1] - p[0]) / p[0]) * 100;
          change30El.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(1) + '%';
          change30El.className = 'score-change-30d ' + (ch >= 0 ? 'text-green' : 'text-red');
        }
        return r;
      });
    }).catch(() => {});
  }
}

let allocationDonutChart = null;
function buildAllocationDonut(balanceData) {
  const canvas = $('allocationDonutChart');
  const legendEl = $('allocation-legend');
  if (!canvas || typeof Chart === 'undefined') return;
  const assets = balanceData.assets || [];
  let stocks = 0, crypto = 0, cash = 0;
  assets.forEach(a => {
    const val = parseFloat(a.position_value) || 0;
    const t = (a.type || '').toLowerCase();
    if (t === 'crypto') crypto += val; else if (t === 'cash') cash += val; else stocks += val;
  });
  const total = stocks + crypto + cash || 1;
  const data = [
    { label: 'Stocks', value: (stocks / total) * 100, color: '#7B3FE4' },
    { label: 'Crypto', value: (crypto / total) * 100, color: '#14b8a6' },
    { label: 'Cash', value: (cash / total) * 100, color: 'rgba(255,255,255,0.25)' },
  ].filter(d => d.value > 0);
  if (allocationDonutChart) allocationDonutChart.destroy();
  if (legendEl) legendEl.innerHTML = data.length ? data.map(d => `<span style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${d.color};"></span>${d.label} ${d.value.toFixed(0)}%</span>`).join('') : '';
  if (!data.length) return;
  allocationDonutChart = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: data.map(d => d.label),
      datasets: [{ data: data.map(d => d.value), backgroundColor: data.map(d => d.color), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: true, cutout: '65%', plugins: { legend: { display: false } } },
  });
}
function buildPortfolioOverviewList(assets) {
  const list = $('portfolio-overview-list');
  if (!list) return;
  if (!assets || !assets.length) {
    list.innerHTML = '<div class="empty-sub" style="padding:8px 0;">No assets yet.</div>';
    return;
  }
  list.innerHTML = assets.slice(0, 5).map(a => {
    const pct = a.percent_change != null ? (a.percent_change >= 0 ? '+' : '') + a.percent_change.toFixed(2) + '%' : '—';
    const isUp = (a.percent_change || 0) >= 0;
    const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div class="overview-item"><span class="sym">${esc(a.symbol)}</span><span class="price sensitive-value">${formatUSD(a.current_price)}</span><span class="pct ${isUp ? 'text-green' : 'text-red'}">${pct}</span></div>`;
  }).join('');
  applyVisibilityMask();
}
async function loadRelevantNews() {
  const list = $('relevant-news-list');
  if (!list) return;
  try {
    const res = await apiFetch('/news?limit=6');
    const data = await res?.json?.() || {};
    const news = data.news || [];
    if (!news.length) { list.innerHTML = '<div class="news-loading">No news available.</div>'; return; }
    const escapeHtml = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    list.innerHTML = news.map(n => {
      const sym = (n.symbols || [])[0] || '';
      const url = (n.url || '#').trim();
      const safeUrl = url.startsWith('http://') || url.startsWith('https://') ? url : '#';
      const title = escapeHtml((n.headline || '').slice(0, 60)) + ((n.headline || '').length > 60 ? '…' : '');
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="news-item"><span class="news-item-icon">${escapeHtml(sym) || 'N'}</span><span class="news-item-title">${title}</span><span class="news-item-arrow">→</span></a>`;
    }).join('');
  } catch (e) { list.innerHTML = '<div class="news-loading">Could not load news.</div>'; }
}
async function loadWatchlistCards() {
  const container = $('watchlist-cards');
  if (!container || !authToken) return;
  const res = await apiFetch('/watchlist', { headers: authHeaders() });
  if (!res || !res.ok) { container.innerHTML = '<div class="empty-sub">Could not load watchlist.</div>'; return; }
  const items = (await res.json()).items || [];
  watchlistSymbols = new Set(items.map(i => (i.symbol || '').toUpperCase()));
  items.forEach(i => { watchlistIdBySymbol[(i.symbol || '').toUpperCase()] = i.id; });
  if (!items.length) { container.innerHTML = '<div class="empty-sub">Add assets from Market or search to track them here.</div>'; return; }
  container.innerHTML = '';
  for (const w of items.slice(0, 8)) {
    const sym = (w.symbol || '').toUpperCase();
    const snapRes = await apiFetch('/snapshot/' + encodeURIComponent(sym));
    const d = snapRes?.ok ? await snapRes.json() : null;
    const price = d?.current_price ?? w.current_price ?? 0;
    const pct = d?.percent_change ?? w.percent_change ?? 0;
    const history = d?.history || [];
    const isUp = pct >= 0;
    const iconPath = d?.icon || '/logo/' + sym;
    const logoUrl = (iconPath && iconPath.startsWith('http')) ? iconPath : (API_BASE + (iconPath.startsWith('/') ? iconPath : '/logo/' + sym));
    const card = document.createElement('div');
    card.className = 'watchlist-card';
    card.dataset.symbol = sym;
    card.innerHTML = '<div class="watchlist-card-logo"><img src="' + logoUrl + '" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'block\';this.nextElementSibling.textContent=\'' + sym.slice(0,2) + '\';"><span style="display:none;font-size:11px;"></span></div><div class="watchlist-card-info"><div class="watchlist-card-ticker">' + sym + '</div><div class="watchlist-card-price sensitive-value">' + formatUSD(price) + '</div><div class="watchlist-card-pct ' + (isUp ? 'text-green' : 'text-red') + '">' + (pct >= 0 ? '+' : '') + (pct || 0).toFixed(2) + '%</div></div><div class="watchlist-card-spark"><canvas id="watch-spark-' + sym + '"></canvas></div>';
    card.addEventListener('click', () => openDetailFromSymbol(sym));
    container.appendChild(card);
    if (history.length && typeof Chart !== 'undefined') setTimeout(() => renderSpark('watch-spark-' + sym, history, isUp ? '#10b981' : '#ef4444'), 50);
  }
  applyVisibilityMask();
}
async function loadMarketAnalysisForSymbol(symbol) {
  const placeholder = $('market-analysis-placeholder');
  const content = $('market-analysis-content');
  const symEl = $('market-analysis-symbol');
  const priceEl = $('market-analysis-price');
  const textEl = $('market-analysis-text');
  if (!content || !symEl) return;
  if (placeholder) placeholder.style.display = 'none';
  content.style.display = 'block';
  symEl.textContent = symbol || '—';
  if (priceEl) { priceEl.textContent = '—'; priceEl.className = 'market-analysis-price'; }
  if (textEl) textEl.textContent = 'Loading…';
  const snapRes = await apiFetch('/snapshot/' + encodeURIComponent(symbol));
  const snap = snapRes?.ok ? await snapRes.json() : null;
  if (snap && snap.current_price != null && priceEl) {
    priceEl.textContent = formatUSD(snap.current_price);
    priceEl.classList.add((snap.percent_change || 0) >= 0 ? 'text-green' : 'text-red');
  }
  const analysisRes = await apiFetch('/analysis/' + encodeURIComponent(symbol) + '?change=' + (snap?.percent_change || 0), { headers: authHeaders() });
  const analysis = analysisRes?.ok ? await analysisRes.json() : null;
  if (textEl) textEl.textContent = analysis?.analysis || 'No AI analysis available for this asset.';
  const btn = $('btn-market-analysis-register');
  if (btn) btn.onclick = () => { window.location.href = '/home/add-asset'; };
}
async function loadTopMovers() {
  const list = $('top-movers-list');
  if (!list) return;
  try {
    const res = await apiFetch('/movers');
    const data = await res?.json?.() || {};
    const all = data.all || (data.gainers || []).concat(data.losers || []);
    if (!all.length) { list.innerHTML = '<div class="movers-loading">No movers data.</div>'; return; }
    const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    list.innerHTML = '';
    all.slice(0, 8).forEach(m => {
      const pct = m.percent_change ?? 0;
      const isUp = pct >= 0;
      const div = document.createElement('div');
      div.className = 'movers-item';
      div.setAttribute('role', 'button');
      div.tabIndex = 0;
      div.innerHTML = '<span class="sym">' + esc(m.symbol) + '</span><span class="pct ' + (isUp ? 'text-green' : 'text-red') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
      div.addEventListener('click', () => openDetailFromSymbol(m.symbol));
      div.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetailFromSymbol(m.symbol); } });
      list.appendChild(div);
    });
  } catch (e) { list.innerHTML = '<div class="movers-loading">Could not load movers.</div>'; }
}
async function loadFearGreed() {
  const valEl = $('fear-greed-value');
  const labelEl = $('fear-greed-label');
  const needleEl = $('fear-greed-needle');
  if (!valEl) return;
  try {
    const res = await apiFetch('/fear-greed');
    const data = await res?.json?.() || {};
    const v = Math.max(0, Math.min(100, Number(data.value) || 50));
    valEl.textContent = v;
    if (labelEl) labelEl.textContent = data.classification || 'Neutral';
    if (needleEl) needleEl.style.transform = 'translate(-50%, -100%) rotate(' + (-90 + (v / 100) * 180) + 'deg)';
  } catch (e) { valEl.textContent = '—'; if (labelEl) labelEl.textContent = '—'; }
}

let globalSearchTimer = null;
async function performGlobalSearch(q) {
  const box = $('search-autocomplete');
  if (!q || q.length < 1) {
    if (box) { box.setAttribute('aria-hidden', 'true'); box.innerHTML = ''; }
    return;
  }
  try {
    const res = await apiFetch('/search?q=' + encodeURIComponent(q));
    if (!res || !res.ok) { if (box) box.setAttribute('aria-hidden', 'true'); return; }
    const results = await res.json();
    if (!box) return;
    box.innerHTML = '';
    if (!results.length) { box.setAttribute('aria-hidden', 'true'); return; }
    results.slice(0, 10).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'autocomplete-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const esc = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      row.innerHTML = '<span class="autocomplete-sym">' + esc(item.symbol) + '</span><span class="autocomplete-name">' + esc(item.name || item.symbol || '') + '</span>';
      row.addEventListener('click', () => {
        const sym = (item.symbol || '').toUpperCase();
        if ($('global-search')) $('global-search').value = sym;
        box.setAttribute('aria-hidden', 'true');
        openDetailFromSymbol(sym);
      });
      box.appendChild(row);
    });
    box.setAttribute('aria-hidden', 'false');
  } catch (e) { if (box) box.setAttribute('aria-hidden', 'true'); }
}

// ════════════════════════════════════════════════════════════════
// PORTFOLIO — balance + assets list
// ════════════════════════════════════════════════════════════════

function _renderAssetSkeletons(count = 3) {
  const list = $('assets-list');
  if (!list) return;
  list.innerHTML = Array.from({ length: count }, () => `
    <div class="skeleton-asset-row">
      <div class="skeleton skeleton-avatar"></div>
      <div class="skeleton-asset-info">
        <div class="skeleton skeleton-text" style="width:80px;"></div>
        <div class="skeleton skeleton-text" style="width:56px;margin-top:4px;"></div>
      </div>
      <div class="skeleton-asset-right">
        <div class="skeleton skeleton-text" style="width:72px;"></div>
        <div class="skeleton skeleton-text" style="width:48px;margin-top:4px;"></div>
      </div>
    </div>`).join('');
}

function _renderBalanceSkeleton() {
  const el = $('total-balance');
  if (el) el.innerHTML = '<span class="skeleton skeleton-title" style="width:160px;display:inline-block;"></span>';
  const premiumEl = $('portfolio-total-balance');
  if (premiumEl) premiumEl.innerHTML = '<span class="skeleton skeleton-title" style="width:100px;display:inline-block;"></span>';
}

async function fetchPortfolio() {
  if (!authToken) return;
  _renderBalanceSkeleton();
  _renderAssetSkeletons(3);
  const res = await apiFetch('/portfolio/balance', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const data = await res.json();

  const balanceEl = $('total-balance');
  if (balanceEl) {
    balanceEl.textContent = formatUSD(data.total_balance_usd);
    balanceEl.classList.add('sensitive-value');
  }
  const premiumBalance = $('portfolio-total-balance');
  if (premiumBalance) {
    premiumBalance.textContent = formatUSD(data.total_balance_usd);
    premiumBalance.classList.add('sensitive-value');
  }
  const summaryEl = $('portfolio-summary');
  if (summaryEl) {
    const n = (data.assets || []).length;
    summaryEl.textContent = n === 0 ? 'No assets' : `${n} asset${n !== 1 ? 's' : ''}`;
  }

  portfolioCount   = (data.assets || []).length;
  portfolioSymbols = new Set((data.assets || []).map(a => (a.real_symbol || a.symbol || '').toUpperCase()));
  updateProfileBar();
  await loadPortfolioScore();
  await loadNetWorth();
  _checkConcentrationAlert();

  if ($('allocationDonutChart')) buildAllocationDonut(data);
  if ($('portfolio-overview-list')) buildPortfolioOverviewList(data.assets || []);

  const list = $('assets-list');
  if (!list) {
    renderRebalanceTargets(data.assets || []);
    if (data.assets?.length) await loadBalancePerformance();
    if ($('watchlist-cards')) loadWatchlistCards();
    if ($('relevant-news-list')) loadRelevantNews();
    if ($('top-movers-list')) loadTopMovers();
    if ($('fear-greed-value')) loadFearGreed();
    return;
  }
  list.innerHTML = '';

  if (!data.assets?.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <h3 class="empty-state__title">Your portfolio is empty</h3>
        <p class="empty-state__body">Add your first asset to start tracking performance, get AI insights, and stay on top of your wealth.</p>
        <button class="btn primary" onclick="switchTab('add-asset')" style="margin-top:4px;gap:6px;">
          <span>+</span> Add your first asset
        </button>
      </div>`;
    return;
  }

  _renderAssetLimitBar();

  renderRebalanceTargets(data.assets || []);
  await loadBalancePerformance();

  data.assets.forEach(asset => {
    const profit   = asset.profit ?? 0;
    const isProfit = profit >= 0;
    const pctTxt   = asset.percent_change != null
      ? `${asset.percent_change >= 0 ? '+' : ''}${asset.percent_change.toFixed(2)}%` : '';
    const sym2 = (asset.symbol || '').substring(0, 2).toUpperCase();
    const iconSrc = assetIconUrl(asset.icon, asset.symbol);
    const iconHtml = iconSrc
      ? `<img class="asset-icon-img" src="${iconSrc}" alt="${asset.symbol}"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="asset-icon-fb" style="display:none;">${sym2}</div>`
      : `<div class="asset-icon-fb">${sym2}</div>`;

    const wrapper = document.createElement('div');
    wrapper.className = 'asset-wrapper';
    wrapper.innerHTML = `
      <div class="asset-main">
        <div class="asset-left">
          <div class="asset-icon-wrap">${iconHtml}</div>
          <div>
            <div class="asset-name">${asset.symbol}</div>
            <div class="asset-price">
              <span class="sensitive-value">${formatUSD(asset.current_price)}</span>
              <span class="${isProfit ? 'text-green' : 'text-red'}">${pctTxt}</span>
            </div>
          </div>
        </div>
        <div class="asset-spark"><canvas id="spark-${asset.id}"></canvas></div>
        <div class="asset-values">
          <div class="asset-val sensitive-value">${formatUSD(asset.position_value)}</div>
          <div class="asset-profit sensitive-value ${isProfit ? 'text-green' : 'text-red'}">
            ${isProfit ? '+' : ''}${formatUSD(profit)}
          </div>
        </div>
      </div>
      <div class="action-bar">
        <button class="action-btn ai"   data-id="${asset.id}">✨ AI Analysis</button>
        <button class="action-btn sell" data-id="${asset.id}">Sell</button>
      </div>
      <div class="ai-result" id="ai-res-${asset.id}"></div>`;

    wrapper.querySelector('.asset-main').addEventListener('click', () => openDetail(asset));
    wrapper.querySelector('.action-btn.sell').addEventListener('click', e => {
      e.stopPropagation(); openSellModal(asset);
    });
    wrapper.querySelector('.action-btn.ai').addEventListener('click', e => {
      e.stopPropagation(); requestAssetAI(asset);
    });
    list.appendChild(wrapper);
    renderSpark(`spark-${asset.id}`, asset.history || [], isProfit ? '#10b981' : '#ef4444');
  });

  applyVisibilityMask();
  loadDividendCard();
  loadAlerts();
  if ($('watchlist-cards')) loadWatchlistCards();
  if ($('relevant-news-list')) loadRelevantNews();
  if ($('top-movers-list')) loadTopMovers();
  if ($('fear-greed-value')) loadFearGreed();
}

// ── Concentration alert banner ────────────────────────────────────
async function _checkConcentrationAlert() {
  if (!authToken) return;
  try {
    const res = await apiFetch('/portfolio/concentration-alert', { headers: authHeaders() });
    if (!res || !res.ok) return;
    const data = await res.json();

    // Remove existing banner if any
    const existing = document.getElementById('concentration-banner');
    if (existing) existing.remove();

    if (!data.concentrated) return;

    const list = $('assets-list');
    if (!list) return;

    const banner = document.createElement('div');
    banner.id = 'concentration-banner';
    banner.className = 'concentration-banner';
    banner.innerHTML = `
      <div class="concentration-banner__icon">⚠️</div>
      <div class="concentration-banner__body">
        <div class="concentration-banner__title">
          High Concentration — ${data.symbol} is ${data.pct}% of your portfolio
        </div>
        <div class="concentration-banner__text">
          ${data.ai_message || 'Concentrating more than 50% in a single asset significantly increases portfolio risk. Consider diversifying across different assets and sectors.'}
        </div>
      </div>`;
    list.parentNode.insertBefore(banner, list);
  } catch (e) {
    console.warn('concentration-alert:', e);
  }
}

// ── Balance performance pills ─────────────────────────────────────
async function loadBalancePerformance() {
  if (!authToken) return;
  const periods = ['1mo', '3mo', '6mo', '1y'];
  const updates = await Promise.all(periods.map(async period => {
    const res = await apiFetch(
      `/portfolio/history?period=${period}&benchmark=%5EGSPC`,
      { headers: authHeaders() }
    );
    if (!res || !res.ok) return { period, value: null };
    const data  = await res.json();
    const prices = data.portfolio || [];
    if (prices.length < 2 || !prices[0]) return { period, value: 0 };
    return { period, value: ((prices[prices.length-1] - prices[0]) / prices[0]) * 100 };
  }));

  updates.forEach(({ period, value }) => {
    const pill  = qs(`.perf-pill[data-period="${period}"]`); if (!pill) return;
    const label = period === '1mo' ? '1M' : period === '3mo' ? '3M' : period === '6mo' ? '6M' : '1Y';
    if (value == null || Number.isNaN(value)) {
      pill.textContent = `${label}: —`; pill.classList.remove('pos','neg'); return;
    }
    pill.textContent = `${label}: ${formatPct(value)}`;
    pill.classList.toggle('pos', value > 0);
    pill.classList.toggle('neg', value < 0);
  });
  applyVisibilityMask();
}

// ════════════════════════════════════════════════════════════════
// DETAIL VIEW
// ════════════════════════════════════════════════════════════════

function openDetail(asset) {
  const view = $('detail-view'); if (!view) return;
  view.classList.add('active');

  if ($('detail-symbol')) $('detail-symbol').textContent = asset.symbol;
  const priceEl = $('detail-price');
  if (priceEl) { priceEl.textContent = formatUSD(asset.current_price); priceEl.classList.add('sensitive-value'); }
  if ($('holding-badge')) { $('holding-badge').textContent = `${asset.days_held ?? 0} dias em carteira`; $('holding-badge').style.display = ''; }
  const guestActions = $('detail-actions-guest'); if (guestActions) guestActions.style.display = 'none';

  const imgEl = $('detail-icon-img'), fbEl = $('detail-icon-fb');
  if (fbEl) fbEl.textContent = (asset.symbol || '').substring(0, 2).toUpperCase();
  const iconSrc = assetIconUrl(asset.icon, asset.symbol);
  if (imgEl && iconSrc) {
    imgEl.src = iconSrc; imgEl.style.display = 'block';
    if (fbEl) fbEl.style.display = 'none';
    imgEl.onerror = () => { imgEl.style.display = 'none'; if (fbEl) fbEl.style.display = 'flex'; };
  } else {
    if (imgEl) imgEl.style.display = 'none';
    if (fbEl) fbEl.style.display = 'flex';
  }

  detailChartMode = 'line';
  qsa('.chart-type-btn').forEach(b => { b.classList.remove('active'); if (b.dataset.type === 'line') b.classList.add('active'); });
  qsa('.time-btn').forEach(b => b.classList.remove('active'));
  qs('.time-btn[data-period="1mo"]')?.classList.add('active');
  _detailPeriod = '1mo';
  loadDetailChart(asset.real_symbol || asset.symbol, '1mo');
  loadDetailNews(asset.symbol);
  loadDetailAI(asset.symbol, asset.percent_change);
}

let _detailSymbolForGuest = null;
let _detailLastChange = 0;

async function loadDetailNews(symbol) {
  const list = $('detail-news-list'); if (!list) return;
  list.innerHTML = 'Carregando…';
  try {
    const res = await apiFetch('/news?symbols=' + encodeURIComponent(symbol || '') + '&limit=8');
    const data = res?.ok ? await res.json() : {};
    const news = data.news || [];
    if (!news.length) { list.innerHTML = 'Nenhuma notícia recente para este ativo.'; return; }
    const escapeHtml = (s) => (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    list.innerHTML = news.map(n => {
      const url = (n.url || '#').trim();
      const safeUrl = url.startsWith('http') ? url : '#';
      const title = escapeHtml((n.headline || n.title || '').slice(0, 80)) + ((n.headline || n.title || '').length > 80 ? '…' : '');
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="news-item">${title}</a>`;
    }).join('');
  } catch (e) { list.innerHTML = 'Não foi possível carregar notícias.'; }
}

async function loadDetailAI(symbol, change) {
  const el = $('detail-ai-text'); if (!el) return;
  el.textContent = 'Carregando…';
  try {
    const res = await apiFetch('/analysis/' + encodeURIComponent(symbol || '') + '?change=' + (change ?? 0), { headers: authHeaders() });
    const data = res?.ok ? await res.json() : {};
    el.textContent = data.analysis || 'Insight AI indisponível para este ativo.';
  } catch (e) { el.textContent = 'Não foi possível carregar o insight AI.'; }
}

async function openDetailFromSymbol(symbol) {
  const view = $('detail-view'); if (!view) return;
  const sym = (symbol || '').toUpperCase().trim();
  if (!sym) return;

  view.classList.add('active');
  _detailSymbolForGuest = sym;

  if ($('detail-symbol')) $('detail-symbol').textContent = sym;
  if ($('detail-price')) { $('detail-price').textContent = '—'; $('detail-price').className = 'detail-price'; }
  if ($('holding-badge')) { $('holding-badge').textContent = '—'; $('holding-badge').style.display = 'none'; }
  const guestActions = $('detail-actions-guest'); if (guestActions) guestActions.style.display = 'flex';

  const imgEl = $('detail-icon-img'), fbEl = $('detail-icon-fb');
  if (fbEl) fbEl.textContent = sym.substring(0, 2);
  if (imgEl) { imgEl.style.display = 'none'; if (fbEl) fbEl.style.display = 'flex'; }
  const iconSrc = assetIconUrl('/logo/' + sym, sym);
  if (iconSrc && imgEl) { imgEl.src = iconSrc; imgEl.style.display = 'block'; if (fbEl) fbEl.style.display = 'none'; imgEl.onerror = () => { imgEl.style.display = 'none'; if (fbEl) fbEl.style.display = 'flex'; }; }

  $('detail-news-list').innerHTML = 'Carregando…';
  $('detail-ai-text').textContent = 'Carregando…';

  detailChartMode = 'line';
  qsa('.chart-type-btn').forEach(b => { b.classList.remove('active'); if (b.dataset.type === 'line') b.classList.add('active'); });
  qsa('.time-btn').forEach(b => b.classList.remove('active'));
  qs('.time-btn[data-period="1mo"]')?.classList.add('active');
  _detailPeriod = '1mo';
  loadDetailChart(sym, '1mo');

  const snapRes = await apiFetch('/snapshot/' + encodeURIComponent(sym));
  const snap = snapRes?.ok ? await snapRes.json() : null;
  _detailLastChange = snap?.percent_change ?? 0;
  if (snap && snap.current_price != null && $('detail-price')) {
    $('detail-price').textContent = formatUSD(snap.current_price);
    $('detail-price').classList.add('sensitive-value');
    if ((snap.percent_change || 0) >= 0) $('detail-price').classList.add('text-green'); else $('detail-price').classList.add('text-red');
  }
  loadDetailNews(sym);
  loadDetailAI(sym, _detailLastChange);
}

// ════════════════════════════════════════════════════════════════
// SELL MODAL
// ════════════════════════════════════════════════════════════════

function openSellModal(asset) {
  assetForSale = asset;
  const qty = $('sell-qty'); if (!qty) return;
  qty.value = asset.amount; qty.max = asset.amount;
  qty.step  = (asset.type || '').toLowerCase() === 'stock' ? '1' : 'any';
  if ($('sell-info'))
    $('sell-info').textContent = `Em carteira: ${asset.amount}  •  Preço médio: ${formatUSD(asset.purchase_price)}`;
  updateSellEstimate();
  $('modal-sell')?.classList.add('active');
}

function closeSellModal() {
  $('modal-sell')?.classList.remove('active');
  assetForSale = null;
}

function updateSellEstimate() {
  if (!assetForSale) return;
  let qty = parseFloat($('sell-qty')?.value) || 0;
  if (qty > assetForSale.amount) { qty = assetForSale.amount; if ($('sell-qty')) $('sell-qty').value = qty; }
  if (qty < 0) qty = 0;
  const total = qty * assetForSale.current_price;
  const pnl   = (assetForSale.current_price - assetForSale.purchase_price) * qty;
  const isWin = pnl >= 0;
  const estEl = $('sell-estimate');
  if (estEl) {
    estEl.innerHTML = `
      <span class="sensitive-value">${formatUSD(total)}</span><br>
      <span class="${isWin ? 'text-green' : 'text-red'}" style="font-size:13px;">
        ${isWin ? '+' : ''}${formatUSD(pnl)}
      </span>`;
  }
  applyVisibilityMask();
}

async function confirmSell() {
  if (!assetForSale || !authToken) return;
  const qty = parseFloat($('sell-qty')?.value);
  if (!qty || qty <= 0) { toast('Insira uma quantidade válida para vender.', 'warning'); return; }
  if ((assetForSale.type || '').toLowerCase() === 'stock' && !Number.isInteger(qty)) {
    toast('Para ações, a quantidade deve ser um número inteiro.', 'warning'); return;
  }
  const btn = $('btn-sell-confirm'); if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await apiFetch(`/assets/${assetForSale.id}/sell`, {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ amount: qty }),
    });
    if (!res) return;
    if (res.ok) {
      const data = await res.json();
      const pnl  = data.pnl ?? 0;
      toast(`Venda realizada! P&L: ${pnl >= 0 ? '+' : ''}${formatUSD(pnl)}`, pnl >= 0 ? 'success' : 'info');
      closeSellModal(); fetchPortfolio(); loadMainChart();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(apiErrorDetail(err.detail, 'Falha ao vender. Tente novamente.'), 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmar venda'; }
  }
}

// ════════════════════════════════════════════════════════════════
// ADD ASSET
// ════════════════════════════════════════════════════════════════

async function handleAddAsset() {
  if (!authToken) { window.location.href = '/'; return; }
  const sym    = $('symbol-input')?.value.trim().toUpperCase() || '';
  const amount = parseFloat($('amount-input')?.value);
  const price  = parseFloat($('price-input')?.value);
  const date   = $('date-input')?.value || null;

  if (!sym)               { toast('Insira o símbolo do ativo.', 'warning');    return; }
  if (!amount || amount <= 0) { toast('Insira uma quantidade válida.', 'warning'); return; }
  if (!price  || price  <= 0) { toast('Insira um preço válido.', 'warning');    return; }

  const resolvedType = selectedAddAssetType || await resolveSymbolType(sym);
  if (resolvedType === 'stock' && !Number.isInteger(amount)) {
    toast('Para ações, a quantidade deve ser um número inteiro.', 'warning'); return;
  }

  const isExisting = portfolioSymbols.has(sym);
  if (!isPremium() && portfolioCount >= FREE_ASSET_LIMIT && !isExisting) {
    showUpgradeModal(`O plano gratuito é limitado a ${FREE_ASSET_LIMIT} ativos.`); return;
  }

  const btn = $('btn-save-asset');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }

  try {
    const res = await apiFetch('/assets/', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ symbol: sym, amount, purchase_price: price, purchase_date: date }),
    });
    if (!res) return;
    if (res.ok) {
      if ($('symbol-input')) $('symbol-input').value = '';
      if ($('amount-input')) $('amount-input').value = '';
      if ($('price-input'))  $('price-input').value  = '';
      if ($('date-input'))   $('date-input').value   = '';
      selectedAddAssetType = null;
      setAddAmountInputMode(null);
      if ($('search-dropdown')) $('search-dropdown').style.display = 'none';
      switchTab('dashboard');
      await fetchPortfolio(); loadMainChart();
      toast(`${sym} adicionado ao portfólio ✓`, 'success');
    } else if (res.status === 402) {
      const err = await res.json().catch(() => ({}));
      showUpgradeModal(apiErrorDetail(err.detail, 'Faça upgrade para adicionar mais ativos.'));
    } else if (res.status === 404) {
      toast(`Ativo '${sym}' não encontrado.`, 'error');
    } else {
      const err = await res.json().catch(() => ({}));
      toast(apiErrorDetail(err.detail, 'Falha ao adicionar ativo.'), 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar Ativo'; }
  }
}

// ── Search ───────────────────────────────────────────────────────
async function performSearch(q) {
  const box = $('search-dropdown');
  if (!q || q.length < 2) { if (box) box.style.display = 'none'; return; }
  try {
    const res = await apiFetch(`/search?q=${encodeURIComponent(q)}`);
    if (!res || !res.ok) { if (box) box.style.display = 'none'; return; }
    const results = await res.json();
    if (!box) return;
    box.innerHTML = '';
    if (!results.length) { box.style.display = 'none'; return; }
    results.forEach(item => {
      const sym2 = (item.symbol || '').substring(0, 2).toUpperCase();
      const iconSrc = assetIconUrl(item.icon, item.symbol);
      const iconHtml = iconSrc
        ? `<img class="search-item-icon" src="${iconSrc}" alt="${item.symbol}"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="search-item-fb" style="display:none;">${sym2}</div>`
        : `<div class="search-item-fb">${sym2}</div>`;
      const row = document.createElement('div');
      row.className = 'search-item';
      row.innerHTML = `${iconHtml}
        <span class="search-item-name">${item.symbol}</span>
        <span class="search-item-sub">${item.name || ''}</span>
        <span class="search-tag">${item.type || ''}</span>
        <button type="button" class="search-item-detalhes" aria-label="Ver detalhes">Detalhes</button>`;
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('search-item-detalhes')) {
          e.preventDefault(); e.stopPropagation();
          openDetailFromSymbol(item.symbol);
          box.style.display = 'none';
          return;
        }
        if ($('symbol-input')) $('symbol-input').value = item.symbol;
        selectedAddAssetType =
          (item.type || '').toUpperCase().includes('CRYPTO') ? 'crypto' : 'stock';
        setAddAmountInputMode(selectedAddAssetType);
        box.style.display = 'none';
      });
      box.appendChild(row);
    });
    box.style.display = 'block';
  } catch (e) { if (box) box.style.display = 'none'; }
}

function setAddAmountInputMode(type) {
  const input = $('amount-input'); if (!input) return;
  const isStock = (type || '').toLowerCase() === 'stock';
  input.step = isStock ? '1' : 'any';
  input.placeholder = isStock ? '1' : '0.5';
}

async function resolveSymbolType(symbol) {
  const sym = (symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const res = await apiFetch(`/search?q=${encodeURIComponent(sym)}`);
  if (!res || !res.ok) return null;
  const results = await res.json();
  const exact   = results.find(r => (r.symbol || '').toUpperCase() === sym);
  const t       = (exact?.type || '').toUpperCase();
  if (t.includes('CRYPTO')) return 'crypto';
  if (t.includes('STOCK') || t.includes('EQUITY') || t.includes('ETF') || t.includes('INDEX')) return 'stock';
  return null;
}

// ════════════════════════════════════════════════════════════════
// MARKET WATCH
// ════════════════════════════════════════════════════════════════

async function fetchQuoteForSymbol(symbol) {
  const res = await apiFetch(`/history/${encodeURIComponent(symbol)}?period=1d`);
  if (!res || !res.ok) return null;
  const data   = await res.json();
  const prices = data.prices || [];
  if (!prices.length) return null;
  const first = prices[0] || 0, last = prices[prices.length-1] || 0;
  const pct   = first > 0 ? ((last - first) / first) * 100 : 0;
  return { symbol, price: last, pct };
}

function renderMarketRows(containerId, rows) {
  const root = $(containerId); if (!root) return;
  root.innerHTML = '';
  if (!rows.length) {
    root.innerHTML = '<div class="empty-sub">Could not load quotes right now.</div>';
    return;
  }
  const isStocks = containerId.includes('stocks');
  rows.forEach(item => {
    const isUp = (item.pct || 0) >= 0;
    const inWatchlist = watchlistSymbols.has((item.symbol || '').toUpperCase());
    const row  = document.createElement('div');
    row.className = 'market-row';
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.dataset.symbol = (item.symbol || '').toUpperCase();
    row.innerHTML = `
      <div class="market-left">
        <div class="market-avatar">${item.symbol[0] || '?'}</div>
        <div class="market-symbol-block">
          <span class="market-symbol">${item.symbol}</span>
          <span class="market-tag">${isStocks ? 'Stock' : 'Crypto'}</span>
        </div>
      </div>
      <div class="market-right">
        <span class="market-price sensitive-value">${formatUSD(item.price)}</span>
        <span class="market-change ${isUp ? 'text-green' : 'text-red'}">${formatPct(item.pct)}</span>
        <button type="button" class="btn-watchlist-add ${inWatchlist ? 'in-watchlist' : ''}" data-symbol="${item.symbol}" data-type="${isStocks ? 'stock' : 'crypto'}" aria-label="${inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}">${inWatchlist ? '✓ In Watchlist' : '+ Watchlist'}</button>
      </div>`;
    const assetPayload = {
      symbol: item.symbol,
      real_symbol: item.symbol,
      current_price: item.price,
      percent_change: item.pct,
      days_held: 0,
      type: isStocks ? 'stock' : 'crypto',
    };
    row.addEventListener('click', (e) => {
      if (e.target.closest('.btn-watchlist-add')) return;
      openDetail(assetPayload);
    });
    row.addEventListener('keydown', e => {
      if (e.target.closest('.btn-watchlist-add')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(assetPayload); }
    });
    const btn = row.querySelector('.btn-watchlist-add');
    if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); toggleWatchlistFromMarket(btn.dataset.symbol, btn.dataset.type, btn); });
    root.appendChild(row);
  });
  applyVisibilityMask();
}

async function loadWatchlist() {
  const listEl = $('watchlist-list');
  const sectionEl = $('watchlist-section');
  if (!authToken) {
    if (listEl) listEl.innerHTML = '<div class="empty-sub">Faça login para usar a watchlist.</div>';
    watchlistSymbols.clear();
    watchlistIdBySymbol = {};
    return;
  }
  const res = await apiFetch('/watchlist', { headers: authHeaders() });
  if (!res || !res.ok) {
    if (listEl) listEl.innerHTML = '<div class="empty-sub">Could not load watchlist.</div>';
    watchlistSymbols.clear();
    watchlistIdBySymbol = {};
    return;
  }
  const items = (await res.json()).items || [];
  watchlistSymbols = new Set(items.map(i => (i.symbol || '').toUpperCase()));
  watchlistIdBySymbol = {};
  items.forEach(i => { watchlistIdBySymbol[(i.symbol || '').toUpperCase()] = i.id; });

  if (listEl) {
    if (!items.length) {
      listEl.innerHTML = '<div class="empty-sub">No assets in your watchlist yet. Use "+ Watchlist" on the assets below.</div>';
    } else {
      listEl.innerHTML = items.map((w) => {
        const price = w.current_price ?? 0;
        const pct = w.percent_change ?? 0;
        const isUp = pct >= 0;
        return `
          <div class="market-row" data-id="${w.id}" data-symbol="${w.symbol}">
            <div class="market-left">
              <div class="market-avatar">${(w.symbol || '?')[0]}</div>
              <div class="market-symbol-block">
                <span class="market-symbol">${w.symbol}</span>
                <span class="market-tag">${(w.type || 'crypto') === 'stock' ? 'Stock' : 'Crypto'}</span>
              </div>
            </div>
            <div class="market-right">
              <span class="market-price sensitive-value">${formatUSD(price)}</span>
              <span class="market-change ${isUp ? 'text-green' : 'text-red'}">${formatPct(pct)}</span>
              <button type="button" class="btn-watchlist-add in-watchlist btn-watchlist-remove" data-id="${w.id}" data-symbol="${w.symbol}" aria-label="Remove from watchlist">✕ Remover</button>
            </div>
          </div>`;
      }).join('');
      listEl.querySelectorAll('.market-row').forEach(row => {
        const symbol = row.dataset.symbol;
        const tag = row.querySelector('.market-tag')?.textContent;
        row.addEventListener('click', (e) => {
          if (e.target.closest('.btn-watchlist-remove')) return;
          openDetail({ symbol, real_symbol: symbol, current_price: 0, percent_change: 0, days_held: 0, type: tag === 'Stock' ? 'stock' : 'crypto' });
        });
      });
      listEl.querySelectorAll('.btn-watchlist-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await removeFromWatchlist(parseInt(btn.dataset.id, 10));
        });
      });
    }
  }
  applyVisibilityMask();
}

async function addToWatchlist(symbol, type) {
  if (!authToken) return;
  const res = await apiFetch('/watchlist', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ symbol: (symbol || '').toUpperCase(), type: type || 'crypto' }),
  });
  if (res && res.ok) {
    watchlistSymbols.add((symbol || '').toUpperCase());
    await loadWatchlist();
    if (lastMarketStocks.length) renderMarketRows('market-stocks-list', lastMarketStocks);
    if (lastMarketCryptos.length) renderMarketRows('market-cryptos-list', lastMarketCryptos);
    toast('Added to watchlist.', 'success');
  } else {
    const err = await res?.json().catch(() => ({}));
    if (res?.status === 402) showUpgradeModal(apiErrorDetail(err.detail, 'Watchlist limit reached on Free plan.'));
    else toast(apiErrorDetail(err.detail, 'Could not add to watchlist.'), 'error');
  }
}

async function removeFromWatchlist(itemId) {
  if (!authToken) return;
  const res = await apiFetch(`/watchlist/${itemId}`, { method: 'DELETE', headers: authHeaders() });
  if (res && res.ok) {
    await loadWatchlist();
    if (lastMarketStocks.length) renderMarketRows('market-stocks-list', lastMarketStocks);
    if (lastMarketCryptos.length) renderMarketRows('market-cryptos-list', lastMarketCryptos);
    toast('Removed from watchlist.', 'success');
  } else {
    toast('Could not remove.', 'error');
  }
}

async function toggleWatchlistFromMarket(symbol, type, btnEl) {
  const sym = (symbol || '').toUpperCase();
  if (watchlistSymbols.has(sym)) {
    const id = watchlistIdBySymbol[sym];
    if (id != null) await removeFromWatchlist(id);
  } else {
    await addToWatchlist(symbol, type);
  }
}

async function loadMarketWatch() {
  const [stocks, cryptos] = await Promise.all([
    Promise.all(FEATURED_STOCKS.map(s => fetchQuoteForSymbol(s))),
    Promise.all(FEATURED_CRYPTOS.map(s => fetchQuoteForSymbol(s))),
  ]);
  const stockList = stocks.filter(Boolean);
  const cryptoList = cryptos.filter(Boolean);
  lastMarketStocks = stockList;
  lastMarketCryptos = cryptoList;
  await loadWatchlist();
  renderMarketRows('market-stocks-list',  stockList);
  renderMarketRows('market-cryptos-list', cryptoList);
}

// ════════════════════════════════════════════════════════════════
// TRANSACTIONS
// ════════════════════════════════════════════════════════════════

async function loadTransactions() {
  if (!authToken) return;
  const res = await apiFetch('/transactions', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const txs  = await res.json();
  const list = $('transactions-list'); if (!list) return;
  list.innerHTML = '';

  if (!txs.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">🧾</div>
        <h3 class="empty-state__title">No transactions yet</h3>
        <p class="empty-state__body">Your buy and sell operations will appear here once you start trading.</p>
      </div>`;
    return;
  }

  txs.forEach(tx => {
    const pnl      = tx.realized_pnl;
    const pnlClass = pnl == null ? '' : pnl >= 0 ? 'text-green' : 'text-red';
    const pnlText  = pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${formatUSD(pnl)}`;
    const row      = document.createElement('div');
    row.className  = 'tx-item';
    row.innerHTML  = `
      <div class="tx-top">
        <span class="tx-symbol">${tx.symbol}</span>
        <span class="tx-type ${tx.type}">${tx.type}</span>
      </div>
      <div class="tx-meta">
        <span>${tx.date}</span>
        <span>${tx.amount} @ ${formatUSD(tx.price)}</span>
      </div>
      <div class="tx-meta" style="margin-top:6px;">
        <span class="sensitive-value">Total: ${formatUSD(tx.total_usd)}</span>
        <span class="${pnlClass}">P&L: ${pnlText}</span>
      </div>`;
    list.appendChild(row);
  });
  applyVisibilityMask();
}

// ════════════════════════════════════════════════════════════════
// AI ANALYSIS
// ════════════════════════════════════════════════════════════════

async function checkAIStatus() {
  const res = await apiFetch('/analysis/status');
  if (!res || !res.ok) return;
  const info = await res.json();
  if (!info.enabled)
    toast('IA indisponível: configure GEMINI_API_KEY no backend.', 'warning', 5500);
}

async function requestAssetAI(asset) {
  if (!authToken) return;
  if (!isPremium()) { showUpgradeModal('Análise IA por ativo é um recurso Premium.'); return; }
  const el = $(`ai-res-${asset.id}`); if (!el) return;
  el.style.display = 'block'; el.textContent = 'Analisando com Gemini…';

  const res = await apiFetch(
    `/analysis/${encodeURIComponent(asset.symbol)}?change=${asset.percent_change ?? 0}`,
    { headers: authHeaders() }
  );
  if (!res) { el.style.display = 'none'; return; }

  if (res.ok) {
    const data = await res.json();
    el.innerHTML = `<strong style="color:var(--accent-l)">IA:</strong> ${data.analysis}`;
  } else if (res.status === 402) {
    el.style.display = 'none';
    const err = await res.json().catch(() => ({}));
    showUpgradeModal(apiErrorDetail(err.detail, 'Recurso Premium.'));
  } else {
    el.style.display = 'none';
    toast('Análise IA temporariamente indisponível.', 'warning');
  }
}

async function handlePortfolioAI() {
  if (!authToken) { window.location.href = '/'; return; }
  if (!isPremium()) { showUpgradeModal('Análise IA do portfólio é um recurso Premium.'); return; }

  const textEl  = $('ai-portfolio-text');
  const badgeEl = $('ai-change-badge');
  const btn     = $('btn-portfolio-ai');
  if (textEl) textEl.textContent = 'Analisando portfólio com Gemini…';
  if (btn)    { btn.disabled = true; btn.textContent = '✨ Analisando…'; }

  try {
    const res = await apiFetch('/analysis/portfolio', { headers: authHeaders() });
    if (!res) { if (textEl) textEl.textContent = 'Erro de conexão. Tente novamente.'; return; }
    if (res.ok) {
      const data = await res.json();
      if (textEl) textEl.textContent = data.analysis || 'Análise indisponível.';
      if (typeof data.change_pct === 'number' && badgeEl) {
        const v = data.change_pct;
        badgeEl.className   = `change-badge ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`;
        badgeEl.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      }
    } else if (res.status === 402) {
      const err = await res.json().catch(() => ({}));
      showUpgradeModal(apiErrorDetail(err.detail, 'Recurso Premium.'));
      if (textEl) textEl.textContent = 'Disponível no plano Premium.';
    } else {
      if (textEl) textEl.textContent = 'Erro na análise. Tente novamente.';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Analisar Portfólio'; }
  }
}

// ════════════════════════════════════════════════════════════════
// NET WORTH
// ════════════════════════════════════════════════════════════════

function openNetWorthModal()  { $('modal-net-worth')?.classList.add('active'); }
function closeNetWorthModal() { $('modal-net-worth')?.classList.remove('active'); }

async function loadNetWorth() {
  if (!authToken) return;
  const res = await apiFetch('/net-worth', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const data = await res.json();

  const set = (id, val) => { const el = $(id); if (el) el.textContent = formatUSD(val || 0); };
  set('net-worth-total', data.net_worth);
  set('nw-investments',  data.breakdown?.investments);
  set('nw-cash',         data.breakdown?.cash);
  set('nw-real-estate',  data.breakdown?.real_estate);
  set('nw-other',        data.breakdown?.other);
  set('nw-debts',        data.breakdown?.debts);
  applyVisibilityMask();
}

async function saveNetWorthEntry() {
  const category = $('nw-category')?.value || 'other_assets';
  const label    = $('nw-label')?.value?.trim() || '';
  const value    = parseFloat($('nw-value')?.value || '0');

  if (!label) { toast('Informe um rótulo.', 'warning'); return; }
  if (!Number.isFinite(value) || value === 0) { toast('Informe um valor válido.', 'warning'); return; }

  const res = await apiFetch('/net-worth/entry', {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify({ category, label, value }),
  });
  if (!res || !res.ok) { toast('Could not save item.', 'error'); return; }

  if ($('nw-label')) $('nw-label').value = '';
  if ($('nw-value')) $('nw-value').value = '';
  closeNetWorthModal();
  toast('Item de patrimônio salvo.', 'success');
  loadNetWorth();
}

// ════════════════════════════════════════════════════════════════
// REBALANCE
// ════════════════════════════════════════════════════════════════

function renderRebalanceTargets(assets = []) {
  const root = $('rebalance-targets'); if (!root) return;
  rebalanceSymbols = [...new Set((assets || []).map(a => (a.symbol || '').toUpperCase()).filter(Boolean))];
  if (!rebalanceSymbols.length) {
    root.innerHTML = '<div class="score-sub">Add assets to calculate rebalancing.</div>';
    return;
  }
  const equal = (100 / rebalanceSymbols.length).toFixed(1);
  root.innerHTML = rebalanceSymbols.map(sym => `
    <div class="score-row" style="margin-top:6px;">
      <span>${sym}</span>
      <input type="number" class="select-ctrl rebalance-target" data-symbol="${sym}"
        value="${equal}" min="0" max="100" step="0.1" style="width:86px;">
    </div>`).join('');
  root.querySelectorAll('.rebalance-target').forEach(el => {
    el.addEventListener('input', updateRebalanceTargetSum);
  });
  updateRebalanceTargetSum();
}

function updateRebalanceTargetSum() {
  const inputs   = qsa('.rebalance-target');
  const sum      = inputs.reduce((acc, el) => acc + (parseFloat(el.value || '0') || 0), 0);
  const warningEl = $('rebalance-sum-warning'); if (!warningEl) return;
  warningEl.textContent = `Target sum: ${sum.toFixed(1)}%`;
  warningEl.style.color = Math.abs(sum - 100) < 0.05 ? '#86efac' : '#fca5a5';
}

async function calculateRebalance() {
  const inputs = qsa('.rebalance-target');
  if (!inputs.length) return;
  const targets = {};
  inputs.forEach(el => {
    const sym = (el.dataset.symbol || '').toUpperCase();
    targets[sym] = parseFloat(el.value || '0') || 0;
  });
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.1) { toast('A alocação deve somar 100%.', 'warning'); return; }

  const res = await apiFetch('/portfolio/rebalance', {
    method:  'POST',
    headers: authHeaders(),
    body:    JSON.stringify({ targets }),
  });
  if (!res || !res.ok) { toast('Could not calculate rebalance.', 'error'); return; }

  const data    = await res.json();
  const actions = data.actions || [];
  const actionsEl = $('rebalance-actions');
  if (actionsEl) {
    actionsEl.innerHTML = actions.length
      ? actions.map(a =>
          `<li><strong>${a.symbol}</strong>: ${a.action.toUpperCase()} ${a.amount} (~${formatUSD(a.usd_value)}) — ${a.reason}</li>`
        ).join('')
      : '<li>Nenhum rebalanceamento necessário. Alocações dentro de ±2% de deriva.</li>';
  }

  const taxBadge = $('rebalance-tax-badge');
  if (taxBadge) {
    if (isTaxPro()) {
      taxBadge.style.display = 'inline-flex';
      taxBadge.textContent   = `Impacto fiscal estimado: ${formatUSD(data.estimated_tax_impact || 0)}`;
      taxBadge.classList.add('sensitive-value');
    } else {
      taxBadge.style.display = 'none';
    }
  }
  applyVisibilityMask();
}

// ════════════════════════════════════════════════════════════════
// CSV EXPORT
// ════════════════════════════════════════════════════════════════

function csvCell(v) {
  const val = v == null ? '' : String(v);
  if (/[",\n]/.test(val)) return `"${val.replace(/"/g,'""')}"`;
  return val;
}

async function exportPortfolioCsv() {
  if (!authToken) { window.location.href = '/'; return; }
  const [balanceRes, txRes] = await Promise.all([
    apiFetch('/portfolio/balance', { headers: authHeaders() }),
    apiFetch('/transactions',      { headers: authHeaders() }),
  ]);
  if (!balanceRes || !balanceRes.ok) { toast('Could not export CSV now.', 'error'); return; }

  const balance = await balanceRes.json();
  const txs     = (txRes && txRes.ok) ? await txRes.json() : [];
  const rows    = [];

  rows.push(['Seção','Símbolo','Qtd','Preço Médio USD','Preço Atual USD','Posição USD','P&L USD','Variação %']);
  (balance.assets || []).forEach(a =>
    rows.push(['ativo', a.symbol, a.amount, a.purchase_price, a.current_price, a.position_value, a.profit, a.percent_change])
  );
  rows.push([]);
  rows.push(['Seção','Data','Símbolo','Tipo','Qtd','Preço USD','Total USD','P&L Realizado']);
  txs.forEach(tx =>
    rows.push(['transação', tx.date, tx.symbol, tx.type, tx.amount, tx.price, tx.total_usd, tx.realized_pnl])
  );

  const csv  = rows.map(row => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const now  = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const a    = document.createElement('a');
  a.href = url; a.download = `purp-portfolio-${now}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('CSV exportado com sucesso.', 'success');
}

// ════════════════════════════════════════════════════════════════
// CSV IMPORT
// ════════════════════════════════════════════════════════════════

const BROKER_HELP = {
  coinbase:  `<b>Como exportar:</b> Coinbase → Taxes → Transaction history → Generate Report → Download CSV`,
  robinhood: `<b>Como exportar:</b> App Robinhood → Account → Statements → Activity → Export to CSV`,
  fidelity:  `<b>Como exportar:</b> Fidelity → Accounts → History → selecione período → Download (CSV)`,
  kraken:    `<b>Como exportar:</b> Kraken → History → Export → Selecione <em>Ledgers</em> → Generate`,
  schwab:    `<b>Como exportar:</b> Schwab → Accounts → History → Export → CSV`,
};

function openImportModal() {
  if (!isPremium()) {
    showUpgradeModal('Importação CSV está disponível nos planos Investor e Tax Pro.');
    return;
  }
  importSelectedFile = null; importSelectedBroker = '';
  const brokerEl = $('import-broker-select');
  if (brokerEl) brokerEl.value = '';
  const labelEl  = $('file-drop-label');
  if (labelEl)   labelEl.innerHTML = '<span style="font-size:22px;">📂</span><br>Clique para selecionar um arquivo .csv';
  const helpEl   = $('import-help-text');
  if (helpEl)    helpEl.style.display = 'none';
  const progEl   = $('import-progress');
  if (progEl)    progEl.style.display = 'none';
  const resEl    = $('import-result');
  if (resEl)     resEl.style.display = 'none';
  const confBtn  = $('btn-import-confirm');
  if (confBtn)   confBtn.disabled = true;
  $('modal-import-csv')?.classList.add('active');
}

function closeImportModal() { $('modal-import-csv')?.classList.remove('active'); }

function updateImportConfirmBtn() {
  const btn = $('btn-import-confirm');
  if (btn) btn.disabled = !(importSelectedFile && importSelectedBroker);
}

function handleBrokerSelect() {
  importSelectedBroker = $('import-broker-select')?.value || '';
  const helpEl = $('import-help-text');
  if (helpEl) {
    if (importSelectedBroker && BROKER_HELP[importSelectedBroker]) {
      helpEl.innerHTML = BROKER_HELP[importSelectedBroker];
      helpEl.style.display = 'block';
    } else {
      helpEl.style.display = 'none';
    }
  }
  updateImportConfirmBtn();
}

function handleFileSelect(e) {
  const file = e.target?.files?.[0]; if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv')) { toast('Selecione um arquivo .csv', 'warning'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Arquivo muito grande. Máximo 5 MB.', 'error'); return; }
  importSelectedFile = file;
  const labelEl = $('file-drop-label');
  if (labelEl) {
    labelEl.innerHTML = `
      <span style="font-size:20px;">✅</span><br>
      <span style="font-weight:700;color:var(--text);">${file.name}</span><br>
      <span style="font-size:10px;color:var(--text3);">${(file.size/1024).toFixed(1)} KB</span>`;
  }
  updateImportConfirmBtn();
}

async function handleImportConfirm() {
  if (!importSelectedFile || !importSelectedBroker) return;
  if (!authToken) { window.location.href = '/'; return; }

  const btn = $('btn-import-confirm');
  if (btn) { btn.disabled = true; btn.textContent = 'Importando…'; }
  const resEl  = $('import-result');
  const progEl = $('import-progress');
  if (resEl)  resEl.style.display = 'none';
  if (progEl) progEl.style.display = 'block';

  const fill   = $('import-progress-fill');
  const status = $('import-status-text');
  if (fill)   fill.style.width = '15%';
  if (status) status.textContent = 'Fazendo upload…';

  try {
    const formData = new FormData();
    formData.append('file', importSelectedFile);
    if (fill)   fill.style.width = '40%';
    if (status) status.textContent = 'Processando transações…';

    const res = await apiFetch(
      `/import/csv?broker=${encodeURIComponent(importSelectedBroker)}`,
      {
        method:  'POST',
        headers: authToken ? { 'X-Auth-Token': authToken, 'Authorization': `Bearer ${authToken}` } : {},
        body:    formData,
      }
    );
    if (fill) fill.style.width = '80%';
    if (status) status.textContent = 'Finalizando…';

    if (!res) { toast('Erro de rede durante a importação.', 'error'); return; }
    const data = await res.json().catch(() => ({}));
    if (fill) fill.style.width = '100%';

    if (res.status === 402) {
      closeImportModal();
      showUpgradeModal(apiErrorDetail(data.detail, 'Importação CSV requer plano Investor ou Tax Pro.'));
      return;
    }
    if (!res.ok) {
      if (progEl) progEl.style.display = 'none';
      showImportResult('error', apiErrorDetail(data.detail, 'Importação falhou.'), null);
      return;
    }
    if (progEl) progEl.style.display = 'none';

    const imported = data.imported ?? 0, skipped = data.skipped ?? 0, errors = data.errors ?? [];
    showImportResult('success', null, { imported, skipped, errors });

    if (imported > 0) {
      fetchPortfolio(); loadMainChart(true);
      toast(`${imported} transaç${imported !== 1 ? 'ões importadas' : 'ão importada'} ✓`, 'success', 5000);
    }
  } catch (err) {
    if ($('import-progress')) $('import-progress').style.display = 'none';
    showImportResult('error', `Erro inesperado: ${err.message}`, null);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Importar'; }
  }
}

function showImportResult(type, errorMsg, summary) {
  const el = $('import-result'); if (!el) return;
  el.style.display = 'block';
  if (type === 'error') {
    el.innerHTML = `
      <div style="text-align:center;">
        <div style="font-size:20px;margin-bottom:6px;">❌</div>
        <div style="font-size:12px;color:#ef4444;">${errorMsg}</div>
      </div>`;
    return;
  }
  const { imported, skipped, errors } = summary;
  const errHtml = errors.length
    ? `<details style="margin-top:10px;"><summary style="font-size:10px;color:rgba(255,255,255,.35);cursor:pointer;">
        ${errors.length} linha${errors.length !== 1 ? 's' : ''} ignorada${errors.length !== 1 ? 's' : ''}
       </summary>
       <ul style="margin:6px 0 0;padding-left:16px;font-size:10px;color:rgba(255,255,255,.35);">
         ${errors.slice(0,10).map(e => `<li>${e}</li>`).join('')}
         ${errors.length > 10 ? `<li>…e mais ${errors.length-10}</li>` : ''}
       </ul></details>` : '';
  el.innerHTML = `
    <div style="text-align:center;">
      <div style="font-size:24px;margin-bottom:8px;">${imported > 0 ? '🎉' : '⚠️'}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <div style="text-align:center;">
          <div style="font-size:20px;font-weight:800;color:#10b981;">${imported}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.4);">Importadas</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:20px;font-weight:800;color:rgba(255,255,255,.5);">${skipped}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.4);">Ignoradas</div>
        </div>
      </div>
      ${imported === 0 ? `<div style="font-size:11px;color:rgba(255,255,255,.6);margin-top:8px;">
        Nenhuma transação importada. Verifique se o broker corresponde ao arquivo.
      </div>` : ''}
      ${errHtml}
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// ALERTS
// ════════════════════════════════════════════════════════════════

function updateAlertFormFields() {
  const type = $('alert-type-input')?.value;
  const labelMap = {
    price_above:         'Preço Alvo ($)',
    price_below:         'Preço Alvo ($)',
    percent_change_up:   'Porcentagem (%)',
    percent_change_down: 'Porcentagem (%)',
    rsi_oversold:        'Nível RSI (0-100)',
    rsi_overbought:      'Nível RSI (0-100)',
    rebalance_drift:     'Limite de Deriva (%)',
    volume_spike:        'Multiplicador de Volume',
    portfolio_down:      'Queda do Portfólio (%)',
  };
  const advancedTooltips = {
    rsi_oversold:    'RSI Oversold: alerta quando RSI fica abaixo do nível definido (ex.: 30).',
    rsi_overbought:  'RSI Overbought: alerta quando RSI supera o nível definido (ex.: 70).',
    rebalance_drift: 'Rebalance Drift: alerta quando a posição desvia da alocação-alvo.',
    volume_spike:    'Volume Spike: alerta quando o volume sobe acima do multiplicador escolhido.',
    portfolio_down:  'Portfolio Down (24h): alerta quando o portfólio cai o percentual definido.',
  };

  if ($('alert-target-label')) $('alert-target-label').textContent = labelMap[type] || 'Valor Alvo';
  if ($('alert-rsi-period-group'))
    $('alert-rsi-period-group').style.display = ['rsi_oversold','rsi_overbought'].includes(type) ? 'block' : 'none';
  if ($('alert-target-allocation-group'))
    $('alert-target-allocation-group').style.display = type === 'rebalance_drift' ? 'block' : 'none';
  if ($('alert-symbol-group'))
    $('alert-symbol-group').style.display = type === 'portfolio_down' ? 'none' : 'block';

  const tooltipEl = $('alert-type-tooltip');
  if (tooltipEl) {
    const txt = advancedTooltips[type] || '';
    if (txt) { tooltipEl.style.display = 'block'; tooltipEl.textContent = `💡 ${txt}`; }
    else      { tooltipEl.style.display = 'none';  tooltipEl.textContent = ''; }
  }
}

function renderAlertsList(alerts = []) {
  const root = $('alerts-list'); if (!root) return;
  const typeLabels = {
    price_above: 'Preço acima', price_below: 'Preço abaixo',
    percent_change_up: '% subida', percent_change_down: '% queda',
    rsi_oversold: 'RSI oversold', rsi_overbought: 'RSI overbought',
    rebalance_drift: 'Deriva rebalance', volume_spike: 'Pico volume',
    portfolio_down: 'Portfólio queda',
  };
  if (!alerts.length) { root.innerHTML = '<div class="empty-sub">Nenhum alerta ainda. Crie um acima.</div>'; return; }
  root.innerHTML = alerts.map(a => {
    const sym    = a.symbol || 'PORTFOLIO';
    const active = a.active !== false;
    const statusLabel = active ? 'Ativo' : 'Inativo';
    const statusColor = active ? 'var(--green)' : 'var(--text3)';
    const typeLabel = typeLabels[a.alert_type] || a.alert_type;
    return `
      <div class="market-row alert-row" data-id="${a.id}">
        <span class="market-symbol">${sym}</span>
        <span class="market-price" style="font-size:11px;color:var(--text2);">${typeLabel}</span>
        <span class="market-change" style="font-family:var(--mono);font-size:11px;">${a.target_value}</span>
        <span style="font-size:10px;color:${statusColor};min-width:46px;text-align:right;">${statusLabel}</span>
        <div style="display:flex;gap:4px;margin-left:8px;">
          <button class="alert-toggle-btn" data-id="${a.id}" data-active="${active}"
            title="${active ? 'Desativar alerta' : 'Ativar alerta'}"
            style="background:rgba(124,58,237,.15);border:1px solid rgba(124,58,237,.3);color:var(--accent-l);
                   border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:var(--font);
                   transition:all .15s;">${active ? '⏸' : '▶'}</button>
          <button class="alert-delete-btn" data-id="${a.id}"
            title="Excluir alerta"
            style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:var(--red-l);
                   border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer;font-family:var(--font);
                   transition:all .15s;">✕</button>
        </div>
      </div>`;
  }).join('');

  root.querySelectorAll('.alert-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id, 10);
      btn.disabled = true;
      const res = await apiFetch(`/alerts/${id}/toggle`, { method: 'POST', headers: authHeaders() });
      if (res && res.ok) {
        await loadAlerts();
      } else {
        const err = await res?.json().catch(() => ({})) || {};
        toast(apiErrorDetail(err.detail, 'Could not toggle alert.'), 'error');
        btn.disabled = false;
      }
    });
  });

  root.querySelectorAll('.alert-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id, 10);
      btn.disabled = true;
      const res = await apiFetch(`/alerts/${id}`, { method: 'DELETE', headers: authHeaders() });
      if (res && res.ok) {
        btn.closest('.alert-row')?.remove();
        if (!root.querySelector('.alert-row')) {
          root.innerHTML = '<div class="empty-sub">Nenhum alerta ainda.</div>';
        }
      } else {
        const err = await res?.json().catch(() => ({})) || {};
        toast(apiErrorDetail(err.detail, 'Could not delete alert.'), 'error');
        btn.disabled = false;
      }
    });
  });
}

async function loadAlerts() {
  if (!authToken) return;
  const res = await apiFetch('/alerts', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const data = await res.json();
  renderAlertsList(data.alerts || []);
}

async function handleCreateAlert() {
  if (!authToken) return;
  const alertType        = $('alert-type-input')?.value;
  const symbol           = $('alert-symbol-input')?.value?.trim()?.toUpperCase() || null;
  const targetValue      = parseFloat($('alert-target-input')?.value || '0');
  const recurring        = !!$('alert-recurring-input')?.checked;
  const rsiPeriod        = parseInt($('alert-rsi-period-input')?.value || '14', 10);
  const targetAllocation = parseFloat($('alert-target-allocation-input')?.value || '0');

  if (!alertType) { toast('Escolha um tipo de alerta.', 'warning'); return; }
  if (alertType !== 'portfolio_down' && !symbol) { toast('Símbolo é obrigatório para este tipo de alerta.', 'warning'); return; }
  if (!targetValue || targetValue <= 0) { toast('Insira um valor de limite válido.', 'warning'); return; }

  const payload = { symbol, alert_type: alertType, target_value: targetValue, recurring };
  if (['rsi_oversold','rsi_overbought'].includes(alertType)) payload.rsi_period = rsiPeriod;
  if (alertType === 'rebalance_drift') {
    if (!targetAllocation || targetAllocation < 0 || targetAllocation > 100) {
      toast('Alocação alvo deve ser entre 0 e 100.', 'warning'); return;
    }
    payload.target_allocation_pct  = targetAllocation;
    payload.rebalance_threshold_pct = targetValue;
  }

  const btn = $('btn-create-alert');
  if (btn) { btn.disabled = true; btn.textContent = 'Criando…'; }

  try {
    const res = await apiFetch('/alerts', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify(payload),
    });
    if (!res) return;
    if (res.ok) {
      toast('Alerta criado com sucesso.', 'success');
      if ($('alert-target-input'))            $('alert-target-input').value = '';
      if ($('alert-target-allocation-input')) $('alert-target-allocation-input').value = '';
      await loadAlerts();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(apiErrorDetail(err.detail, 'Could not create alert.'), 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Criar Alerta'; }
  }
}

// ════════════════════════════════════════════════════════════════
// SHARE PERFORMANCE — improved modal with preview + period selector
// ════════════════════════════════════════════════════════════════

let _shareCardBlobUrl = null;

function _buildAllocationPreview(assets) {
  if (!assets || !assets.length) return '';
  const total = assets.reduce((s, a) => s + (a.position_value || 0), 0);
  if (total <= 0) return '';

  const sorted  = [...assets].sort((a, b) => (b.position_value || 0) - (a.position_value || 0));
  const top6    = sorted.slice(0, 6);
  const others  = sorted.slice(6);
  const otherPct = others.reduce((s, a) => s + ((a.position_value || 0) / total * 100), 0);

  const PALETTE = [
    '#7c3aed','#a78bfa','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6',
  ];

  const rows = top6.map((a, i) => {
    const pct  = ((a.position_value || 0) / total * 100).toFixed(1);
    const sym2 = (a.symbol || '').substring(0, 2).toUpperCase();
    const iconSrc = assetIconUrl(a.icon, a.symbol);
    const iconHtml = iconSrc
      ? `<img src="${iconSrc}" alt="${a.symbol}" style="width:20px;height:20px;border-radius:6px;object-fit:cover;" onerror="this.style.display='none'">`
      : `<span style="width:20px;height:20px;border-radius:6px;background:${PALETTE[i % PALETTE.length]};display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:#fff;">${sym2}</span>`;
    return `
      <div style="display:flex;align-items:center;gap:8px;">
        ${iconHtml}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
            <span style="font-size:11px;font-weight:700;color:#f2f0ff;">${a.symbol}</span>
            <span style="font-size:11px;font-weight:800;color:#f2f0ff;font-variant-numeric:tabular-nums;">${pct}%</span>
          </div>
          <div style="height:4px;border-radius:99px;background:rgba(255,255,255,0.1);overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${PALETTE[i % PALETTE.length]};border-radius:99px;"></div>
          </div>
        </div>
      </div>`;
  }).join('');

  const othersRow = otherPct > 0.5 ? `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="width:20px;height:20px;border-radius:6px;background:rgba(255,255,255,0.12);display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;color:rgba(242,240,255,0.6);">+${others.length}</span>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <span style="font-size:11px;font-weight:600;color:rgba(242,240,255,0.55);">Others</span>
          <span style="font-size:11px;font-weight:700;color:rgba(242,240,255,0.55);font-variant-numeric:tabular-nums;">${otherPct.toFixed(1)}%</span>
        </div>
        <div style="height:4px;border-radius:99px;background:rgba(255,255,255,0.1);overflow:hidden;">
          <div style="height:100%;width:${otherPct.toFixed(1)}%;background:rgba(255,255,255,0.25);border-radius:99px;"></div>
        </div>
      </div>
    </div>` : '';

  return `
    <div style="background:linear-gradient(135deg,#0f0c1e,#18153a);border-radius:16px;padding:20px;border:1px solid rgba(124,58,237,0.25);">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#7c3aed,#a78bfa);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#fff;">P</div>
          <div>
            <div style="font-size:13px;font-weight:800;color:#f2f0ff;letter-spacing:-0.2px;">Portfolio Allocation</div>
            <div style="font-size:10px;color:rgba(242,240,255,0.5);">No monetary values · Purp.ai</div>
          </div>
        </div>
        <div style="font-size:10px;padding:3px 8px;border-radius:99px;background:rgba(124,58,237,0.2);border:1px solid rgba(124,58,237,0.35);color:#a78bfa;font-weight:700;">${assets.length} assets</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${rows}${othersRow}
      </div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.07);text-align:center;font-size:10px;color:rgba(242,240,255,0.35);">
        Track your portfolio at getpurpai.com
      </div>
    </div>`;
}

function _openShareModal() {
  let modal = document.getElementById('share-card-modal');
  const modalClose = () => {
    modal?.remove();
    if (_shareCardBlobUrl) { URL.revokeObjectURL(_shareCardBlobUrl); _shareCardBlobUrl = null; }
  };

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-card-modal';
    modal.className = 'share-modal-overlay';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(7,6,15,0.9);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(16px);';
    modal.innerHTML = `
      <div class="share-modal-inner" style="background:var(--bg2);border:1px solid var(--border-l);border-radius:var(--r-lg);width:min(100%,520px);padding:0;overflow:hidden;animation:modalIn 0.24s var(--ease-out);">

        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px 0;">
          <div>
            <h3 style="font-size:15px;font-weight:800;margin:0;letter-spacing:-0.3px;">📤 Share Portfolio</h3>
            <p style="font-size:11px;color:var(--text3);margin:3px 0 0;">Shows allocation % — no dollar amounts</p>
          </div>
          <button id="share-modal-close" style="background:var(--card);border:1px solid var(--border);color:var(--text3);width:32px;height:32px;border-radius:var(--r-sm);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.2s;">✕</button>
        </div>

        <!-- Mode tabs -->
        <div style="display:flex;gap:6px;padding:14px 20px 0;">
          <button class="share-mode-btn btn ghost active-tab" data-mode="preview" style="flex:1;font-size:11px;padding:7px;">👁 Allocation Preview</button>
          <button class="share-mode-btn btn ghost" data-mode="image" style="flex:1;font-size:11px;padding:7px;">🖼 Download Image</button>
        </div>

        <!-- Allocation preview pane -->
        <div id="share-pane-preview" style="padding:14px 20px;">
          <div id="share-allocation-content" style="min-height:180px;"></div>
        </div>

        <!-- Image pane -->
        <div id="share-pane-image" style="padding:14px 20px;display:none;">
          <div style="display:flex;gap:6px;margin-bottom:12px;">
            ${['1mo','3mo','1y'].map(p => `
              <button class="share-period-btn btn ghost" data-period="${p}" style="flex:1;padding:7px;font-size:11px;">
                ${p === '1mo' ? 'This Month' : p === '3mo' ? 'This Quarter' : 'This Year'}
              </button>`).join('')}
          </div>
          <div id="share-preview" style="background:var(--bg3);border-radius:var(--r);overflow:hidden;min-height:160px;display:flex;align-items:center;justify-content:center;">
            <span style="color:var(--text3);font-size:12px;">Select a period above</span>
          </div>
        </div>

        <!-- Footer actions -->
        <div style="display:flex;gap:8px;padding:0 20px 18px;">
          <button id="share-btn-download" class="btn ghost" style="flex:1;" disabled>⬇ Download</button>
          <button id="share-btn-copy-img" class="btn ghost" style="flex:1;" disabled>🔗 Copy Link</button>
          <button id="share-btn-copy-preview" class="btn primary" style="flex:1;">Copy as Text</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('share-modal-close').addEventListener('click', modalClose);
    modal.addEventListener('click', e => { if (e.target === modal) modalClose(); });

    // Mode switch
    modal.querySelectorAll('.share-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.share-mode-btn').forEach(b => {
          b.classList.remove('active-tab');
          b.style.cssText = b.style.cssText.replace('background:linear-gradient(135deg,var(--accent),#9333ea);color:#fff;border-color:transparent;','');
        });
        btn.classList.add('active-tab');
        const mode = btn.dataset.mode;
        document.getElementById('share-pane-preview').style.display = mode === 'preview' ? '' : 'none';
        document.getElementById('share-pane-image').style.display   = mode === 'image'   ? '' : 'none';
        document.getElementById('share-btn-download').style.display  = mode === 'image'   ? '' : 'none';
        document.getElementById('share-btn-copy-img').style.display  = mode === 'image'   ? '' : 'none';
        document.getElementById('share-btn-copy-preview').style.display = mode === 'preview' ? '' : 'none';
      });
    });

    // Populate allocation preview immediately
    const allocEl = document.getElementById('share-allocation-content');
    if (allocEl) {
      // Get current portfolio data from page state
      apiFetch('/portfolio/balance', { headers: authHeaders() }).then(async r => {
        if (!r || !r.ok) { allocEl.innerHTML = '<p style="color:var(--text3);font-size:12px;text-align:center;padding:20px 0;">Unable to load portfolio data.</p>'; return; }
        const d = await r.json();
        allocEl.innerHTML = _buildAllocationPreview(d.assets || []) || '<p style="color:var(--text3);font-size:12px;text-align:center;padding:20px 0;">No assets to display.</p>';
      });
    }

    modal.querySelectorAll('.share-period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.share-period-btn').forEach(b => b.classList.remove('primary'));
        btn.classList.add('primary');
        _loadSharePreview(btn.dataset.period);
      });
    });

    document.getElementById('share-btn-download').addEventListener('click', () => {
      if (!_shareCardBlobUrl) return;
      const a = document.createElement('a');
      a.href = _shareCardBlobUrl; a.download = 'purp-portfolio.png'; a.click();
    });

    document.getElementById('share-btn-copy-img').addEventListener('click', async () => {
      if (!_shareCardBlobUrl) return;
      try { await navigator.clipboard.writeText(_shareCardBlobUrl); toast('Link copied!', 'success', 2500); }
      catch (_) { window.open(_shareCardBlobUrl, '_blank'); }
    });

    document.getElementById('share-btn-copy-preview').addEventListener('click', async () => {
      const allocEl = document.getElementById('share-allocation-content');
      if (!allocEl) return;
      try {
        const text = allocEl.innerText.replace(/\s+/g, ' ').trim();
        await navigator.clipboard.writeText(`My Purp Portfolio:\n${text}\n\nTrack yours at getpurpai.com`);
        toast('Portfolio summary copied!', 'success', 2500);
      } catch (_) { toast('Could not copy.', 'warning'); }
    });

    // Hide image actions initially
    document.getElementById('share-btn-download').style.display  = 'none';
    document.getElementById('share-btn-copy-img').style.display  = 'none';
  }
  modal.style.display = 'flex';
}

async function _loadSharePreview(period) {
  const preview   = document.getElementById('share-preview');
  const dlBtn     = document.getElementById('share-btn-download');
  const copyBtn   = document.getElementById('share-btn-copy');
  if (!preview) return;

  preview.innerHTML = '<span style="color:var(--text3);font-size:13px;">Generating…</span>';
  if (dlBtn)   dlBtn.disabled   = true;
  if (copyBtn) copyBtn.disabled = true;

  if (_shareCardBlobUrl) { URL.revokeObjectURL(_shareCardBlobUrl); _shareCardBlobUrl = null; }

  const res = await apiFetch(`/portfolio/share-card?period=${period}`, { headers: authHeaders() });
  if (!res || !res.ok) {
    preview.innerHTML = '<span style="color:var(--red);font-size:13px;">Could not generate card.</span>';
    return;
  }

  const blob = await res.blob();
  _shareCardBlobUrl = URL.createObjectURL(blob);

  preview.innerHTML = `<img src="${_shareCardBlobUrl}" alt="Portfolio card" style="width:100%;height:auto;display:block;border-radius:var(--r-sm);">`;
  if (dlBtn)   { dlBtn.disabled   = false; }
  if (copyBtn) { copyBtn.disabled = false; }
}

async function sharePerformanceCard() {
  if (!authToken) return;
  _openShareModal();
}

// ════════════════════════════════════════════════════════════════
// TAX TOOLS — visibilidade + sub-tabs
// ════════════════════════════════════════════════════════════════

function updateTaxToolsVisibility() {
  const taxSection = $('tax-tools-section');
  const taxCta     = $('tax-pro-cta');
  if (!taxSection || !taxCta) return;

  if (isTaxPro()) {
    taxSection.style.display = '';
    taxCta.style.display     = 'none';
    buildTaxTabBar();
    loadTaxLossHarvesting();
  } else if (isPremium()) {
    taxSection.style.display = 'none';
    taxCta.style.display     = '';
  } else {
    taxSection.style.display = 'none';
    taxCta.style.display     = 'none';
  }
}

function buildTaxTabBar() {
  const taxSection = $('tax-tools-section'); if (!taxSection) return;
  if ($('tax-tab-bar-container')) return;

  const barWrapper = document.createElement('div');
  barWrapper.id = 'tax-tab-bar-container';
  barWrapper.innerHTML = `
    <div class="tax-tab-bar" id="tax-tab-bar">
      <button class="tax-tab-btn active" data-tab="tlh"><span class="tab-icon">🌿</span>Tax Loss</button>
      <button class="tax-tab-btn" data-tab="form8949"><span class="tab-icon">📄</span>Form 8949</button>
      <button class="tax-tab-btn" data-tab="pl"><span class="tab-icon">📈</span>P&amp;L</button>
      <button class="tax-tab-btn" data-tab="summary"><span class="tab-icon">📊</span>Summary</button>
    </div>`;
  taxSection.insertBefore(barWrapper, taxSection.firstChild);

  // Form 8949 panel
  const f49Panel = document.createElement('div');
  f49Panel.id = 'tax-panel-form8949'; f49Panel.className = 'tax-panel';
  f49Panel.innerHTML = `
    <div class="form8949-controls">
      <div><label for="f49-year-select">Ano Fiscal</label>
        <select id="f49-year-select">
          <option value="2024">2024</option><option value="2023">2023</option><option value="2022">2022</option>
        </select></div>
      <div><label for="f49-method-select">Método de Custo</label>
        <select id="f49-method-select">
          <option value="FIFO">FIFO (Padrão IRS)</option>
          <option value="HIFO">HIFO (Min. Imposto)</option>
          <option value="LIFO">LIFO</option>
        </select></div>
    </div>
    <button class="btn-download-8949" id="btn-download-8949">⬇️ Baixar Form 8949 CSV</button>
    <p class="turbotax-note">Compatível com TurboTax, TaxAct &amp; H&amp;R Block</p>
    <div id="form8949-preview-loading" style="display:none;">
      <div class="shimmer-line" style="width:80%"></div>
      <div class="shimmer-line" style="width:60%"></div>
      <div class="shimmer-line" style="width:70%"></div>
    </div>
    <div id="form8949-preview"></div>`;
  taxSection.appendChild(f49Panel);

  // Summary panel
  const sumPanel = document.createElement('div');
  sumPanel.id = 'tax-panel-summary'; sumPanel.className = 'tax-panel';
  sumPanel.innerHTML = `
    <div class="form8949-controls">
      <div><label for="sum-year-select">Ano Fiscal</label>
        <select id="sum-year-select">
          <option value="2024">2024</option><option value="2023">2023</option><option value="2022">2022</option>
        </select></div>
      <div><label for="sum-method-select">Método</label>
        <select id="sum-method-select">
          <option value="FIFO">FIFO</option><option value="HIFO">HIFO</option><option value="LIFO">LIFO</option>
        </select></div>
    </div>
    <div id="tax-summary-content">
      <div class="shimmer-line" style="width:100%"></div>
      <div class="shimmer-line" style="width:80%"></div>
      <div class="shimmer-line" style="width:90%"></div>
    </div>`;
  taxSection.appendChild(sumPanel);

  // P&L panel
  const plPanel = document.createElement('div');
  plPanel.id = 'tax-panel-pl'; plPanel.className = 'tax-panel';
  const currentYr = new Date().getFullYear();
  plPanel.innerHTML = `
    <div class="form8949-controls">
      <div><label for="pl-year-select">Tax Year</label>
        <select id="pl-year-select">
          <option value="${currentYr}">${currentYr}</option>
          <option value="${currentYr-1}">${currentYr-1}</option>
          <option value="${currentYr-2}">${currentYr-2}</option>
        </select></div>
      <div><label for="pl-method-select">Method</label>
        <select id="pl-method-select">
          <option value="FIFO">FIFO (IRS Default)</option>
          <option value="HIFO">HIFO (Min. Tax)</option>
          <option value="LIFO">LIFO</option>
        </select></div>
    </div>
    <button class="btn-download-8949" id="btn-export-pl" style="margin-bottom:12px;">⬇ Export P&amp;L CSV</button>
    <div id="pl-report-content">
      <div class="shimmer-line" style="width:100%"></div>
      <div class="shimmer-line" style="width:80%"></div>
    </div>`;
  taxSection.appendChild(plPanel);

  // Wrap existing TLH content
  const tlhPanel = document.createElement('div');
  tlhPanel.id = 'tax-panel-tlh'; tlhPanel.className = 'tax-panel active';
  const existing = [...taxSection.children].filter(el =>
    !['tax-tab-bar-container','tax-panel-form8949','tax-panel-summary','tax-panel-pl'].includes(el.id)
  );
  existing.forEach(node => tlhPanel.appendChild(node));
  taxSection.appendChild(tlhPanel);

  // Tab click handlers
  barWrapper.querySelectorAll('.tax-tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTaxTab(btn.dataset.tab))
  );

  $('btn-download-8949')?.addEventListener('click',    handleDownload8949);
  $('f49-year-select')?.addEventListener('change',     loadForm8949Preview);
  $('f49-method-select')?.addEventListener('change',   loadForm8949Preview);
  $('sum-year-select')?.addEventListener('change',     loadTaxSummary);
  $('sum-method-select')?.addEventListener('change',   loadTaxSummary);
  $('pl-year-select')?.addEventListener('change',      loadPLReport);
  $('pl-method-select')?.addEventListener('change',    loadPLReport);
  $('btn-export-pl')?.addEventListener('click',        exportPLCSV);
}

function switchTaxTab(tab) {
  activeTaxTab = tab;
  qsa('.tax-tab-btn').forEach(b => {
    b.classList.remove('active','active-gold');
    if (b.dataset.tab === tab)
      b.classList.add(tab === 'summary' ? 'active-gold' : 'active');
  });
  qsa('.tax-panel').forEach(p => p.classList.remove('active'));
  const panel = $(`tax-panel-${tab}`);
  if (panel) {
    panel.classList.add('active');
    if (tab === 'form8949' && !$('form8949-preview')?.hasChildNodes()) loadForm8949Preview();
    if (tab === 'summary') loadTaxSummary();
    if (tab === 'pl') loadPLReport();
  }
}

// ── P&L Report ────────────────────────────────────────────────────
async function loadPLReport() {
  const year   = $('pl-year-select')?.value   || new Date().getFullYear();
  const method = $('pl-method-select')?.value || 'FIFO';
  const el     = $('pl-report-content'); if (!el) return;

  el.innerHTML = '<div class="shimmer-line" style="width:100%"></div><div class="shimmer-line" style="width:80%"></div>';

  const res = await apiFetch(`/tax/pl-report?year=${year}&method=${method}`, { headers: authHeaders() });
  if (!res || !res.ok) { el.innerHTML = '<p class="panel-sub">Could not load P&amp;L report.</p>'; return; }
  const data = await res.json();

  const quarters = data.quarters || {};
  const summary  = data.summary  || {};

  const sign = v => v >= 0 ? `<span class="gain">+${formatUSD(v)}</span>` : `<span class="loss">${formatUSD(v)}</span>`;

  let rows = '';
  for (const [qk, qv] of Object.entries(quarters)) {
    rows += `<tr>
      <td><strong>${qk}</strong> <span style="color:var(--text3);font-size:11px;">${qv.label}</span></td>
      <td class="sensitive-value">${formatUSD(qv.proceeds)}</td>
      <td class="sensitive-value">${formatUSD(qv.cost_basis)}</td>
      <td class="sensitive-value">${sign(qv.gain_loss)}</td>
      <td>${qv.trades}</td>
    </tr>`;
  }

  el.innerHTML = `
    <table class="pl-table">
      <thead>
        <tr>
          <th>Quarter</th><th>Proceeds</th><th>Cost Basis</th><th>Gain / Loss</th><th>Trades</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr class="total">
          <td><strong>Total ${year}</strong></td>
          <td class="sensitive-value">${formatUSD(summary.total_proceeds || 0)}</td>
          <td class="sensitive-value">${formatUSD(summary.total_cost_basis || 0)}</td>
          <td class="sensitive-value">${sign(summary.total_net_gain_loss || 0)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
    <p class="panel-sub" style="margin-top:8px;font-size:11px;">
      Short-term: <span class="sensitive-value">${formatUSD(summary.net_short_term || 0)}</span> &nbsp;·&nbsp;
      Long-term: <span class="sensitive-value">${formatUSD(summary.net_long_term || 0)}</span>
      &nbsp;·&nbsp; Method: ${data.method}
    </p>`;

  applyVisibilityMask();
}

async function exportPLCSV() {
  const year   = $('pl-year-select')?.value   || new Date().getFullYear();
  const method = $('pl-method-select')?.value || 'FIFO';
  const btn    = $('btn-export-pl');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    const res = await apiFetch(`/tax/pl-report?year=${year}&method=${method}&fmt=csv`, { headers: authHeaders() });
    if (!res || !res.ok) { toast('Could not export P&L report.', 'error'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `purp-pl-${year}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Export P&L CSV'; }
  }
}

// ── Form 8949 preview ─────────────────────────────────────────────
async function loadForm8949Preview() {
  if (!authToken || !isTaxPro()) return;
  const year    = $('f49-year-select')?.value   || new Date().getFullYear();
  const method  = $('f49-method-select')?.value || 'FIFO';
  const preview = $('form8949-preview');
  const loadEl  = $('form8949-preview-loading');
  if (!preview) return;

  preview.innerHTML = ''; if (loadEl) loadEl.style.display = 'block';

  const res = await apiFetch(`/tax/form-8949-json?year=${year}&method=${method}`, { headers: authHeaders() });
  if (loadEl) loadEl.style.display = 'none';

  if (!res || !res.ok) {
    preview.innerHTML = '<div class="form8949-empty">Could not load transactions.</div>';
    return;
  }
  const data = await res.json();

  if (!data.part_I?.length && !data.part_II?.length) {
    preview.innerHTML = `<div class="form8949-empty">🎯 Sem vendas registradas para ${year}.<br><span style="font-size:10px;opacity:.6;">Venda um ativo para ver as linhas do Form 8949.</span></div>`;
    return;
  }

  function renderRows(rows, title, colorClass) {
    if (!rows.length) return '';
    const rowsHtml = rows.map(r => {
      const isGain = r.gain_loss >= 0;
      return `<div class="f49-row">
        <div class="f49-row-top">
          <span class="f49-symbol">${r.description}</span>
          <span class="${isGain ? 'f49-gain' : 'f49-loss'}">${isGain ? '+' : ''}${formatUSD(r.gain_loss)}</span>
        </div>
        <div class="f49-meta" style="margin-bottom:6px;">Adquirido: ${r.date_acquired} → Vendido: ${r.date_sold}</div>
        <div class="f49-grid">
          <span>Receita</span><span>${formatUSD(r.proceeds)}</span>
          <span>Custo Base</span><span>${formatUSD(r.cost_basis)}</span>
        </div>
      </div>`;
    }).join('');
    const net = rows.reduce((a, r) => a + r.gain_loss, 0);
    const isNetGain = net >= 0;
    return `
      <div class="form8949-section-title ${colorClass}">${title} (${rows.length} transações)</div>
      ${rowsHtml}
      <div class="f49-part-total">
        <span>${title} Líquido</span>
        <span class="${isNetGain ? 'f49-gain' : 'f49-loss'}">${isNetGain ? '+' : ''}${formatUSD(net)}</span>
      </div>`;
  }

  preview.innerHTML =
    renderRows(data.part_I,  'Parte I — Curto Prazo', '') +
    renderRows(data.part_II, 'Parte II — Longo Prazo', 'gold');

  applyVisibilityMask();
}

// ── Form 8949 download ────────────────────────────────────────────
async function handleDownload8949() {
  if (!authToken) { window.location.href = '/'; return; }
  if (!isTaxPro()) { showTaxProUpgradeModal(); return; }

  const year   = $('f49-year-select')?.value   || new Date().getFullYear();
  const method = $('f49-method-select')?.value || 'FIFO';
  const btn    = $('btn-download-8949');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Gerando…'; }

  try {
    const res = await apiFetch(`/tax/form-8949?year=${year}&method=${method}`, { headers: authHeaders() });
    if (!res) { toast('Erro de rede. Tente novamente.', 'error'); return; }
    if (res.status === 402) { toast('Plano Tax Pro necessário.', 'warning'); showTaxProUpgradeModal(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(apiErrorDetail(err.detail, 'Could not generate Form 8949.'), 'error'); return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `form-8949-${year}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast(`Form 8949 (${year}) baixado ✓`, 'success', 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇️ Baixar Form 8949 CSV'; }
  }
}

// ── Tax Summary ───────────────────────────────────────────────────
async function loadTaxSummary() {
  if (!authToken || !isTaxPro()) return;
  const year   = $('sum-year-select')?.value   || new Date().getFullYear();
  const method = $('sum-method-select')?.value || 'FIFO';
  const contentEl = $('tax-summary-content'); if (!contentEl) return;

  contentEl.innerHTML = `
    <div class="shimmer-line" style="width:100%"></div>
    <div class="shimmer-line" style="width:80%"></div>
    <div class="shimmer-line" style="width:90%"></div>`;

  const res = await apiFetch(`/tax/summary?year=${year}&method=${method}`, { headers: authHeaders() });
  if (!res || !res.ok) {
    contentEl.innerHTML = '<div class="form8949-empty">Could not load tax summary.</div>';
    return;
  }
  const d = await res.json();
  const netTotal  = d.total_net_gain_loss;
  const netClass  = netTotal >= 0 ? 'green' : 'red';
  const stClass   = d.net_short_term  >= 0 ? 'green' : 'red';
  const ltClass   = d.net_long_term   >= 0 ? 'green' : 'red';

  contentEl.innerHTML = `
    <div class="tax-summary-grid">
      <div class="tax-sum-card ${netTotal >= 0 ? 'net-gain' : 'net-loss'}">
        <div class="tax-sum-label">Ganho/(Perda) Líquido</div>
        <div class="tax-sum-value ${netClass}">${netTotal >= 0 ? '+' : ''}${formatUSD(netTotal)}</div>
      </div>
      <div class="tax-sum-card">
        <div class="tax-sum-label">Curto Prazo</div>
        <div class="tax-sum-value ${stClass}">${d.net_short_term >= 0 ? '+' : ''}${formatUSD(d.net_short_term)}</div>
      </div>
      <div class="tax-sum-card">
        <div class="tax-sum-label">Longo Prazo</div>
        <div class="tax-sum-value ${ltClass}">${d.net_long_term >= 0 ? '+' : ''}${formatUSD(d.net_long_term)}</div>
      </div>
      <div class="tax-sum-card">
        <div class="tax-sum-label">Transações</div>
        <div class="tax-sum-value">${d.short_term_count + d.long_term_count}</div>
      </div>
    </div>
    <div class="tax-summary-full">
      <div class="tax-summary-full-title">Receitas &amp; Custo Base</div>
      <div class="tax-summary-row">
        <span class="label">Total de Receitas</span>
        <span class="value sensitive-value">${formatUSD(d.total_proceeds)}</span>
      </div>
      <div class="tax-summary-row">
        <span class="label">Total Custo Base</span>
        <span class="value sensitive-value">${formatUSD(d.total_cost_basis)}</span>
      </div>
      <div class="tax-summary-row">
        <span class="label">Ganho/(Perda) Líquido</span>
        <span class="value ${netClass}" style="font-weight:800;">${netTotal >= 0 ? '+' : ''}${formatUSD(netTotal)}</span>
      </div>
    </div>
    <div class="tax-summary-full">
      <div class="tax-summary-full-title">Estimativa de Imposto</div>
      <div class="bracket-rows">
        <div class="bracket-row"><span class="bracket-label">Faixa 22%</span><span class="bracket-value">${formatUSD(d.estimated_tax_22pct)}</span></div>
        <div class="bracket-row"><span class="bracket-label">Faixa 24%</span><span class="bracket-value">${formatUSD(d.estimated_tax_24pct)}</span></div>
        <div class="bracket-row"><span class="bracket-label">Faixa 32%</span><span class="bracket-value">${formatUSD(d.estimated_tax_32pct)}</span></div>
      </div>
      <p style="font-size:9px;color:rgba(255,255,255,.25);margin:0;text-align:center;">
        Apenas estimativas. Consulte um profissional de impostos.
      </p>
    </div>`;

  applyVisibilityMask();
}

// ── TLH ──────────────────────────────────────────────────────────
async function loadTaxLossHarvesting() {
  if (!authToken || !isTaxPro()) return;
  const listEl   = $('tlh-list');
  const badgeEl  = $('tlh-total-badge');
  if (!listEl) return;

  const bracket = $('tlh-bracket-select')?.value || '0.22';
  if (badgeEl) { badgeEl.textContent = 'Carregando…'; badgeEl.classList.add('loading'); }
  listEl.innerHTML = '<div class="tlh-empty"><div class="tlh-empty-icon">⏳</div>Buscando preços…</div>';

  const res = await apiFetch(`/portfolio/tax-loss-harvesting?tax_bracket=${bracket}`, { headers: authHeaders() });
  if (!res) { listEl.innerHTML = '<div class="tlh-empty">Could not load data.</div>'; return; }
  if (res.status === 402) { listEl.innerHTML = '<div class="tlh-empty">Plano Tax Pro necessário.</div>'; return; }
  if (!res.ok) { listEl.innerHTML = '<div class="tlh-empty">Erro ao carregar oportunidades.</div>'; return; }

  const data          = await res.json();
  const opportunities = data.opportunities || [];
  if (badgeEl) {
    badgeEl.classList.remove('loading');
    if (data.total_potential_savings > 0) {
      badgeEl.textContent = `Economize ${formatUSD(data.total_potential_savings)}`;
    } else {
      badgeEl.textContent = '✓ Sem perdas'; badgeEl.style.background = 'rgba(0,0,0,0.2)';
      badgeEl.style.color = 'var(--text3)'; badgeEl.style.borderColor = 'var(--border)';
    }
  }

  listEl.innerHTML = '';
  if (!opportunities.length) {
    listEl.innerHTML = `
      <div class="tlh-empty">
        <div class="tlh-empty-icon">🎉</div>
        <div>Nenhuma perda a ser colhida agora.</div>
        <div style="font-size:10px;margin-top:4px;color:var(--text3);">Todas as posições são lucrativas ou abaixo do limite de $50.</div>
      </div>`;
    return;
  }

  opportunities.forEach(opp => {
    const isShort = opp.gain_type === 'short_term';
    const item = document.createElement('div'); item.className = 'tlh-item';
    item.innerHTML = `
      <div class="tlh-item-top">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="tlh-symbol">${opp.symbol}</span>
          <span class="tlh-gain-type ${isShort ? 'short' : 'long'}">${isShort ? 'Curto Prazo' : 'Longo Prazo'}</span>
        </div>
        <span class="tlh-savings-badge">Economize ${formatUSD(opp.estimated_tax_saved)}</span>
      </div>
      <div class="tlh-grid">
        <div class="tlh-cell"><span class="tlh-cell-label">Perda Não Realizada</span><span class="tlh-cell-value loss">${formatUSD(opp.unrealized_loss)}</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Alíquota Aplicada</span><span class="tlh-cell-value">${opp.effective_rate_pct}%</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Período de Posse</span><span class="tlh-cell-value">${opp.holding_days} dias</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Seguro Recomprar Após</span><span class="tlh-cell-value">${opp.wash_sale_safe_date}</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Preço Atual</span><span class="tlh-cell-value sensitive-value">${formatUSD(opp.current_price)}</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Preço de Compra</span><span class="tlh-cell-value sensitive-value">${formatUSD(opp.purchase_price)}</span></div>
      </div>
      ${opp.suggested_replacement ? `<div class="tlh-replacement"><span>⚠️ Regra Wash-Sale:</span> Considere <strong>${opp.suggested_replacement}</strong> como substituto enquanto aguarda 31 dias.</div>` : ''}`;
    listEl.appendChild(item);
  });
  applyVisibilityMask();
}

// ════════════════════════════════════════════════════════════════
// DIVIDEND TRACKER
// ════════════════════════════════════════════════════════════════

function ensureDividendCard() {
  if ($('div-income-card')) return;
  const assetsList = $('assets-list');
  const colLeft = document.querySelector('.dash-col-left');
  const parent = assetsList?.parentNode || colLeft || null;
  if (!parent) return;

  const card = document.createElement('div');
  card.id = 'div-income-card'; card.className = 'div-card';
  card.innerHTML = `
    <div class="div-card-header">
      <span class="div-card-title">🌱 Renda de Dividendos</span>
      <button class="div-refresh-btn" id="btn-div-refresh" title="Atualizar">↻</button>
    </div>
    <div id="div-card-body">
      <div class="shimmer-line" style="width:100%"></div>
      <div class="shimmer-line" style="width:70%"></div>
      <div class="shimmer-line" style="width:85%"></div>
    </div>`;

  if (assetsList && assetsList.nextSibling)
    assetsList.parentNode.insertBefore(card, assetsList.nextSibling);
  else
    parent.appendChild(card);
  $('btn-div-refresh')?.addEventListener('click', () => loadDividendCard(true));
  _divCardBuilt = true;
}

async function loadDividendCard(force = false) {
  if (!authToken) return;
  ensureDividendCard();

  const bodyEl = $('div-card-body'); if (!bodyEl) return;
  bodyEl.innerHTML = `
    <div class="shimmer-line" style="width:100%"></div>
    <div class="shimmer-line" style="width:70%"></div>
    <div class="shimmer-line" style="width:85%"></div>`;

  const res = await apiFetch('/portfolio/dividends', { headers: authHeaders() });
  if (!res || !res.ok) {
    bodyEl.innerHTML = '<div class="div-empty">Could not load dividend data.</div>';
    return;
  }
  const data = await res.json();

  if (!data.assets || data.assets.length === 0) {
    bodyEl.innerHTML = `
      <div class="div-empty">Nenhuma posição em ações encontrada.<br>
        <span style="font-size:10px;opacity:.6;">Adicione ações para ver projeções de renda.</span>
      </div>`;
    return;
  }

  bodyEl.innerHTML = `
    <div class="div-income-grid">
      <div class="div-income-cell">
        <div class="div-income-label">Renda Anual</div>
        <div class="div-income-value sensitive-value" id="div-annual">${formatUSD(data.total_annual_income)}</div>
      </div>
      <div class="div-income-cell">
        <div class="div-income-label">Renda Mensal</div>
        <div class="div-income-value sensitive-value" id="div-monthly">${formatUSD(data.total_monthly_income)}</div>
      </div>
    </div>
    ${buildCalendarStrip(data.upcoming_payments)}
    ${buildUpcomingPayments(data.upcoming_payments)}
    <div class="div-section-label">Yield on Cost vs Yield Atual</div>
    ${buildYieldTable(data.assets)}
    ${data.assets.length > 3
      ? `<button class="div-toggle-btn" id="btn-div-toggle-assets">
           ${_divShowAllAssets ? '▲ Mostrar menos' : '▼ Mostrar todos ' + data.assets.length + ' ativos'}
         </button>` : ''}`;

  const toggleBtn = $('btn-div-toggle-assets');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      _divShowAllAssets = !_divShowAllAssets;
      const tableEl = $('div-yield-table-body');
      if (tableEl) tableEl.innerHTML = buildYieldRows(data.assets);
      toggleBtn.textContent = _divShowAllAssets
        ? '▲ Mostrar menos'
        : '▼ Mostrar todos ' + data.assets.length + ' ativos';
    });
  }
  applyVisibilityMask();
}

function buildCalendarStrip(upcoming) {
  const today    = new Date();
  const eventMap = {};
  (upcoming || []).forEach(p => {
    if (p.ex_date) eventMap[p.ex_date.slice(0,10)] = p.symbol;
  });
  const days = [];
  for (let i = 0; i < 30; i++) {
    const d   = new Date(today); d.setDate(today.getDate() + i);
    const key = d.toISOString().slice(0,10);
    const sym = eventMap[key];
    days.push(`
      <div class="div-cal-day ${sym ? 'has-event' : ''}">
        <div class="div-cal-day-num">${d.getDate()}</div>
        <div class="div-cal-day-mon">${MONTHS_SHORT[d.getMonth()]}</div>
        ${sym ? `<div class="div-cal-day-sym">${sym}</div>` : ''}
      </div>`);
  }
  return `
    <div class="div-section-label">Calendário Ex-Date — Próximos 30 Dias</div>
    <div class="div-calendar-strip">${days.join('')}</div>`;
}

function buildUpcomingPayments(upcoming) {
  if (!upcoming || upcoming.length === 0) {
    return `<div class="div-section-label">Próximos Pagamentos (60 dias)</div>
            <div class="div-empty" style="padding:10px 0;">Nenhuma ex-date nos próximos 60 dias.</div>`;
  }
  const rows = upcoming.map(p => `
    <div class="div-upcoming-row">
      <span class="div-upcoming-sym">${p.symbol}</span>
      <span class="div-upcoming-date">Ex: ${p.ex_date ? p.ex_date.slice(0,10) : '—'}</span>
      <span class="div-upcoming-amount sensitive-value">+${formatUSD(p.projected_total)}</span>
      <span class="div-upcoming-badge">Q</span>
    </div>`).join('');
  return `<div class="div-section-label">Próximos Pagamentos (60 dias)</div>
          <div class="div-upcoming-list">${rows}</div>`;
}

function buildYieldTable(assets) {
  return `
    <table class="div-asset-table">
      <thead>
        <tr>
          <th>Símbolo</th><th>Qtd</th><th>Yield Atual</th>
          <th>YoC</th><th>Anual</th><th>Próx. Ex</th>
        </tr>
      </thead>
      <tbody id="div-yield-table-body">${buildYieldRows(assets)}</tbody>
    </table>`;
}

function buildYieldRows(assets) {
  const visible = _divShowAllAssets ? assets : assets.slice(0, 3);
  return visible.map(a => {
    if (!a.pays_dividend) {
      return `<tr>
        <td>${a.symbol}</td><td>${a.shares}</td>
        <td colspan="4"><span class="div-no-dividend">Sem dividendo</span></td>
      </tr>`;
    }
    const yocClass = a.yield_on_cost > a.yield_current ? 'div-yoc-better'
      : a.yield_on_cost === a.yield_current ? 'div-yoc-same' : 'div-yoc-lower';
    return `<tr>
      <td>${a.symbol}</td><td>${a.shares}</td>
      <td>${a.yield_current.toFixed(2)}%</td>
      <td class="${yocClass}">${a.yield_on_cost.toFixed(2)}%</td>
      <td class="sensitive-value">${formatUSD(a.annual_income)}</td>
      <td>${a.next_ex_date ? a.next_ex_date.slice(0,10) : '—'}</td>
    </tr>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════
// INJEÇÃO DE ESTILOS BASE
// ════════════════════════════════════════════════════════════════

function injectBaseStyles() {
  if ($('purp-base-styles')) return;
  const style = document.createElement('style');
  style.id = 'purp-base-styles';
  style.textContent = `
    @keyframes toastIn { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:translateX(0); } }
    @keyframes shimmer { 0%{background-position:-400px 0} 100%{background-position:400px 0} }
    .shimmer-line {
      height:12px; border-radius:6px;
      background:linear-gradient(90deg,rgba(255,255,255,.05) 25%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.05) 75%);
      background-size:400px 100%; animation:shimmer 1.4s infinite linear; margin-bottom:8px;
    }
    .sensitive-value.is-hidden { filter: blur(6px); user-select:none; pointer-events:none; }
    .text-green { color:#10b981; }
    .text-red   { color:#ef4444; }
    .pos        { color:#10b981; }
    .neg        { color:#ef4444; }
    /* Tax tab styles */
    .tax-tab-bar { display:flex;gap:4px;padding:4px;background:rgba(0,0,0,0.3);border-radius:12px;margin-bottom:16px;border:1px solid rgba(255,255,255,0.06); }
    .tax-tab-btn { flex:1;padding:7px 6px;border-radius:9px;border:none;background:transparent;color:rgba(255,255,255,.35);font-size:10px;font-weight:600;cursor:pointer;transition:all .18s ease;text-align:center; }
    .tax-tab-btn .tab-icon { font-size:14px;display:block;margin-bottom:2px; }
    .tax-tab-btn:hover { color:rgba(255,255,255,.6);background:rgba(255,255,255,.05); }
    .tax-tab-btn.active { background:rgba(124,58,237,.25);color:#a78bfa;border:1px solid rgba(124,58,237,.35); }
    .tax-tab-btn.active-gold { background:rgba(245,158,11,.18);color:#fbbf24;border:1px solid rgba(245,158,11,.3); }
    .tax-panel { display:none; }
    .tax-panel.active { display:block; }
    /* Dividend card */
    .div-card { background:rgba(255,255,255,.04);border:1px solid rgba(16,185,129,.2);border-radius:16px;padding:16px;margin-bottom:16px; }
    .div-card-header { display:flex;justify-content:space-between;align-items:center;margin-bottom:14px; }
    .div-card-title { font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#10b981; }
    .div-refresh-btn { background:none;border:none;color:rgba(255,255,255,.3);cursor:pointer;font-size:13px;padding:2px 6px;border-radius:6px; }
    .div-refresh-btn:hover { color:#10b981; }
    .div-income-grid { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px; }
    .div-income-cell { background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.15);border-radius:10px;padding:10px 12px;text-align:center; }
    .div-income-label { font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(16,185,129,.6);margin-bottom:3px; }
    .div-income-value { font-size:17px;font-weight:800;color:#10b981;font-variant-numeric:tabular-nums; }
    .div-section-label { font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,.3);margin:12px 0 6px; }
    .div-upcoming-row { display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;margin-bottom:4px;font-size:11px; }
    .div-upcoming-sym { font-weight:700;color:#f1f0f5;min-width:48px; }
    .div-upcoming-date { color:rgba(255,255,255,.4);font-size:10px; }
    .div-upcoming-amount { color:#10b981;font-weight:700;font-variant-numeric:tabular-nums; }
    .div-upcoming-badge { background:rgba(16,185,129,.15);color:#10b981;border-radius:4px;font-size:8px;font-weight:700;padding:2px 5px; }
    .div-asset-table { width:100%;border-collapse:collapse;font-size:10px;margin-bottom:10px; }
    .div-asset-table th { font-size:8px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:rgba(255,255,255,.3);padding:4px 6px;text-align:right;border-bottom:1px solid rgba(255,255,255,.06); }
    .div-asset-table th:first-child { text-align:left; }
    .div-asset-table td { padding:6px;border-bottom:1px solid rgba(255,255,255,.04);color:rgba(255,255,255,.6);text-align:right;font-variant-numeric:tabular-nums; }
    .div-asset-table td:first-child { text-align:left;color:#f1f0f5;font-weight:600; }
    .div-yoc-better { color:#10b981;font-weight:700; }
    .div-yoc-same { color:#fbbf24; }
    .div-yoc-lower { color:rgba(255,255,255,.4); }
    .div-no-dividend { color:rgba(255,255,255,.25);font-size:9px; }
    .div-calendar-strip { display:flex;gap:4px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none; }
    .div-calendar-strip::-webkit-scrollbar { display:none; }
    .div-cal-day { flex:0 0 38px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:6px 4px;text-align:center; }
    .div-cal-day.has-event { background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.3); }
    .div-cal-day-num { font-weight:700;color:#f1f0f5;font-size:11px; }
    .div-cal-day-mon { color:rgba(255,255,255,.3);font-size:9px;margin-top:1px; }
    .div-cal-day-sym { color:#10b981;font-size:8px;margin-top:3px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:36px; }
    .div-empty { text-align:center;color:rgba(255,255,255,.25);font-size:11px;padding:16px 0; }
    .div-toggle-btn { background:none;border:1px solid rgba(255,255,255,.1);border-radius:6px;color:rgba(255,255,255,.4);font-size:9px;padding:3px 8px;cursor:pointer;transition:all .15s; }
    .div-toggle-btn:hover { border-color:rgba(16,185,129,.4);color:#10b981; }
    /* Form 8949 */
    .form8949-controls { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px; }
    .form8949-controls select { background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:8px;color:#f1f0f5;font-size:11px;padding:8px 10px;width:100%;cursor:pointer;outline:none; }
    .form8949-controls label { font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:4px;display:block; }
    .form8949-section-title { font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,.35);margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid rgba(255,255,255,.06); }
    .form8949-section-title.gold { color:#d97706;border-color:rgba(245,158,11,.2); }
    .form8949-empty { text-align:center;color:rgba(255,255,255,.3);font-size:11px;padding:20px 0; }
    .f49-row { background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:10px 12px;margin-bottom:6px;font-size:11px; }
    .f49-row-top { display:flex;justify-content:space-between;align-items:center;margin-bottom:6px; }
    .f49-symbol { font-weight:700;color:#f1f0f5;font-size:12px; }
    .f49-gain { color:#10b981;font-weight:700;font-variant-numeric:tabular-nums; }
    .f49-loss { color:#ef4444;font-weight:700;font-variant-numeric:tabular-nums; }
    .f49-meta { color:rgba(255,255,255,.35);font-size:10px; }
    .f49-grid { display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;color:rgba(255,255,255,.6); }
    .f49-grid span:nth-child(odd) { color:rgba(255,255,255,.35);font-size:9px; }
    .f49-grid span:nth-child(even) { font-size:10px;font-variant-numeric:tabular-nums; }
    .f49-part-total { display:flex;justify-content:space-between;padding:7px 12px;background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.2);border-radius:8px;font-size:11px;font-weight:700;margin-top:4px;margin-bottom:10px; }
    .btn-download-8949 { width:100%;padding:11px;background:linear-gradient(135deg,#1e1035,#2d1b69);border:1px solid rgba(124,58,237,.5);border-radius:10px;color:#a78bfa;font-size:12px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .18s ease;margin-bottom:8px; }
    .btn-download-8949:hover { background:linear-gradient(135deg,#2d1b69,#3b1fa8);border-color:rgba(124,58,237,.8);transform:translateY(-1px); }
    .turbotax-note { text-align:center;font-size:9px;color:rgba(255,255,255,.3);margin-bottom:14px; }
    .tax-summary-grid { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px; }
    .tax-sum-card { background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px;text-align:center; }
    .tax-sum-card.net-gain { border-color:rgba(16,185,129,.25);background:rgba(16,185,129,.07); }
    .tax-sum-card.net-loss { border-color:rgba(239,68,68,.25);background:rgba(239,68,68,.07); }
    .tax-sum-label { font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,.35);margin-bottom:4px; }
    .tax-sum-value { font-size:15px;font-weight:800;color:#f1f0f5;font-variant-numeric:tabular-nums; }
    .tax-sum-value.green { color:#10b981; }
    .tax-sum-value.red { color:#ef4444; }
    .tax-summary-full { background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px;margin-bottom:8px; }
    .tax-summary-full-title { font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:rgba(255,255,255,.3);margin-bottom:10px; }
    .tax-summary-row { display:flex;justify-content:space-between;padding:4px 0;font-size:12px;border-bottom:1px solid rgba(255,255,255,.04); }
    .tax-summary-row:last-child { border-bottom:none;font-weight:700; }
    .tax-summary-row .label { color:rgba(255,255,255,.6); }
    .tax-summary-row .value { font-variant-numeric:tabular-nums; }
    .bracket-rows { margin-bottom:14px; }
    .bracket-row { display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);margin-bottom:4px;font-size:11px; }
    .bracket-row .bracket-label { color:rgba(255,255,255,.6); }
    .bracket-row .bracket-value { font-weight:700;color:#fbbf24;font-variant-numeric:tabular-nums; }
  `;
  document.head.appendChild(style);
}

// ════════════════════════════════════════════════════════════════
// INICIALIZAÇÃO
// ════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  injectBaseStyles();

  loadSession((hasSession) => {
    if (hasSession) {
      // Verificação de email pendente
      if (currentUser && currentUser.is_verified === false) {
        showVerifyScreen(authToken, currentUser.email || localStorage.getItem('pending_email') || '', (verifiedUser, newToken) => {
          const updated = { ...currentUser, ...verifiedUser, is_verified: true };
          saveSession(newToken || authToken, updated);
          finalizeLoginUI();
        });
      } else {
        finalizeLoginUI();
      }
    } else {
      // Redireciona para login se não há sessão
      if (!window.location.pathname.endsWith('/') && !window.location.pathname.endsWith('index.html')) {
        window.location.href = '/';
        return;
      }
      showLoginScreen();
    }
  });

  // Privacy toggle — sidebar desktop
  updatePrivacyToggle();
  $('btn-privacy-toggle')?.addEventListener('click', () => {
    hideSensitiveValues = !hideSensitiveValues;
    updatePrivacyToggle();
  });

  // Shell navigation (drawer mobile)
  initShellNav();
  bindFeatureGates();
  bindPlanButtons();

  // Auth buttons
  $('btn-login')?.addEventListener('click', handleLogin);
  $('btn-register')?.addEventListener('click', handleRegister);
  $('btn-show-register')?.addEventListener('click', toggleAuthMode);
  $('btn-show-login')?.addEventListener('click', toggleAuthMode);
  $('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  $('reg-password')?.addEventListener('keydown',   e => { if (e.key === 'Enter') handleRegister(); });

  // Logout
  $('nav-logout')?.addEventListener('click', handleLogout);
  $('btn-logout')?.addEventListener('click',  handleLogout);

  // Navegação: links <a href="/home/..."> na sidebar — carregamento de página completa

  // Upgrade
  $('btn-upgrade')?.addEventListener('click',
    () => showUpgradeModal('Desbloqueie ativos ilimitados, análise IA, importação CSV e mais.'));
  $('btn-upgrade-cancel')?.addEventListener('click',  closeGateModal);
  $('btn-upgrade-confirm')?.addEventListener('click', handleUpgrade);
  $('btn-upgrade-tax-pro')?.addEventListener('click', () => showTaxProUpgradeModal());
  $('btn-taxpro-cancel')?.addEventListener('click',   hideTaxProUpgradeModal);
  $('btn-taxpro-confirm')?.addEventListener('click',  handleTaxProUpgrade);

  // Export CSV
  $('btn-export-csv')?.addEventListener('click', exportPortfolioCsv);

  // Dashboard premium: global search, quick actions, bottom nav
  const globalSearchInput = $('global-search');
  if (globalSearchInput) {
    globalSearchInput.addEventListener('input', () => {
      clearTimeout(globalSearchTimer);
      const v = globalSearchInput.value.trim();
      globalSearchTimer = setTimeout(() => performGlobalSearch(v), 280);
    });
    globalSearchInput.addEventListener('focus', () => {
      if (globalSearchInput.value.trim() && $('search-autocomplete')?.children?.length)
        $('search-autocomplete')?.setAttribute('aria-hidden', 'false');
    });
  }
  document.addEventListener('click', e => {
    if ($('search-autocomplete') && !e.target.closest('.dashboard-search-wrap'))
      $('search-autocomplete').setAttribute('aria-hidden', 'true');
  });
  $('btn-register-tx-overview')?.addEventListener('click', () => { window.location.href = '/home/add-asset'; });
  $('btn-quick-register-tx')?.addEventListener('click', () => { window.location.href = '/home/add-asset'; });
  $('btn-quick-ai')?.addEventListener('click', () => handlePortfolioAI());
  $('btn-quick-watchlist')?.addEventListener('click', () => { window.location.href = '/home/market'; });
  $('bottom-nav-search')?.addEventListener('click', () => { $('global-search')?.focus(); });
  $('bottom-nav-ai')?.addEventListener('click', () => handlePortfolioAI());

  // Portfolio AI
  $('btn-portfolio-ai')?.addEventListener('click',      handlePortfolioAI);
  $('btn-share-performance')?.addEventListener('click', sharePerformanceCard);

  // Net worth
  $('btn-net-worth-add')?.addEventListener('click', openNetWorthModal);
  $('btn-nw-cancel')?.addEventListener('click',     closeNetWorthModal);
  $('btn-nw-save')?.addEventListener('click',       saveNetWorthEntry);
  $('modal-net-worth')?.addEventListener('click', e => {
    if (e.target === $('modal-net-worth')) closeNetWorthModal();
  });

  // Rebalance
  $('btn-rebalance-calc')?.addEventListener('click', calculateRebalance);

  // Detail view
  $('btn-back')?.addEventListener('click', () => {
    $('detail-view')?.classList.remove('active');
    _detailSymbolForGuest = null;
  });
  $('btn-detail-add-portfolio')?.addEventListener('click', () => {
    if (_detailSymbolForGuest)
      window.location.href = '/home/add-asset?symbol=' + encodeURIComponent(_detailSymbolForGuest);
  });
  $('btn-detail-add-watchlist')?.addEventListener('click', async () => {
    if (!_detailSymbolForGuest || !authToken) { toast('Faça login para adicionar à watchlist.', 'warning'); return; }
    try {
      const res = await apiFetch('/watchlist', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ symbol: _detailSymbolForGuest }) });
      if (res?.ok) {
        toast(`${_detailSymbolForGuest} adicionado à watchlist.`, 'success');
        watchlistSymbols.add(_detailSymbolForGuest);
        if ($('watchlist-cards')) loadWatchlistCards();
      } else {
        const err = await res?.json().catch(() => ({}));
        toast(err?.detail?.msg || err?.detail || 'Não foi possível adicionar.', 'error');
      }
    } catch (e) { toast('Erro ao adicionar à watchlist.', 'error'); }
  });
  $('detail-ai-refresh')?.addEventListener('click', () => {
    const sym = _detailSymbolForGuest || $('detail-symbol')?.textContent?.trim();
    if (sym) { $('detail-ai-text').textContent = 'Carregando…'; loadDetailAI(sym, _detailLastChange); }
  });
  qsa('.time-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      qsa('.time-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      _detailPeriod = e.target.dataset.period;
      if (_detailSymbol) loadDetailChart(_detailSymbol, _detailPeriod);
    });
  });
  qsa('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const t = e.target.dataset.type;
      if (!t) return;
      detailChartMode = t;
      qsa('.chart-type-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      if (_detailSymbol) loadDetailChart(_detailSymbol, _detailPeriod);
    });
  });

  // Main chart controls
  $('benchmark-select')?.addEventListener('change', () => loadMainChart());
  qsa('.pill').forEach(btn => {
    btn.addEventListener('click', e => {
      qsa('.pill').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      loadMainChart();
    });
  });

  // Add asset
  $('btn-save-asset')?.addEventListener('click', handleAddAsset);

  // ── Inline real-time validation ──────────────────────────────────
  const SYMBOL_RE = /^[A-Z0-9.\-\^]{1,20}$/;

  function _fieldError(id) {
    let span = document.getElementById(`${id}-error`);
    if (!span) {
      const input = document.getElementById(id);
      if (!input) return null;
      span = document.createElement('span');
      span.id = `${id}-error`;
      span.className = 'field-error';
      span.setAttribute('aria-live', 'polite');
      input.parentNode.insertBefore(span, input.nextSibling);
    }
    return span;
  }

  function _setFieldError(id, msg) {
    const span = _fieldError(id);
    const input = document.getElementById(id);
    if (span) span.textContent = msg;
    if (input) {
      input.classList.toggle('input-error', !!msg);
      input.classList.toggle('input-valid', !msg && !!input.value);
    }
  }

  $('symbol-input')?.addEventListener('input', e => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim().toUpperCase();
    selectedAddAssetType = null; setAddAmountInputMode(null);
    if (v && !SYMBOL_RE.test(v)) {
      _setFieldError('symbol-input', 'Invalid symbol — use uppercase letters, numbers, ., - or ^');
    } else {
      _setFieldError('symbol-input', '');
    }
    if (v.length < 2) { if ($('search-dropdown')) $('search-dropdown').style.display = 'none'; return; }
    searchTimer = setTimeout(() => performSearch(v), 380);
  });

  if (window.location.pathname.includes('add-asset')) {
    const params = new URLSearchParams(window.location.search);
    const symParam = params.get('symbol')?.trim().toUpperCase();
    if (symParam && $('symbol-input')) { $('symbol-input').value = symParam; resolveSymbolType(symParam).then(t => { if (t) { selectedAddAssetType = t; setAddAmountInputMode(t); } }); }
  }

  $('amount-input')?.addEventListener('blur', () => {
    const val = parseFloat($('amount-input')?.value);
    const isStock = selectedAddAssetType === 'stock';
    if ($('amount-input')?.value && (isNaN(val) || val <= 0)) {
      _setFieldError('amount-input', 'Amount must be a positive number');
    } else if (isStock && !Number.isInteger(val)) {
      _setFieldError('amount-input', 'Stock quantity must be a whole number');
    } else {
      _setFieldError('amount-input', '');
    }
  });

  $('amount-input')?.addEventListener('input', () => {
    const val = parseFloat($('amount-input')?.value);
    if (!isNaN(val) && val > 0) _setFieldError('amount-input', '');
  });

  $('price-input')?.addEventListener('blur', () => {
    const val = parseFloat($('price-input')?.value);
    if ($('price-input')?.value && (isNaN(val) || val <= 0)) {
      _setFieldError('price-input', 'Price must be a positive number');
    } else {
      _setFieldError('price-input', '');
    }
  });

  $('price-input')?.addEventListener('input', () => {
    const val = parseFloat($('price-input')?.value);
    if (!isNaN(val) && val > 0) _setFieldError('price-input', '');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.input-wrap') && !e.target.closest('#search-dropdown'))
      if ($('search-dropdown')) $('search-dropdown').style.display = 'none';
  });

  // Sell modal
  $('sell-qty')?.addEventListener('input', updateSellEstimate);
  $('btn-max')?.addEventListener('click', () => {
    if (assetForSale) { if ($('sell-qty')) $('sell-qty').value = assetForSale.amount; updateSellEstimate(); }
  });
  $('btn-sell-cancel')?.addEventListener('click',  closeSellModal);
  $('btn-sell-confirm')?.addEventListener('click', confirmSell);
  $('modal-sell')?.addEventListener('click', e => { if (e.target === $('modal-sell')) closeSellModal(); });

  // Alerts
  $('btn-create-alert')?.addEventListener('click', handleCreateAlert);
  $('alert-type-input')?.addEventListener('change', updateAlertFormFields);
  updateAlertFormFields();

  // CSV Import
  $('btn-open-import')?.addEventListener('click', openImportModal);
  $('btn-import-cancel')?.addEventListener('click', closeImportModal);
  $('btn-import-confirm')?.addEventListener('click', handleImportConfirm);
  $('import-broker-select')?.addEventListener('change', handleBrokerSelect);
  $('file-drop-area')?.addEventListener('click', () => $('import-file-input')?.click());
  $('import-file-input')?.addEventListener('change', handleFileSelect);
  const dropArea = $('file-drop-area');
  if (dropArea) {
    dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
    dropArea.addEventListener('drop', e => {
      e.preventDefault(); dropArea.classList.remove('drag-over');
      const file = e.dataTransfer.files?.[0];
      if (file) handleFileSelect({ target: { files: [file] } });
    });
  }
  $('modal-import-csv')?.addEventListener('click', e => {
    if (e.target === $('modal-import-csv')) closeImportModal();
  });

  // Tax tools
  $('btn-refresh-tlh')?.addEventListener('click',     loadTaxLossHarvesting);
  $('tlh-bracket-select')?.addEventListener('change', loadTaxLossHarvesting);
});
