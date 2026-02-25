/* ═══════════════════════════════════════════════════════════════
   Purp — Extension Frontend v6
   New: Form 8949 full UI, tax sub-tabs, redesigned CSS injection
   ════════════════════════════════════════════════════════════════ */

// ── Config ───────────────────────────────────────────────────────
const API_BASE         = 'https://purp-production.up.railway.app';
const FREE_ASSET_LIMIT = 4;
const REFRESH_MS       = 60_000;

// ── State ────────────────────────────────────────────────────────
let authToken        = null;
let currentUser      = null;
let assetForSale     = null;
let mainChart        = null;
let detailChart      = null;
let refreshTimer     = null;
let searchTimer      = null;
let portfolioCount   = 0;
let portfolioSymbols = new Set();
let hideSensitiveValues   = true;
let selectedAddAssetType  = null;
let activeTaxTab          = 'tlh';   // 'tlh' | 'form8949' | 'summary'

let importSelectedFile   = null;
let importSelectedBroker = '';

const FEATURED_STOCKS  = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA'];
const FEATURED_CRYPTOS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];

const $ = (id) => document.getElementById(id);
const formatUSD = (v) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v ?? 0);
const formatPct = (v) => `${v >= 0 ? '+' : ''}${(v || 0).toFixed(2)}%`;

// ══════════════════════════════════════════════════════════════════
// INJECTED CSS — all new styles added here, no external file needed
// ══════════════════════════════════════════════════════════════════
function injectStyles() {
  if (document.getElementById('purp-styles')) return; // Já injetado
  const style = document.createElement('style');
  style.id = 'purp-styles';
  style.textContent = `
    /* ── Tax sub-tab navigation ───────────────────────────────── */
    .tax-tab-bar {
      display: flex;
      gap: 4px;
      padding: 4px;
      background: rgba(0,0,0,0.3);
      border-radius: 12px;
      margin-bottom: 16px;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .tax-tab-btn {
      flex: 1;
      padding: 7px 6px;
      border-radius: 9px;
      border: none;
      background: transparent;
      color: var(--text3, rgba(255,255,255,0.35));
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.3px;
      cursor: pointer;
      transition: all 0.18s ease;
      text-align: center;
      line-height: 1.3;
    }
    .tax-tab-btn .tab-icon { font-size: 14px; display: block; margin-bottom: 2px; }
    .tax-tab-btn:hover { color: var(--text2, rgba(255,255,255,0.6)); background: rgba(255,255,255,0.05); }
    .tax-tab-btn.active {
      background: rgba(124,58,237,0.25);
      color: #a78bfa;
      border: 1px solid rgba(124,58,237,0.35);
    }
    .tax-tab-btn.active-gold {
      background: rgba(245,158,11,0.18);
      color: #fbbf24;
      border: 1px solid rgba(245,158,11,0.3);
    }
    .tax-panel { display: none; }
    .tax-panel.active { display: block; }

    /* ── Form 8949 controls ───────────────────────────────────── */
    .form8949-controls {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 14px;
    }
    .form8949-controls select {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      color: var(--text, #f1f0f5);
      font-size: 11px;
      padding: 8px 10px;
      width: 100%;
      cursor: pointer;
      outline: none;
      transition: border-color 0.15s;
    }
    .form8949-controls select:focus { border-color: rgba(124,58,237,0.5); }
    .form8949-controls label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text3, rgba(255,255,255,0.35));
      margin-bottom: 4px;
      display: block;
    }

    /* ── Tax summary card ─────────────────────────────────────── */
    .tax-summary-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 14px;
    }
    .tax-sum-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 12px;
      text-align: center;
    }
    .tax-sum-card.net-gain { border-color: rgba(16,185,129,0.25); background: rgba(16,185,129,0.07); }
    .tax-sum-card.net-loss { border-color: rgba(239,68,68,0.25);  background: rgba(239,68,68,0.07);  }
    .tax-sum-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text3, rgba(255,255,255,0.35));
      margin-bottom: 4px;
    }
    .tax-sum-value {
      font-size: 15px;
      font-weight: 800;
      color: #f1f0f5;
      font-variant-numeric: tabular-nums;
    }
    .tax-sum-value.green { color: #10b981; }
    .tax-sum-value.red   { color: #ef4444; }
    .tax-sum-value.gold  { color: #fbbf24; }

    /* ── Bracket estimate rows ────────────────────────────────── */
    .bracket-rows { margin-bottom: 14px; }
    .bracket-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      margin-bottom: 4px;
      font-size: 11px;
    }
    .bracket-row .bracket-label { color: var(--text2, rgba(255,255,255,0.6)); }
    .bracket-row .bracket-value { font-weight: 700; color: #fbbf24; font-variant-numeric: tabular-nums; }

    /* ── Form 8949 table ──────────────────────────────────────── */
    .form8949-section-title {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text3, rgba(255,255,255,0.35));
      margin: 12px 0 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .form8949-section-title.gold { color: #d97706; border-color: rgba(245,158,11,0.2); }
    .form8949-empty {
      text-align: center;
      color: var(--text3, rgba(255,255,255,0.3));
      font-size: 11px;
      padding: 20px 0;
    }
    .f49-row {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 6px;
      font-size: 11px;
    }
    .f49-row-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .f49-symbol {
      font-weight: 700;
      color: #f1f0f5;
      font-size: 12px;
    }
    .f49-gain  { color: #10b981; font-weight: 700; font-variant-numeric: tabular-nums; }
    .f49-loss  { color: #ef4444; font-weight: 700; font-variant-numeric: tabular-nums; }
    .f49-meta  { color: var(--text3, rgba(255,255,255,0.35)); font-size: 10px; }
    .f49-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 12px;
      color: var(--text2, rgba(255,255,255,0.6));
    }
    .f49-grid span:nth-child(odd) { color: var(--text3, rgba(255,255,255,0.35)); font-size: 9px; }
    .f49-grid span:nth-child(even) { font-size: 10px; font-variant-numeric: tabular-nums; }
    .f49-part-total {
      display: flex;
      justify-content: space-between;
      padding: 7px 12px;
      background: rgba(124,58,237,0.1);
      border: 1px solid rgba(124,58,237,0.2);
      border-radius: 8px;
      font-size: 11px;
      font-weight: 700;
      margin-top: 4px;
      margin-bottom: 10px;
    }

    /* ── Download CTA button ──────────────────────────────────── */
    .btn-download-8949 {
      width: 100%;
      padding: 11px;
      background: linear-gradient(135deg, #1e1035, #2d1b69);
      border: 1px solid rgba(124,58,237,0.5);
      border-radius: 10px;
      color: #a78bfa;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.18s ease;
      margin-bottom: 8px;
    }
    .btn-download-8949:hover {
      background: linear-gradient(135deg, #2d1b69, #3b1fa8);
      border-color: rgba(124,58,237,0.8);
      transform: translateY(-1px);
    }
    .btn-download-8949:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .turbotax-note {
      text-align: center;
      font-size: 9px;
      color: var(--text3, rgba(255,255,255,0.3));
      margin-bottom: 14px;
    }

    /* ── Tax summary full-width cards ─────────────────────────── */
    .tax-summary-full {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 14px;
      margin-bottom: 8px;
    }
    .tax-summary-full-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text3, rgba(255,255,255,0.3));
      margin-bottom: 10px;
    }
    .tax-summary-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      font-size: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .tax-summary-row:last-child { border-bottom: none; font-weight: 700; }
    .tax-summary-row .label { color: var(--text2, rgba(255,255,255,0.6)); }
    .tax-summary-row .value { font-variant-numeric: tabular-nums; }


    /* ── Dividend Income Card ────────────────────────────────── */
    .div-card {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(16,185,129,0.2);
      border-radius: 16px; padding: 16px; margin-bottom: 16px;
    }
    .div-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .div-card-title { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: #10b981; }
    .div-refresh-btn { background: none; border: none; color: rgba(255,255,255,0.3); cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 6px; transition: color 0.15s; }
    .div-refresh-btn:hover { color: #10b981; }
    .div-income-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
    .div-income-cell { background: rgba(16,185,129,0.07); border: 1px solid rgba(16,185,129,0.15); border-radius: 10px; padding: 10px 12px; text-align: center; }
    .div-income-label { font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: rgba(16,185,129,0.6); margin-bottom: 3px; }
    .div-income-value { font-size: 17px; font-weight: 800; color: #10b981; font-variant-numeric: tabular-nums; }
    .div-section-label { font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: rgba(255,255,255,0.3); margin: 12px 0 6px; }
    .div-upcoming-list { margin-bottom: 14px; }
    .div-upcoming-row { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; margin-bottom: 4px; font-size: 11px; }
    .div-upcoming-sym { font-weight: 700; color: #f1f0f5; min-width: 48px; }
    .div-upcoming-date { color: rgba(255,255,255,0.4); font-size: 10px; }
    .div-upcoming-amount { color: #10b981; font-weight: 700; font-variant-numeric: tabular-nums; }
    .div-upcoming-badge { background: rgba(16,185,129,0.15); color: #10b981; border-radius: 4px; font-size: 8px; font-weight: 700; padding: 2px 5px; }
    .div-asset-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; }
    .div-asset-table th { font-size: 8px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; color: rgba(255,255,255,0.3); padding: 4px 6px; text-align: right; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .div-asset-table th:first-child { text-align: left; }
    .div-asset-table td { padding: 6px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); color: rgba(255,255,255,0.6); text-align: right; font-variant-numeric: tabular-nums; }
    .div-asset-table td:first-child { text-align: left; color: #f1f0f5; font-weight: 600; }
    .div-asset-table tr:last-child td { border-bottom: none; }
    .div-yoc-better { color: #10b981; font-weight: 700; }
    .div-yoc-same   { color: #fbbf24; }
    .div-yoc-lower  { color: rgba(255,255,255,0.4); }
    .div-no-dividend { color: rgba(255,255,255,0.25); font-size: 9px; }
    .div-calendar-strip { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }
    .div-calendar-strip::-webkit-scrollbar { display: none; }
    .div-cal-day { flex: 0 0 38px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 6px 4px; text-align: center; }
    .div-cal-day.has-event { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.3); }
    .div-cal-day-num { font-weight: 700; color: #f1f0f5; font-size: 11px; }
    .div-cal-day-mon { color: rgba(255,255,255,0.3); font-size: 9px; margin-top: 1px; }
    .div-cal-day-sym { color: #10b981; font-size: 8px; margin-top: 3px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 36px; }
    .div-empty { text-align: center; color: rgba(255,255,255,0.25); font-size: 11px; padding: 16px 0; }
    .div-toggle-btn { background: none; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: rgba(255,255,255,0.4); font-size: 9px; padding: 3px 8px; cursor: pointer; transition: all 0.15s; }
    .div-toggle-btn:hover { border-color: rgba(16,185,129,0.4); color: #10b981; }

    /* ── Loading shimmer ──────────────────────────────────────── */
    @keyframes shimmer {
      0%   { background-position: -400px 0; }
      100% { background-position:  400px 0; }
    }
    .shimmer-line {
      height: 12px;
      border-radius: 6px;
      background: linear-gradient(90deg,
        rgba(255,255,255,0.05) 25%,
        rgba(255,255,255,0.12) 50%,
        rgba(255,255,255,0.05) 75%);
      background-size: 400px 100%;
      animation: shimmer 1.4s infinite linear;
      margin-bottom: 8px;
    }
  `;
  document.head.appendChild(style);
}

function applyVisibilityMask() {
  document.querySelectorAll('.sensitive-value').forEach((el) =>
    el.classList.toggle('is-hidden', hideSensitiveValues)
  );
}
function updatePrivacyToggle() {
  const icon = $('privacy-icon');
  if (icon) icon.textContent = hideSensitiveValues ? '🙈' : '👁️';
  applyVisibilityMask();
}

// ── TOAST ────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

function showError(elId, msg) { const el = $(elId); if (!el) return; el.textContent = msg; el.classList.remove('hidden'); }
function clearError(elId)     { const el = $(elId); if (!el) return; el.textContent = ''; el.classList.add('hidden'); }

function authHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', ...(authToken ? { 'X-Auth-Token': authToken } : {}), ...extra };
}

function saveSession(token, user) {
  authToken = token; currentUser = user;
  chrome.storage.local.set({ purp_token: token, purp_user: JSON.stringify(user) });
}
function loadSession(callback) {
  chrome.storage.local.get(['purp_token', 'purp_user'], (result) => {
    if (result.purp_token && result.purp_user) {
      try { authToken = result.purp_token; currentUser = JSON.parse(result.purp_user); callback(true); }
      catch (e) { callback(false); }
    } else { callback(false); }
  });
}
function clearSession() {
  authToken = null; currentUser = null; portfolioCount = 0; portfolioSymbols = new Set();
  stopRefresh(); chrome.storage.local.remove(['purp_token', 'purp_user']);
}
function isPremium() { return !!currentUser?.is_premium; }
function isTaxPro()  { return currentUser?.plan === 'tax_pro'; }

async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401) {
      clearSession(); showLoginScreen(); toast('Session expired — please sign in again', 'warning'); return null;
    }
    return res;
  } catch (e) { console.error('Network error:', e); return null; }
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (!authToken) return;
    fetchPortfolio(); loadMainChart(true);
    loadDividendCard();
    if ($('market-watch')?.classList.contains('active')) loadMarketWatch();
  }, REFRESH_MS);
}
function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

function showLoginScreen() { $('login-screen').classList.remove('hidden'); }
function hideLoginScreen() { $('login-screen').classList.add('hidden'); }

// ── LOGIN / REGISTER ─────────────────────────────────────────────
async function handleLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  clearError('login-error');
  if (!username || !password) { showError('login-error', 'Please fill in username and password'); return; }

  const btn = $('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username, password }),
    });
    if (!res) return;

    if (res.ok) {
      const data = await res.json();
      saveSession(data.token, data.user);

      if (data.requires_verification) {
        const emailForVerify = data.user?.email || username;
        showVerifyScreen(data.token, emailForVerify, (verifiedUser) => {
          const updatedUser = { ...currentUser, ...verifiedUser, is_verified: true };
          saveSession(authToken, updatedUser);
          hideLoginScreen();
          updateProfileBar();
          fetchPortfolio();
          loadMainChart();
          startRefresh();
          checkAIStatus();
          toast('Email verified! Welcome to Purp 🎉', 'success', 5000);
        });
        return;
      }

      hideLoginScreen();
      updateProfileBar();
      fetchPortfolio();
      loadMainChart();
      startRefresh();
      checkAIStatus();
    } else {
      const err = await res.json().catch(() => ({}));
      showError('login-error', err.detail || 'Incorrect username or password');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function handleRegister() {
  const username = $('reg-username').value.trim();
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;
  clearError('register-error');

  if (!username || !email || !password) { showError('register-error', 'All fields are required'); return; }
  if (username.length < 3) { showError('register-error', 'Username must be at least 3 characters'); return; }
  if (password.length < 4) { showError('register-error', 'Password must be at least 4 characters'); return; }
  if (!email.includes('@')) { showError('register-error', 'Enter a valid email address'); return; }

  const btn = $('btn-register');
  btn.disabled = true;
  btn.textContent = 'Creating account…';

  try {
    let res;
    try {
      res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password }),
      });
    } catch (networkErr) {
      showError('register-error', `Network error: ${networkErr.message}`);
      return;
    }

    if (res.ok) {
      const data = await res.json();
      saveSession(data.token, data.user);

      if (data.requires_verification) {
        const emailForVerify = data.user?.email || email;
        showVerifyScreen(data.token, emailForVerify, (verifiedUser) => {
          const updatedUser = { ...currentUser, ...verifiedUser, is_verified: true };
          saveSession(authToken, updatedUser);
          hideLoginScreen();
          updateProfileBar();
          fetchPortfolio();
          loadMainChart();
          startRefresh();
          checkAIStatus();
          toast('Account created & verified! Welcome to Purp 🎉', 'success', 5000);
        });
        return;
      }

      hideLoginScreen();
      updateProfileBar();
      fetchPortfolio();
      loadMainChart();
      startRefresh();
      checkAIStatus();
      toast('Account created! 🎉', 'success', 5000);
    } else {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        errMsg = errBody.detail || errBody.message || JSON.stringify(errBody);
      } catch {}
      showError('register-error', errMsg);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

// ── PROFILE BAR ──────────────────────────────────────────────────
function updateProfileBar() {
  const name = currentUser?.username || '—';
  $('profile-username').textContent = name;
  $('profile-avatar').textContent   = name.charAt(0).toUpperCase();
  const plan = currentUser?.plan || 'free';
  const planEl = $('profile-plan');
  if (plan === 'tax_pro') {
    planEl.textContent = 'Tax Pro'; planEl.className = 'plan-badge tax-pro';
  } else if (plan === 'investor') {
    planEl.textContent = 'Investor'; planEl.className = 'plan-badge premium';
  } else {
    planEl.textContent = 'Free'; planEl.className = 'plan-badge';
  }
  $('profile-count').textContent = isPremium() ? `${portfolioCount} assets` : `${portfolioCount}/${FREE_ASSET_LIMIT} assets`;
  $('btn-upgrade').style.display = isPremium() ? 'none' : '';
  const importCard = $('import-csv-card');
  if (importCard) importCard.style.display = isPremium() ? '' : 'none';
  updateTaxToolsVisibility();
}

// ── UPGRADE MODAL ────────────────────────────────────────────────
function showUpgradeModal(reason) { $('upgrade-reason').textContent = reason || 'Unlock advanced features.'; $('modal-upgrade').classList.add('active'); }
function hideUpgradeModal() { $('modal-upgrade').classList.remove('active'); }
async function handleUpgrade() {
  hideUpgradeModal();
  const btn = $('btn-upgrade-confirm'); btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const res = await apiFetch('/stripe/create-checkout', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ plan: 'investor' }) });
    if (!res) return;
    if (res.ok) { const data = await res.json(); if (data.checkout_url) window.open(data.checkout_url, '_blank'); }
    else { const err = await res.json().catch(() => ({})); toast(err.detail || 'Could not initiate payment.', 'error'); }
  } finally { btn.disabled = false; btn.textContent = 'Get Premium'; }
}

// ── MENU / TABS ──────────────────────────────────────────────────
function closeMenu() { $('nav-menu').classList.add('hidden'); $('btn-hamburger').classList.remove('open'); }

function switchTab(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $(id)?.classList.add('active');
  $('top-tab-dashboard')?.classList.toggle('active', ['dashboard','add-asset','transactions-page'].includes(id));
  $('top-tab-market')?.classList.toggle('active', id === 'market-watch');
  $('nav-portfolio').classList.toggle('active', id === 'dashboard');
  $('nav-add').classList.toggle('active', id === 'add-asset');
  $('nav-transactions')?.classList.toggle('active', id === 'transactions-page');
  if (id === 'dashboard') loadMainChart();
  if (id === 'transactions-page') loadTransactions();
  if (id === 'market-watch') loadMarketWatch();
  if (id === 'add-asset') loadAlerts();
}

// ── MAIN CHART ───────────────────────────────────────────────────
async function loadMainChart(skipAnim = false) {
  if (!authToken) return;
  const ctx = $('mainChart')?.getContext('2d');
  if (!ctx) return;
  if (mainChart) { mainChart.destroy(); mainChart = null; }
  const period = document.querySelector('.pill.active')?.dataset.p || '1mo';
  const bench  = $('benchmark-select')?.value || '^GSPC';
  const res = await apiFetch(`/portfolio/history?period=${period}&benchmark=${encodeURIComponent(bench)}`, { headers: authHeaders() });
  if (!res || !res.ok) return;
  const data = await res.json();
  if (!data.portfolio?.length) return;
  const s0 = data.portfolio[0], b0 = data.benchmark[0] || 1;
  const normP = data.portfolio.map((v) => ((v - s0) / (s0 || 1)) * 100);
  const normB = data.benchmark.map((v) => ((v - b0) / (b0 || 1)) * 100);
  const benchChange = normB.length ? normB[normB.length - 1] : 0;
  const benchEl = $('benchmark-change');
  if (benchEl) {
    benchEl.textContent = `Benchmark: ${formatPct(benchChange)}`;
    benchEl.classList.toggle('pos', benchChange > 0); benchEl.classList.toggle('neg', benchChange < 0);
  }
  mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dates,
      datasets: [
        { label: 'Portfolio', data: normP, borderColor: '#a78bfa', borderWidth: 2, pointRadius: 0, tension: 0.4 },
        { label: bench, data: normB, borderColor: '#444', borderWidth: 1, borderDash: [4,4], pointRadius: 0, tension: 0.4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: skipAnim ? false : { duration: 400 },
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
  applyVisibilityMask();
}

// ── DETAIL CHART ─────────────────────────────────────────────────
async function loadDetailChart(symbol, period) {
  const ctx = $('detailChart')?.getContext('2d');
  if (!ctx) return;
  if (detailChart) { detailChart.destroy(); detailChart = null; }
  const res = await apiFetch(`/history/${encodeURIComponent(symbol)}?period=${period}`);
  if (!res || !res.ok) return;
  const data = await res.json();
  if (!data.prices?.length) return;
  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, 'rgba(124,58,237,0.4)'); grad.addColorStop(1, 'rgba(124,58,237,0)');
  detailChart = new Chart(ctx, {
    type: 'line',
    data: { labels: data.dates || [], datasets: [{ data: data.prices, borderColor: '#7c3aed', backgroundColor: grad, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, fill: true, tension: 0.4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { display: true, position: 'right', grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: 'rgba(255,255,255,0.3)', font: { family: 'DM Mono', size: 9 } } } },
    },
  });
  applyVisibilityMask();
}

function renderSpark(canvasId, data, color) {
  const ctx = $(canvasId)?.getContext('2d');
  if (!ctx || !data?.length) return;
  new Chart(ctx, {
    type: 'line',
    data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: false }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false },
  });
}

// ── SEARCH ───────────────────────────────────────────────────────
async function performSearch(q) {
  const box = $('search-dropdown');
  if (!q || q.length < 2) { box.style.display = 'none'; return; }
  try {
    const res = await apiFetch(`/search?q=${encodeURIComponent(q)}`);
    if (!res || !res.ok) { box.style.display = 'none'; return; }
    const results = await res.json();
    box.innerHTML = '';
    if (!results.length) { box.style.display = 'none'; return; }
    results.forEach((item) => {
      const sym2 = (item.symbol || '').substring(0, 2).toUpperCase();
      let iconHtml = item.icon
        ? `<img class="search-item-icon" src="${item.icon}" alt="${item.symbol}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="search-item-fb" style="display:none;">${sym2}</div>`
        : `<div class="search-item-fb">${sym2}</div>`;
      const row = document.createElement('div');
      row.className = 'search-item';
      row.innerHTML = `${iconHtml}<span class="search-item-name">${item.symbol}</span><span class="search-item-sub">${item.name || ''}</span><span class="search-tag">${item.type || ''}</span>`;
      row.addEventListener('click', () => {
        $('symbol-input').value = item.symbol;
        selectedAddAssetType = (item.type || '').toUpperCase().includes('CRYPTO') ? 'crypto' : 'stock';
        setAddAmountInputMode(selectedAddAssetType); box.style.display = 'none';
      });
      box.appendChild(row);
    });
    box.style.display = 'block';
  } catch (e) { console.error('Search error:', e); box.style.display = 'none'; }
}

function setAddAmountInputMode(type) {
  const input = $('amount-input'); if (!input) return;
  const isStock = (type || '').toLowerCase() === 'stock';
  input.step = isStock ? '1' : 'any'; input.placeholder = isStock ? '1' : '0.5';
}

async function resolveSymbolType(symbol) {
  const sym = (symbol || '').trim().toUpperCase();
  if (!sym) return null;
  const res = await apiFetch(`/search?q=${encodeURIComponent(sym)}`);
  if (!res || !res.ok) return null;
  const results = await res.json();
  const exact = results.find((r) => (r.symbol || '').toUpperCase() === sym);
  const t = (exact?.type || '').toUpperCase();
  if (t.includes('CRYPTO')) return 'crypto';
  if (t.includes('STOCK') || t.includes('EQUITY') || t.includes('ETF') || t.includes('INDEX')) return 'stock';
  return null;
}

// ── MARKET WATCH ─────────────────────────────────────────────────
async function fetchQuoteForSymbol(symbol) {
  const res = await apiFetch(`/history/${encodeURIComponent(symbol)}?period=1d`);
  if (!res || !res.ok) return null;
  const data = await res.json();
  const prices = data.prices || [];
  if (!prices.length) return null;
  const first = prices[0] || 0, last = prices[prices.length - 1] || 0;
  const pct = first > 0 ? ((last - first) / first) * 100 : 0;
  return { symbol, price: last, pct };
}

function renderMarketRows(containerId, rows) {
  const root = $(containerId); if (!root) return; root.innerHTML = '';
  if (!rows.length) { root.innerHTML = '<div class="empty-sub">Unable to load quotes right now.</div>'; return; }
  rows.forEach((item) => {
    const isUp = (item.pct || 0) >= 0;
    const row = document.createElement('div');
    row.className = 'market-row';
    row.innerHTML = `<span class="market-symbol">${item.symbol}</span><span class="market-price sensitive-value">${formatUSD(item.price)}</span><span class="market-change ${isUp ? 'text-green' : 'text-red'}">${formatPct(item.pct)}</span>`;
    root.appendChild(row);
  });
  applyVisibilityMask();
}

async function loadMarketWatch() {
  const [stocks, cryptos] = await Promise.all([
    Promise.all(FEATURED_STOCKS.map((s) => fetchQuoteForSymbol(s))),
    Promise.all(FEATURED_CRYPTOS.map((s) => fetchQuoteForSymbol(s))),
  ]);
  renderMarketRows('market-stocks-list', stocks.filter(Boolean));
  renderMarketRows('market-cryptos-list', cryptos.filter(Boolean));
}

async function loadBalancePerformance() {
  if (!authToken) return;
  const periods = ['1mo', '6mo', '1y'];
  const updates = await Promise.all(periods.map(async (period) => {
    const res = await apiFetch(`/portfolio/history?period=${period}&benchmark=%5EGSPC`, { headers: authHeaders() });
    if (!res || !res.ok) return { period, value: null };
    const data = await res.json();
    const prices = data.portfolio || [];
    if (prices.length < 2 || !prices[0]) return { period, value: 0 };
    return { period, value: ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100 };
  }));
  updates.forEach(({ period, value }) => {
    const pill = document.querySelector(`.perf-pill[data-period="${period}"]`); if (!pill) return;
    const label = period === '1mo' ? '1M' : period === '6mo' ? '6M' : '12M';
    if (value == null || Number.isNaN(value)) { pill.textContent = `${label}: —`; pill.classList.remove('pos','neg'); return; }
    pill.textContent = `${label}: ${formatPct(value)}`;
    pill.classList.toggle('pos', value > 0); pill.classList.toggle('neg', value < 0);
  });
  applyVisibilityMask();
}

async function loadTransactions() {
  if (!authToken) return;
  const res = await apiFetch('/transactions', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const txs = await res.json();
  const list = $('transactions-list'); if (!list) return; list.innerHTML = '';
  if (!txs.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🧾</div><div class="empty-title">No transactions yet</div><div class="empty-sub">Your buy and sell operations will appear here.</div></div>`;
    return;
  }
  txs.forEach((tx) => {
    const pnl = tx.realized_pnl;
    const pnlClass = pnl == null ? '' : pnl >= 0 ? 'text-green' : 'text-red';
    const pnlText  = pnl == null ? '—' : `${pnl >= 0 ? '+' : ''}${formatUSD(pnl)}`;
    const row = document.createElement('div');
    row.className = 'tx-item';
    row.innerHTML = `
      <div class="tx-top"><span class="tx-symbol">${tx.symbol}</span><span class="tx-type ${tx.type}">${tx.type}</span></div>
      <div class="tx-meta"><span>${tx.date}</span><span>${tx.amount} @ ${formatUSD(tx.price)}</span></div>
      <div class="tx-meta" style="margin-top:6px;"><span class="sensitive-value">Total: ${formatUSD(tx.total_usd)}</span><span class="${pnlClass}">P&L: ${pnlText}</span></div>`;
    list.appendChild(row);
  });
  applyVisibilityMask();
}

async function checkAIStatus() {
  const res = await apiFetch('/analysis/status');
  if (!res || !res.ok) return;
  const info = await res.json();
  if (!info.enabled) toast('AI unavailable: configure GEMINI_API_KEY in backend.', 'warning', 5500);
}

// ── CSV EXPORT ───────────────────────────────────────────────────
function csvCell(v) { const val = v == null ? '' : String(v); if (/[",\n]/.test(val)) return `"${val.replace(/"/g,'""')}"`; return val; }

async function exportPortfolioCsv() {
  if (!authToken) { showLoginScreen(); return; }
  const [balanceRes, txRes] = await Promise.all([
    apiFetch('/portfolio/balance', { headers: authHeaders() }),
    apiFetch('/transactions',      { headers: authHeaders() }),
  ]);
  if (!balanceRes || !balanceRes.ok) { toast('Unable to export CSV right now.', 'error'); return; }
  const balance = await balanceRes.json();
  const txs     = (txRes && txRes.ok) ? await txRes.json() : [];
  const rows = [];
  rows.push(['Section','Symbol','Quantity','Avg Buy USD','Current USD','Position USD','P&L USD','Change %']);
  (balance.assets || []).forEach((a) => rows.push(['asset', a.symbol, a.amount, a.purchase_price, a.current_price, a.position_value, a.profit, a.percent_change]));
  rows.push([]);
  rows.push(['Section','Date','Symbol','Type','Amount','Price USD','Total USD','Realized P&L']);
  txs.forEach((tx) => rows.push(['transaction', tx.date, tx.symbol, tx.type, tx.amount, tx.price, tx.total_usd, tx.realized_pnl]));
  const csv  = rows.map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const now  = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
  const a    = document.createElement('a');
  a.href = url; a.download = `purp-portfolio-${now}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  toast('CSV exported successfully.', 'success');
}

// ── PORTFOLIO ────────────────────────────────────────────────────
async function fetchPortfolio() {
  if (!authToken) return;
  const res = await apiFetch('/portfolio/balance', { headers: authHeaders() });
  if (!res || !res.ok) return;
  const data = await res.json();
  const balanceEl = $('total-balance');
  balanceEl.textContent = formatUSD(data.total_balance_usd);
  balanceEl.classList.add('sensitive-value');
  portfolioCount   = (data.assets || []).length;
  portfolioSymbols = new Set((data.assets || []).map((a) => (a.real_symbol || a.symbol || '').toUpperCase()));
  updateProfileBar();
  const list = $('assets-list'); list.innerHTML = '';
  if (!data.assets?.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">Portfolio is empty</div><div class="empty-sub">Add your first asset using the menu above to start tracking your investments.</div></div>`;
    return;
  }
  await loadBalancePerformance();
  data.assets.forEach((asset) => {
    const profit   = asset.profit ?? 0;
    const isProfit = profit >= 0;
    const pctTxt   = asset.percent_change != null ? `${asset.percent_change >= 0 ? '+' : ''}${asset.percent_change.toFixed(2)}%` : '';
    const sym2     = (asset.symbol || '').substring(0, 2).toUpperCase();
    let iconHtml = asset.icon
      ? `<img class="asset-icon-img" src="${asset.icon}" alt="${asset.symbol}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="asset-icon-fb" style="display:none;">${sym2}</div>`
      : `<div class="asset-icon-fb">${sym2}</div>`;
    const wrapper = document.createElement('div');
    wrapper.className = 'asset-wrapper';
    wrapper.innerHTML = `
      <div class="asset-main">
        <div class="asset-left"><div class="asset-icon-wrap">${iconHtml}</div>
          <div><div class="asset-name">${asset.symbol}</div>
            <div class="asset-price"><span class="sensitive-value">${formatUSD(asset.current_price)}</span><span class="${isProfit ? 'text-green' : 'text-red'}">${pctTxt}</span></div>
          </div>
        </div>
        <div class="asset-spark"><canvas id="spark-${asset.id}"></canvas></div>
        <div class="asset-values">
          <div class="asset-val sensitive-value">${formatUSD(asset.position_value)}</div>
          <div class="asset-profit sensitive-value ${isProfit ? 'text-green' : 'text-red'}">${isProfit ? '+' : ''}${formatUSD(profit)}</div>
        </div>
      </div>
      <div class="action-bar">
        <button class="action-btn ai"   data-id="${asset.id}">✨ AI Analysis</button>
        <button class="action-btn sell" data-id="${asset.id}">📉 Sell</button>
      </div>
      <div class="ai-result" id="ai-res-${asset.id}"></div>`;
    wrapper.querySelector('.asset-main').addEventListener('click', () => openDetail(asset));
    wrapper.querySelector('.action-btn.sell').addEventListener('click', (e) => { e.stopPropagation(); openSellModal(asset); });
    wrapper.querySelector('.action-btn.ai').addEventListener('click',   (e) => { e.stopPropagation(); requestAssetAI(asset); });
    list.appendChild(wrapper);
    renderSpark(`spark-${asset.id}`, asset.history || [], isProfit ? '#10b981' : '#ef4444');
  });
  applyVisibilityMask();
  // Trigger dividend card load (non-blocking)
  loadDividendCard();
  loadAlerts();
}

// ── DETAIL VIEW ──────────────────────────────────────────────────
function openDetail(asset) {
  const view = $('detail-view'); view.classList.add('active');
  $('detail-symbol').textContent = asset.symbol;
  $('detail-price').textContent  = formatUSD(asset.current_price);
  $('detail-price').classList.add('sensitive-value');
  $('holding-badge').textContent = `${asset.days_held ?? 0} days held`;
  const imgEl = $('detail-icon-img'), fbEl = $('detail-icon-fb');
  fbEl.textContent = (asset.symbol || '').substring(0, 2).toUpperCase();
  if (asset.icon) {
    imgEl.src = asset.icon; imgEl.style.display = 'block'; fbEl.style.display = 'none';
    imgEl.onerror = () => { imgEl.style.display = 'none'; fbEl.style.display = 'flex'; };
  } else { imgEl.style.display = 'none'; fbEl.style.display = 'flex'; }
  document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.time-btn[data-period="1mo"]')?.classList.add('active');
  loadDetailChart(asset.real_symbol || asset.symbol, '1mo');
}

// ── SELL MODAL ───────────────────────────────────────────────────
function openSellModal(asset) {
  assetForSale = asset;
  const qty = $('sell-qty');
  qty.value = asset.amount; qty.max = asset.amount;
  qty.step  = (asset.type || '').toLowerCase() === 'stock' ? '1' : 'any';
  $('sell-info').textContent = `Held: ${asset.amount}  •  Avg cost: ${formatUSD(asset.purchase_price)}`;
  updateSellEstimate(); $('modal-sell').classList.add('active');
}
function closeSellModal() { $('modal-sell').classList.remove('active'); assetForSale = null; }
function updateSellEstimate() {
  if (!assetForSale) return;
  let qty = parseFloat($('sell-qty').value) || 0;
  if (qty > assetForSale.amount) { qty = assetForSale.amount; $('sell-qty').value = qty; }
  if (qty < 0) qty = 0;
  const total = qty * assetForSale.current_price;
  const pnl   = (assetForSale.current_price - assetForSale.purchase_price) * qty;
  const isWin = pnl >= 0;
  $('sell-estimate').innerHTML = `<span class="sensitive-value">${formatUSD(total)}</span><br><span class="${isWin ? 'text-green' : 'text-red'}" style="font-size:13px;">${isWin ? '+' : ''}${formatUSD(pnl)}</span>`;
  applyVisibilityMask();
}
async function confirmSell() {
  if (!assetForSale || !authToken) return;
  const qty = parseFloat($('sell-qty').value);
  if (!qty || qty <= 0) { toast('Enter a valid amount to sell', 'warning'); return; }
  if ((assetForSale.type || '').toLowerCase() === 'stock' && !Number.isInteger(qty)) { toast('For stocks, sell quantity must be an integer.', 'warning'); return; }
  const btn = $('btn-sell-confirm'); btn.disabled = true; btn.textContent = '…';
  try {
    const res = await apiFetch(`/assets/${assetForSale.id}/sell`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount: qty }) });
    if (!res) return;
    if (res.ok) {
      const data = await res.json();
      const pnl  = data.pnl ?? 0;
      toast(`Sold! P&L: ${pnl >= 0 ? '+' : ''}${formatUSD(pnl)}`, pnl >= 0 ? 'success' : 'info');
      closeSellModal(); fetchPortfolio(); loadMainChart();
    } else { const err = await res.json().catch(() => ({})); toast(err.detail || 'Failed to sell. Try again.', 'error'); }
  } finally { btn.disabled = false; btn.textContent = 'Confirm Sale'; }
}

// ── AI ───────────────────────────────────────────────────────────
async function requestAssetAI(asset) {
  if (!authToken) return;
  if (!isPremium()) { showUpgradeModal('AI analysis per asset is a Premium feature.'); return; }
  const el = $(`ai-res-${asset.id}`); if (!el) return;
  el.style.display = 'block'; el.textContent = 'Analyzing with Gemini…';
  const res = await apiFetch(`/analysis/${encodeURIComponent(asset.symbol)}?change=${asset.percent_change ?? 0}`, { headers: authHeaders() });
  if (!res) { el.style.display = 'none'; return; }
  if (res.ok) {
    const data = await res.json();
    el.innerHTML = `<strong style="color:var(--accent-l)">AI:</strong> ${data.analysis}`;
  } else if (res.status === 402) {
    el.style.display = 'none'; const err = await res.json().catch(() => ({})); showUpgradeModal(err.detail || 'Premium feature.');
  } else { el.style.display = 'none'; toast('AI analysis temporarily unavailable', 'warning'); }
}

async function handlePortfolioAI() {
  if (!authToken) { showLoginScreen(); return; }
  if (!isPremium()) { showUpgradeModal('Portfolio AI analysis is a Premium feature.'); return; }
  const textEl = $('ai-portfolio-text'), badgeEl = $('ai-change-badge'), btn = $('btn-portfolio-ai');
  textEl.textContent = 'Analyzing portfolio with Gemini…';
  btn.disabled = true; btn.textContent = '✨ Analyzing…';
  try {
    const res = await apiFetch('/analysis/portfolio', { headers: authHeaders() });
    if (!res) { textEl.textContent = 'Connection error. Try again.'; return; }
    if (res.ok) {
      const data = await res.json(); textEl.textContent = data.analysis || 'Analysis unavailable.';
      if (typeof data.change_pct === 'number') {
        const v = data.change_pct;
        badgeEl.className   = `change-badge ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`;
        badgeEl.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      }
    } else if (res.status === 402) {
      const err = await res.json().catch(() => ({})); showUpgradeModal(err.detail || 'Premium feature.'); textEl.textContent = 'Available on Premium plan.';
    } else { textEl.textContent = 'Analysis error. Please try again.'; }
  } finally { btn.disabled = false; btn.textContent = '✨ Analyze Portfolio'; }
}

// ── ADD ASSET ────────────────────────────────────────────────────
async function handleAddAsset() {
  if (!authToken) { showLoginScreen(); return; }
  const sym    = $('symbol-input').value.trim().toUpperCase();
  const amount = parseFloat($('amount-input').value);
  const price  = parseFloat($('price-input').value);
  const date   = $('date-input').value;
  if (!sym)               { toast('Please enter an asset symbol', 'warning'); return; }
  if (!amount || amount <= 0) { toast('Enter a valid quantity', 'warning'); return; }
  if (!price  || price  <= 0) { toast('Enter a valid price',    'warning'); return; }
  const resolvedType = selectedAddAssetType || await resolveSymbolType(sym);
  if (resolvedType === 'stock' && !Number.isInteger(amount)) { toast('For stocks, quantity must be an integer.', 'warning'); return; }
  const isExisting = portfolioSymbols.has(sym);
  if (!isPremium() && portfolioCount >= FREE_ASSET_LIMIT && !isExisting) { showUpgradeModal(`Free plan is limited to ${FREE_ASSET_LIMIT} assets.`); return; }
  const btn = $('btn-save-asset'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await apiFetch('/assets/', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ symbol: sym, amount, purchase_price: price, purchase_date: date || null }) });
    if (!res) return;
    if (res.ok) {
      $('symbol-input').value = ''; $('amount-input').value = ''; $('price-input').value = ''; $('date-input').value = '';
      selectedAddAssetType = null; setAddAmountInputMode(null); $('search-dropdown').style.display = 'none';
      switchTab('dashboard'); await fetchPortfolio(); loadMainChart(); toast(`${sym} added to your portfolio ✓`, 'success');
    } else if (res.status === 402) {
      const err = await res.json().catch(() => ({})); showUpgradeModal(err.detail || 'Upgrade to Premium for more assets.');
    } else if (res.status === 404) { toast(`Asset '${sym}' not found.`, 'error');
    } else { const err = await res.json().catch(() => ({})); toast(err.detail || 'Failed to add asset.', 'error'); }
  } finally { btn.disabled = false; btn.textContent = 'Save Asset'; }
}

// ════════════════════════════════════════════════════════════════

function updateAlertFormFields() {
  const type = $('alert-type-input')?.value;
  const labelMap = {
    price_above: 'Target Price ($)',
    price_below: 'Target Price ($)',
    percent_change_up: 'Percentage (%)',
    percent_change_down: 'Percentage (%)',
    rsi_oversold: 'RSI Level (0-100)',
    rsi_overbought: 'RSI Level (0-100)',
    rebalance_drift: 'Drift Threshold (%)',
    volume_spike: 'Volume Multiplier',
    portfolio_down: 'Portfolio Drop (%)',
  };

  if ($('alert-target-label')) $('alert-target-label').textContent = labelMap[type] || 'Target Value';
  if ($('alert-rsi-period-group')) $('alert-rsi-period-group').style.display = ['rsi_oversold', 'rsi_overbought'].includes(type) ? 'block' : 'none';
  if ($('alert-target-allocation-group')) $('alert-target-allocation-group').style.display = type === 'rebalance_drift' ? 'block' : 'none';
  if ($('alert-symbol-group')) $('alert-symbol-group').style.display = type === 'portfolio_down' ? 'none' : 'block';

  if ($('alert-symbol-input') && type === 'portfolio_down') {
    $('alert-symbol-input').value = '';
  }
}

function renderAlertsList(alerts = []) {
  const root = $('alerts-list');
  if (!root) return;
  if (!alerts.length) {
    root.innerHTML = '<div class="empty-sub">No alerts yet.</div>';
    return;
  }
  root.innerHTML = alerts.map((a) => {
    const sym = a.symbol || 'PORTFOLIO';
    const status = a.active ? 'Active' : 'Inactive';
    return `<div class="market-row"><span class="market-symbol">${sym}</span><span class="market-price">${a.alert_type}</span><span class="market-change">${a.target_value} · ${status}</span></div>`;
  }).join('');
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
  const alertType = $('alert-type-input')?.value;
  const symbol = $('alert-symbol-input')?.value?.trim()?.toUpperCase() || null;
  const targetValue = parseFloat($('alert-target-input')?.value || '0');
  const recurring = !!$('alert-recurring-input')?.checked;
  const rsiPeriod = parseInt($('alert-rsi-period-input')?.value || '14', 10);
  const targetAllocation = parseFloat($('alert-target-allocation-input')?.value || '0');

  if (!alertType) { toast('Choose an alert type.', 'warning'); return; }
  if (alertType !== 'portfolio_down' && !symbol) { toast('Symbol is required for this alert type.', 'warning'); return; }
  if (!targetValue || targetValue <= 0) { toast('Enter a valid threshold value.', 'warning'); return; }

  const payload = {
    symbol,
    alert_type: alertType,
    target_value: targetValue,
    recurring,
  };

  if (['rsi_oversold', 'rsi_overbought'].includes(alertType)) payload.rsi_period = rsiPeriod;
  if (alertType === 'rebalance_drift') {
    if (!targetAllocation || targetAllocation < 0 || targetAllocation > 100) {
      toast('Target allocation must be between 0 and 100.', 'warning');
      return;
    }
    payload.target_allocation_pct = targetAllocation;
    payload.rebalance_threshold_pct = targetValue;
  }

  const btn = $('btn-create-alert');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Creating…';
  }
  try {
    const res = await apiFetch('/alerts', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res) return;
    if (res.ok) {
      toast('Alert created successfully.', 'success');
      if ($('alert-target-input')) $('alert-target-input').value = '';
      if ($('alert-target-allocation-input')) $('alert-target-allocation-input').value = '';
      await loadAlerts();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.detail || 'Could not create alert.', 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Create Alert';
    }
  }
}

// CSV IMPORT
// ════════════════════════════════════════════════════════════════
const BROKER_HELP = {
  coinbase:  `<b>How to export:</b> Coinbase → Taxes → Transaction history → Generate Report → Download CSV`,
  robinhood: `<b>How to export:</b> Robinhood app → Account → Statements → Activity → Export to CSV`,
  fidelity:  `<b>How to export:</b> Fidelity → Accounts → History → select date range → Download (CSV)`,
  kraken:    `<b>How to export:</b> Kraken → History → Export → Select <em>Ledgers</em> → Generate`,
  schwab:    `<b>How to export:</b> Schwab → Accounts → History → Export → CSV`,
};

function openImportModal() {
  if (!isPremium()) { showUpgradeModal('CSV import is available on Investor and Tax Pro plans.'); return; }
  importSelectedFile = null; importSelectedBroker = '';
  $('import-broker-select').value = '';
  $('file-drop-label').innerHTML  = '<span style="font-size:22px;">📂</span><br>Click to select a .csv file';
  $('import-help-text').style.display  = 'none';
  $('import-progress').style.display   = 'none';
  $('import-result').style.display     = 'none';
  $('btn-import-confirm').disabled     = true;
  $('modal-import-csv').classList.add('active');
}
function closeImportModal() { $('modal-import-csv').classList.remove('active'); }
function updateImportConfirmBtn() { $('btn-import-confirm').disabled = !(importSelectedFile && importSelectedBroker); }
function handleBrokerSelect() {
  importSelectedBroker = $('import-broker-select').value;
  const helpEl = $('import-help-text');
  if (importSelectedBroker && BROKER_HELP[importSelectedBroker]) { helpEl.innerHTML = BROKER_HELP[importSelectedBroker]; helpEl.style.display = 'block'; }
  else { helpEl.style.display = 'none'; }
  updateImportConfirmBtn();
}
function handleFileSelect(e) {
  const file = e.target.files?.[0]; if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv')) { toast('Please select a .csv file', 'warning'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('File too large. Maximum size is 5 MB.', 'error'); return; }
  importSelectedFile = file;
  $('file-drop-label').innerHTML = `<span style="font-size:20px;">✅</span><br><span style="font-weight:700;color:var(--text);">${file.name}</span><br><span style="font-size:10px;color:var(--text3);">${(file.size/1024).toFixed(1)} KB</span>`;
  updateImportConfirmBtn();
}
async function handleImportConfirm() {
  if (!importSelectedFile || !importSelectedBroker) return;
  if (!authToken) { showLoginScreen(); return; }
  const btn = $('btn-import-confirm'); btn.disabled = true; btn.textContent = 'Importing…';
  $('import-result').style.display = 'none'; $('import-progress').style.display = 'block';
  const fill = $('import-progress-fill'), status = $('import-status-text');
  fill.style.width = '15%'; status.textContent = 'Uploading file…';
  try {
    const formData = new FormData(); formData.append('file', importSelectedFile);
    fill.style.width = '40%'; status.textContent = 'Parsing transactions…';
    const res = await fetch(`${API_BASE}/import/csv?broker=${encodeURIComponent(importSelectedBroker)}`, { method: 'POST', headers: { 'X-Auth-Token': authToken }, body: formData });
    fill.style.width = '80%'; status.textContent = 'Processing…';
    if (!res) { toast('Network error during import.', 'error'); return; }
    const data = await res.json().catch(() => ({}));
    fill.style.width = '100%';
    if (res.status === 402) { closeImportModal(); showUpgradeModal(data.detail || 'CSV import requires an Investor or Tax Pro plan.'); return; }
    if (!res.ok) { $('import-progress').style.display = 'none'; showImportResult('error', data.detail || 'Import failed.', null); return; }
    $('import-progress').style.display = 'none';
    const imported = data.imported ?? 0, skipped = data.skipped ?? 0, errors = data.errors ?? [];
    showImportResult('success', null, { imported, skipped, errors, broker: importSelectedBroker });
    if (imported > 0) { fetchPortfolio(); loadMainChart(true); toast(`Imported ${imported} transaction${imported !== 1 ? 's' : ''} ✓`, 'success', 5000); }
  } catch (err) { $('import-progress').style.display = 'none'; showImportResult('error', `Unexpected error: ${err.message}`, null);
  } finally { btn.disabled = false; btn.textContent = 'Import'; }
}
function showImportResult(type, errorMsg, summary) {
  const el = $('import-result'); el.style.display = 'block';
  if (type === 'error') { el.innerHTML = `<div class="import-result-error"><div style="font-size:20px;margin-bottom:6px;">❌</div><div style="font-size:12px;color:var(--red);">${errorMsg}</div></div>`; return; }
  const { imported, skipped, errors } = summary;
  const errHtml = errors.length ? `<details style="margin-top:10px;"><summary style="font-size:10px;color:var(--text3);cursor:pointer;">${errors.length} row${errors.length !== 1 ? 's' : ''} skipped/errored</summary><ul style="margin:6px 0 0;padding-left:16px;font-size:10px;color:var(--text3);">${errors.slice(0,10).map((e) => `<li>${e}</li>`).join('')}${errors.length > 10 ? `<li>…and ${errors.length - 10} more</li>` : ''}</ul></details>` : '';
  el.innerHTML = `<div class="import-result-success"><div style="font-size:24px;margin-bottom:8px;">${imported > 0 ? '🎉' : '⚠️'}</div><div class="import-stat-row"><div class="import-stat"><div class="import-stat-val">${imported}</div><div class="import-stat-label">Imported</div></div><div class="import-stat"><div class="import-stat-val">${skipped}</div><div class="import-stat-label">Skipped</div></div></div>${imported === 0 ? `<div style="font-size:11px;color:var(--text2);margin-top:8px;">No transactions were imported. Check that the broker matches your file.</div>` : ''}${errHtml}</div>`;
}

// ════════════════════════════════════════════════════════════════
// TAX TOOLS — tab controller
// ════════════════════════════════════════════════════════════════

function buildTaxTabBar() {
  const taxSection = $('tax-tools-section');
  if (!taxSection) return;

  // Only build once
  if ($('tax-tab-bar-container')) return;

  const barWrapper = document.createElement('div');
  barWrapper.id = 'tax-tab-bar-container';
  barWrapper.innerHTML = `
    <div class="tax-tab-bar" id="tax-tab-bar">
      <button class="tax-tab-btn active" data-tab="tlh">
        <span class="tab-icon">🌿</span>Tax Loss
      </button>
      <button class="tax-tab-btn" data-tab="form8949">
        <span class="tab-icon">📄</span>Form 8949
      </button>
      <button class="tax-tab-btn" data-tab="summary">
        <span class="tab-icon">📊</span>Summary
      </button>
    </div>`;

  // Insert before first child
  taxSection.insertBefore(barWrapper, taxSection.firstChild);

  // Form 8949 panel
  const f49Panel = document.createElement('div');
  f49Panel.id = 'tax-panel-form8949';
  f49Panel.className = 'tax-panel';
  f49Panel.innerHTML = `
    <div class="form8949-controls">
      <div>
        <label for="f49-year-select">Tax Year</label>
        <select id="f49-year-select">
          <option value="2024">2024</option>
          <option value="2023">2023</option>
          <option value="2022">2022</option>
        </select>
      </div>
      <div>
        <label for="f49-method-select">Cost Basis Method</label>
        <select id="f49-method-select">
          <option value="FIFO">FIFO (IRS Default)</option>
          <option value="HIFO">HIFO (Min Tax)</option>
          <option value="LIFO">LIFO</option>
        </select>
      </div>
    </div>
    <button class="btn-download-8949" id="btn-download-8949">
      ⬇️ Download Form 8949 CSV
    </button>
    <p class="turbotax-note">Compatible with TurboTax, TaxAct & H&R Block CSV import</p>
    <div id="form8949-preview-loading" style="display:none;">
      <div class="shimmer-line" style="width:80%"></div>
      <div class="shimmer-line" style="width:60%"></div>
      <div class="shimmer-line" style="width:70%"></div>
    </div>
    <div id="form8949-preview"></div>`;
  taxSection.appendChild(f49Panel);

  // Summary panel
  const sumPanel = document.createElement('div');
  sumPanel.id = 'tax-panel-summary';
  sumPanel.className = 'tax-panel';
  sumPanel.innerHTML = `
    <div class="form8949-controls">
      <div>
        <label for="sum-year-select">Tax Year</label>
        <select id="sum-year-select">
          <option value="2024">2024</option>
          <option value="2023">2023</option>
          <option value="2022">2022</option>
        </select>
      </div>
      <div>
        <label for="sum-method-select">Method</label>
        <select id="sum-method-select">
          <option value="FIFO">FIFO</option>
          <option value="HIFO">HIFO</option>
          <option value="LIFO">LIFO</option>
        </select>
      </div>
    </div>
    <div id="tax-summary-content">
      <div class="shimmer-line" style="width:100%"></div>
      <div class="shimmer-line" style="width:80%"></div>
      <div class="shimmer-line" style="width:90%"></div>
    </div>`;
  taxSection.appendChild(sumPanel);

  // Wrap existing TLH content in a panel div
  const tlhPanel = document.createElement('div');
  tlhPanel.id = 'tax-panel-tlh';
  tlhPanel.className = 'tax-panel active';
  // Move existing TLH children into the panel
  const existingTlhNodes = Array.from(taxSection.children).filter(
    (el) => el.id !== 'tax-tab-bar-container' && el.id !== 'tax-panel-form8949' && el.id !== 'tax-panel-summary'
  );
  existingTlhNodes.forEach((node) => tlhPanel.appendChild(node));
  taxSection.appendChild(tlhPanel);

  // Tab click handlers
  barWrapper.querySelectorAll('.tax-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTaxTab(btn.dataset.tab));
  });

  // Form 8949 actions
  $('btn-download-8949').addEventListener('click', handleDownload8949);
  $('f49-year-select').addEventListener('change', loadForm8949Preview);
  $('f49-method-select').addEventListener('change', loadForm8949Preview);
  $('sum-year-select').addEventListener('change', loadTaxSummary);
  $('sum-method-select').addEventListener('change', loadTaxSummary);
}

function switchTaxTab(tab) {
  activeTaxTab = tab;
  document.querySelectorAll('.tax-tab-btn').forEach((b) => {
    b.classList.remove('active', 'active-gold');
    if (b.dataset.tab === tab) {
      b.classList.add(tab === 'summary' ? 'active-gold' : 'active');
    }
  });
  document.querySelectorAll('.tax-panel').forEach((p) => p.classList.remove('active'));
  const panel = $(`tax-panel-${tab}`);
  if (panel) {
    panel.classList.add('active');
    if (tab === 'form8949' && !$('form8949-preview').hasChildNodes()) loadForm8949Preview();
    if (tab === 'summary') loadTaxSummary();
  }
}

// ── Form 8949 preview ─────────────────────────────────────────────
async function loadForm8949Preview() {
  if (!authToken || !isTaxPro()) return;
  const year   = $('f49-year-select')?.value   || new Date().getFullYear();
  const method = $('f49-method-select')?.value || 'FIFO';
  const preview  = $('form8949-preview');
  const loadingEl = $('form8949-preview-loading');
  if (!preview) return;

  preview.innerHTML = ''; if (loadingEl) loadingEl.style.display = 'block';

  const res = await apiFetch(`/tax/form-8949-json?year=${year}&method=${method}`, { headers: authHeaders() });
  if (loadingEl) loadingEl.style.display = 'none';

  if (!res || !res.ok) {
    preview.innerHTML = '<div class="form8949-empty">Could not load transactions.</div>'; return;
  }
  const data = await res.json();

  if (!data.part_I?.length && !data.part_II?.length) {
    preview.innerHTML = `<div class="form8949-empty">🎯 No sales recorded for ${year}.<br><span style="font-size:10px;opacity:.6;">Sell an asset to see Form 8949 rows.</span></div>`;
    return;
  }

  function renderRows(rows, title, colorClass) {
    if (!rows.length) return '';
    const rowsHtml = rows.map((r) => {
      const isGain = r.gain_loss >= 0;
      return `<div class="f49-row">
        <div class="f49-row-top">
          <span class="f49-symbol">${r.description}</span>
          <span class="${isGain ? 'f49-gain' : 'f49-loss'}">${isGain ? '+' : ''}${formatUSD(r.gain_loss)}</span>
        </div>
        <div class="f49-meta" style="margin-bottom:6px;">Acquired: ${r.date_acquired} → Sold: ${r.date_sold}</div>
        <div class="f49-grid">
          <span>Proceeds</span><span>${formatUSD(r.proceeds)}</span>
          <span>Cost Basis</span><span>${formatUSD(r.cost_basis)}</span>
        </div>
      </div>`;
    }).join('');
    const net       = rows.reduce((a, r) => a + r.gain_loss, 0);
    const isNetGain = net >= 0;
    return `
      <div class="form8949-section-title ${colorClass}">${title} (${rows.length} transactions)</div>
      ${rowsHtml}
      <div class="f49-part-total">
        <span>${title} Net</span>
        <span class="${isNetGain ? 'f49-gain' : 'f49-loss'}">${isNetGain ? '+' : ''}${formatUSD(net)}</span>
      </div>`;
  }

  preview.innerHTML =
    renderRows(data.part_I,  'Part I — Short-Term',  '') +
    renderRows(data.part_II, 'Part II — Long-Term',   'gold');

  applyVisibilityMask();
}

// ── Form 8949 download ────────────────────────────────────────────
async function handleDownload8949() {
  if (!authToken) { showLoginScreen(); return; }
  if (!isTaxPro()) { showTaxProUpgradeModal(); return; }
  const year   = $('f49-year-select')?.value   || new Date().getFullYear();
  const method = $('f49-method-select')?.value || 'FIFO';
  const btn    = $('btn-download-8949');
  btn.disabled = true; btn.textContent = '⏳ Generating…';
  try {
    const res = await apiFetch(`/tax/form-8949?year=${year}&method=${method}`, { headers: authHeaders() });
    if (!res) { toast('Network error. Try again.', 'error'); return; }
    if (res.status === 402) { toast('Tax Pro plan required.', 'warning'); showTaxProUpgradeModal(); return; }
    if (!res.ok) { const err = await res.json().catch(() => ({})); toast(err.detail || 'Could not generate Form 8949.', 'error'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `form-8949-${year}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast(`Form 8949 (${year}) downloaded ✓`, 'success', 5000);
  } finally { btn.disabled = false; btn.textContent = '⬇️ Download Form 8949 CSV'; }
}

// ── Tax Summary ───────────────────────────────────────────────────
async function loadTaxSummary() {
  if (!authToken || !isTaxPro()) return;
  const year   = $('sum-year-select')?.value   || new Date().getFullYear();
  const method = $('sum-method-select')?.value || 'FIFO';
  const contentEl = $('tax-summary-content'); if (!contentEl) return;

  contentEl.innerHTML = `<div class="shimmer-line" style="width:100%"></div><div class="shimmer-line" style="width:80%"></div><div class="shimmer-line" style="width:90%"></div>`;

  const res = await apiFetch(`/tax/summary?year=${year}&method=${method}`, { headers: authHeaders() });
  if (!res || !res.ok) {
    contentEl.innerHTML = '<div class="form8949-empty">Could not load tax summary.</div>'; return;
  }
  const d = await res.json();
  const netTotal   = d.total_net_gain_loss;
  const netClass   = netTotal >= 0 ? 'green' : 'red';
  const stClass    = d.net_short_term  >= 0 ? 'green' : 'red';
  const ltClass    = d.net_long_term   >= 0 ? 'green' : 'red';

  contentEl.innerHTML = `
    <div class="tax-summary-grid">
      <div class="tax-sum-card ${netTotal >= 0 ? 'net-gain' : 'net-loss'}">
        <div class="tax-sum-label">Net Gain/(Loss)</div>
        <div class="tax-sum-value ${netClass}">${netTotal >= 0 ? '+' : ''}${formatUSD(netTotal)}</div>
      </div>
      <div class="tax-sum-card">
        <div class="tax-sum-label">Short-Term</div>
        <div class="tax-sum-value ${stClass}">${d.net_short_term >= 0 ? '+' : ''}${formatUSD(d.net_short_term)}</div>
      </div>
      <div class="tax-sum-card">
        <div class="tax-sum-label">Long-Term</div>
        <div class="tax-sum-value ${ltClass}">${d.net_long_term >= 0 ? '+' : ''}${formatUSD(d.net_long_term)}</div>
      </div>
      <div class="tax-sum-card">
        <div class="tax-sum-label">Transactions</div>
        <div class="tax-sum-value">${d.short_term_count + d.long_term_count}</div>
      </div>
    </div>

    <div class="tax-summary-full">
      <div class="tax-summary-full-title">Proceeds &amp; Basis</div>
      <div class="tax-summary-row">
        <span class="label">Total Proceeds</span>
        <span class="value sensitive-value">${formatUSD(d.total_proceeds)}</span>
      </div>
      <div class="tax-summary-row">
        <span class="label">Total Cost Basis</span>
        <span class="value sensitive-value">${formatUSD(d.total_cost_basis)}</span>
      </div>
      <div class="tax-summary-row">
        <span class="label">Net Gain / (Loss)</span>
        <span class="value ${netClass}" style="font-weight:800;">${netTotal >= 0 ? '+' : ''}${formatUSD(netTotal)}</span>
      </div>
    </div>

    <div class="tax-summary-full">
      <div class="tax-summary-full-title">Estimated Tax Due</div>
      <div class="bracket-rows">
        <div class="bracket-row">
          <span class="bracket-label">22% bracket</span>
          <span class="bracket-value">${formatUSD(d.estimated_tax_22pct)}</span>
        </div>
        <div class="bracket-row">
          <span class="bracket-label">24% bracket</span>
          <span class="bracket-value">${formatUSD(d.estimated_tax_24pct)}</span>
        </div>
        <div class="bracket-row">
          <span class="bracket-label">32% bracket</span>
          <span class="bracket-value">${formatUSD(d.estimated_tax_32pct)}</span>
        </div>
      </div>
      <p style="font-size:9px;color:rgba(255,255,255,.25);margin:0;text-align:center;">
        Estimates only. Long-term gains use preferred rates. Consult a tax professional.
      </p>
    </div>`;

  applyVisibilityMask();
}

// ════════════════════════════════════════════════════════════════
// TAX TOOLS — visibility + TLH (unchanged logic, new wrapper)
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

async function loadTaxLossHarvesting() {
  if (!authToken || !isTaxPro()) return;
  const listEl  = $('tlh-list');
  const badgeEl = $('tlh-total-badge');
  if (!listEl) return;
  const bracket = $('tlh-bracket-select')?.value || '0.22';
  badgeEl.textContent = 'Loading…'; badgeEl.classList.add('loading');
  listEl.innerHTML = '<div class="tlh-empty"><div class="tlh-empty-icon">⏳</div>Fetching prices…</div>';
  const res = await apiFetch(`/portfolio/tax-loss-harvesting?tax_bracket=${bracket}`, { headers: authHeaders() });
  if (!res) { listEl.innerHTML = '<div class="tlh-empty">Could not load data.</div>'; return; }
  if (res.status === 402) { listEl.innerHTML = '<div class="tlh-empty">Tax Pro plan required.</div>'; return; }
  if (!res.ok) { listEl.innerHTML = '<div class="tlh-empty">Error loading opportunities.</div>'; return; }
  const data = await res.json();
  const opportunities = data.opportunities || [];
  badgeEl.classList.remove('loading');
  if (data.total_potential_savings > 0) {
    badgeEl.textContent = `Save ${formatUSD(data.total_potential_savings)}`;
  } else {
    badgeEl.textContent = '✓ No losses'; badgeEl.style.background = 'rgba(0,0,0,0.2)'; badgeEl.style.color = 'var(--text3)'; badgeEl.style.borderColor = 'var(--border)';
  }
  listEl.innerHTML = '';
  if (!opportunities.length) {
    listEl.innerHTML = `<div class="tlh-empty"><div class="tlh-empty-icon">🎉</div><div>No harvestable losses right now.</div><div style="font-size:10px;margin-top:4px;color:var(--text3);">All positions are profitable or within the $50 threshold.</div></div>`;
    return;
  }
  opportunities.forEach((opp) => {
    const isShort = opp.gain_type === 'short_term';
    const item = document.createElement('div'); item.className = 'tlh-item';
    item.innerHTML = `
      <div class="tlh-item-top">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="tlh-symbol">${opp.symbol}</span>
          <span class="tlh-gain-type ${isShort ? 'short' : 'long'}">${isShort ? 'Short-term' : 'Long-term'}</span>
        </div>
        <span class="tlh-savings-badge">Save ${formatUSD(opp.estimated_tax_saved)}</span>
      </div>
      <div class="tlh-grid">
        <div class="tlh-cell"><span class="tlh-cell-label">Unrealized Loss</span><span class="tlh-cell-value loss">${formatUSD(opp.unrealized_loss)}</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Tax Rate Applied</span><span class="tlh-cell-value">${opp.effective_rate_pct}%</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Holding Period</span><span class="tlh-cell-value">${opp.holding_days} days</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Safe to Rebuy After</span><span class="tlh-cell-value">${opp.wash_sale_safe_date}</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Current Price</span><span class="tlh-cell-value sensitive-value">${formatUSD(opp.current_price)}</span></div>
        <div class="tlh-cell"><span class="tlh-cell-label">Purchase Price</span><span class="tlh-cell-value sensitive-value">${formatUSD(opp.purchase_price)}</span></div>
      </div>
      ${opp.suggested_replacement ? `<div class="tlh-replacement"><span>⚠️ Wash-Sale Rule:</span> Consider <strong>${opp.suggested_replacement}</strong> as substitute while waiting 31 days.</div>` : ''}`;
    listEl.appendChild(item);
  });
  applyVisibilityMask();
}

// Tax Pro upgrade modal
function showTaxProUpgradeModal() { $('modal-upgrade-tax-pro').classList.add('active'); }
function hideTaxProUpgradeModal() { $('modal-upgrade-tax-pro').classList.remove('active'); }
async function handleTaxProUpgrade() {
  hideTaxProUpgradeModal();
  const btn = $('btn-taxpro-confirm'); btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const res = await apiFetch('/stripe/create-checkout', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ plan: 'tax_pro' }) });
    if (!res) return;
    if (res.ok) { const data = await res.json(); if (data.checkout_url) window.open(data.checkout_url, '_blank'); }
    else { const err = await res.json().catch(() => ({})); toast(err.detail || 'Could not initiate payment.', 'error'); }
  } finally { btn.disabled = false; btn.textContent = 'Upgrade to Tax Pro'; }
}


// ══════════════════════════════════════════════════════════════════
// DIVIDEND TRACKER
// ══════════════════════════════════════════════════════════════════

let _divCardBuilt      = false;   // flag: card HTML created
let _divShowAllAssets  = false;   // toggle to show all assets in table
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Inject the Dividend Income card into the dashboard if it doesn't exist yet. */
function ensureDividendCard() {
  if ($('div-income-card')) return;

  // Find the assets list section and insert after
  const assetsList = $('assets-list');
  if (!assetsList) return;

  const card = document.createElement('div');
  card.id = 'div-income-card';
  card.className = 'div-card';
  card.innerHTML = `
    <div class="div-card-header">
      <span class="div-card-title">🌱 Dividend Income</span>
      <button class="div-refresh-btn" id="btn-div-refresh" title="Refresh dividend data">↻</button>
    </div>
    <div id="div-card-body">
      <div class="shimmer-line" style="width:100%"></div>
      <div class="shimmer-line" style="width:70%"></div>
      <div class="shimmer-line" style="width:85%"></div>
    </div>`;

  // Insert card AFTER the assets-list (before the next sibling or end of parent)
  assetsList.parentNode.insertBefore(card, assetsList.nextSibling);

  $('btn-div-refresh').addEventListener('click', () => loadDividendCard(true));
  _divCardBuilt = true;
}

/** Main loader — fetches /portfolio/dividends and renders the card. */
async function loadDividendCard(force = false) {
  if (!authToken) return;

  ensureDividendCard();

  const bodyEl = $('div-card-body');
  if (!bodyEl) return;

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
    bodyEl.innerHTML = `<div class="div-empty">No stock positions found.<br><span style="font-size:10px;opacity:.6;">Add stocks to your portfolio to see dividend income projections.</span></div>`;
    return;
  }

  const hasAnyDividend = data.assets.some((a) => a.pays_dividend);

  bodyEl.innerHTML = `
    <!-- ── Income Summary ── -->
    <div class="div-income-grid">
      <div class="div-income-cell">
        <div class="div-income-label">Annual Income</div>
        <div class="div-income-value sensitive-value" id="div-annual">${formatUSD(data.total_annual_income)}</div>
      </div>
      <div class="div-income-cell">
        <div class="div-income-label">Monthly Income</div>
        <div class="div-income-value sensitive-value" id="div-monthly">${formatUSD(data.total_monthly_income)}</div>
      </div>
    </div>

    <!-- ── Ex-Date Calendar Strip ── -->
    ${buildCalendarStrip(data.upcoming_payments)}

    <!-- ── Upcoming Payments (next 60 days) ── -->
    ${buildUpcomingPayments(data.upcoming_payments)}

    <!-- ── Per-Asset Yield Table ── -->
    <div class="div-section-label">Yield on Cost vs Current Yield</div>
    ${buildYieldTable(data.assets)}
    ${data.assets.length > 3 ? `<button class="div-toggle-btn" id="btn-div-toggle-assets">${_divShowAllAssets ? '▲ Show less' : '▼ Show all ' + data.assets.length + ' assets'}</button>` : ''}`;

  // Wire toggle button
  const toggleBtn = $('btn-div-toggle-assets');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      _divShowAllAssets = !_divShowAllAssets;
      const tableEl = $('div-yield-table-body');
      if (tableEl) {
        tableEl.innerHTML = buildYieldRows(data.assets);
      }
      toggleBtn.textContent = _divShowAllAssets
        ? '▲ Show less'
        : '▼ Show all ' + data.assets.length + ' assets';
    });
  }

  applyVisibilityMask();
}

/** Build the 30-day calendar strip showing ex-dates. */
function buildCalendarStrip(upcoming) {
  const today = new Date();
  const eventMap = {};
  upcoming.forEach((p) => {
    if (p.ex_date) eventMap[p.ex_date.slice(0, 10)] = p.symbol;
  });

  const days = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const sym = eventMap[key];
    days.push(`
      <div class="div-cal-day ${sym ? 'has-event' : ''}">
        <div class="div-cal-day-num">${d.getDate()}</div>
        <div class="div-cal-day-mon">${MONTHS_SHORT[d.getMonth()]}</div>
        ${sym ? `<div class="div-cal-day-sym">${sym}</div>` : ''}
      </div>`);
  }

  return `
    <div class="div-section-label">Ex-Date Calendar — Next 30 Days</div>
    <div class="div-calendar-strip">${days.join('')}</div>`;
}

/** Build upcoming payments list (next 60 days). */
function buildUpcomingPayments(upcoming) {
  if (!upcoming || upcoming.length === 0) {
    return `<div class="div-section-label">Upcoming Payments (60 days)</div>
            <div class="div-empty" style="padding:10px 0;">No upcoming ex-dates in the next 60 days.</div>`;
  }

  const rows = upcoming.map((p) => `
    <div class="div-upcoming-row">
      <span class="div-upcoming-sym">${p.symbol}</span>
      <span class="div-upcoming-date">Ex: ${p.ex_date ? p.ex_date.slice(0, 10) : '—'}</span>
      <span class="div-upcoming-amount sensitive-value">+${formatUSD(p.projected_total)}</span>
      <span class="div-upcoming-badge">Q</span>
    </div>`).join('');

  return `<div class="div-section-label">Upcoming Payments (60 days)</div>
          <div class="div-upcoming-list">${rows}</div>`;
}

/** Build the per-asset yield comparison table. */
function buildYieldTable(assets) {
  return `
    <table class="div-asset-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Shares</th>
          <th>Yield Now</th>
          <th>YoC</th>
          <th>Annual</th>
          <th>Next Ex</th>
        </tr>
      </thead>
      <tbody id="div-yield-table-body">${buildYieldRows(assets)}</tbody>
    </table>`;
}

function buildYieldRows(assets) {
  const visible = _divShowAllAssets ? assets : assets.slice(0, 3);
  return visible.map((a) => {
    if (!a.pays_dividend) {
      return `<tr>
        <td>${a.symbol}</td>
        <td>${a.shares}</td>
        <td colspan="4"><span class="div-no-dividend">No dividend</span></td>
      </tr>`;
    }
    // YoC class: better if yield_on_cost > yield_current
    const yocClass = a.yield_on_cost > a.yield_current
      ? 'div-yoc-better'
      : a.yield_on_cost === a.yield_current
        ? 'div-yoc-same'
        : 'div-yoc-lower';
    return `<tr>
      <td>${a.symbol}</td>
      <td>${a.shares}</td>
      <td>${a.yield_current.toFixed(2)}%</td>
      <td class="${yocClass}">${a.yield_on_cost.toFixed(2)}%</td>
      <td class="sensitive-value">${formatUSD(a.annual_income)}</td>
      <td>${a.next_ex_date ? a.next_ex_date.slice(0, 10) : '—'}</td>
    </tr>`;
  }).join('');
}


// ── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  injectStyles();

  loadSession((hasSession) => {
    if (hasSession) {
      // Check if user is already verified (stored session)
      if (currentUser && currentUser.is_verified === false) {
        showVerifyScreen(authToken, currentUser.email || '', (verifiedUser) => {
          const updatedUser = { ...currentUser, ...verifiedUser, is_verified: true };
          saveSession(authToken, updatedUser);
          hideLoginScreen(); updateProfileBar();
          fetchPortfolio(); loadMainChart(); startRefresh(); checkAIStatus();
        });
      } else {
        hideLoginScreen(); updateProfileBar(); fetchPortfolio(); loadMainChart(); startRefresh(); checkAIStatus();
      }
    } else { showLoginScreen(); }
  });

  updatePrivacyToggle();

  // Auth
  $('btn-login')?.addEventListener('click', handleLogin);
  $('btn-register')?.addEventListener('click', handleRegister);
  $('btn-show-register')?.addEventListener('click', toggleAuthMode);
  $('btn-show-login')?.addEventListener('click', toggleAuthMode);
  $('login-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $('reg-password')?.addEventListener('keydown',   (e) => { if (e.key === 'Enter') handleRegister(); });

  // Hamburger
  $('btn-hamburger')?.addEventListener('click', () => {
    const isOpen = !$('nav-menu').classList.contains('hidden');
    if (isOpen) { closeMenu(); } else { $('nav-menu').classList.remove('hidden'); $('btn-hamburger').classList.add('open'); }
  });

  // Nav
  $('nav-portfolio')?.addEventListener('click',    () => { switchTab('dashboard');        closeMenu(); });
  $('nav-add')?.addEventListener('click',          () => { switchTab('add-asset');         closeMenu(); });
  $('nav-transactions')?.addEventListener('click', () => { switchTab('transactions-page'); closeMenu(); });
  $('nav-logout')?.addEventListener('click',       () => { handleLogout(); });

  $('top-tab-dashboard')?.addEventListener('click', () => switchTab('dashboard'));
  $('top-tab-market')?.addEventListener('click',    () => switchTab('market-watch'));
  $('btn-quick-add')?.addEventListener('click',           () => switchTab('add-asset'));
  $('btn-quick-transactions')?.addEventListener('click',  () => switchTab('transactions-page'));

  $('btn-privacy-toggle')?.addEventListener('click', () => { hideSensitiveValues = !hideSensitiveValues; updatePrivacyToggle(); });

  // Upgrade
  $('btn-upgrade')?.addEventListener('click', () => showUpgradeModal('Unlock unlimited assets, AI analysis, CSV import, and more.'));
  $('btn-upgrade-cancel')?.addEventListener('click',  hideUpgradeModal);
  $('btn-upgrade-confirm')?.addEventListener('click', handleUpgrade);
  $('btn-export-csv')?.addEventListener('click',      exportPortfolioCsv);

  // Portfolio AI
  $('btn-portfolio-ai')?.addEventListener('click', handlePortfolioAI);

  // Detail back
  $('btn-back')?.addEventListener('click', () => $('detail-view').classList.remove('active'));

  // Detail time buttons
  document.querySelectorAll('.time-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      const sym = $('detail-symbol').textContent;
      if (sym && sym !== '—') loadDetailChart(sym, e.target.dataset.period);
    });
  });

  // Main chart controls
  $('benchmark-select')?.addEventListener('change', () => loadMainChart());
  document.querySelectorAll('.pill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.pill').forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active'); loadMainChart();
    });
  });

  // Add asset
  $('btn-save-asset')?.addEventListener('click', handleAddAsset);
  $('btn-create-alert')?.addEventListener('click', handleCreateAlert);
  $('alert-type-input')?.addEventListener('change', updateAlertFormFields);
  updateAlertFormFields();
  $('symbol-input')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    selectedAddAssetType = null; setAddAmountInputMode(null);
    if (v.length < 2) { $('search-dropdown').style.display = 'none'; return; }
    searchTimer = setTimeout(() => performSearch(v), 380);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.input-wrap')) $('search-dropdown').style.display = 'none'; });

  // Sell modal
  $('sell-qty')?.addEventListener('input', updateSellEstimate);
  $('btn-max')?.addEventListener('click', () => { if (assetForSale) { $('sell-qty').value = assetForSale.amount; updateSellEstimate(); } });
  $('btn-sell-cancel')?.addEventListener('click',  closeSellModal);
  $('btn-sell-confirm')?.addEventListener('click', confirmSell);

  // CSV Import modal
  $('btn-open-import')?.addEventListener('click', openImportModal);
  $('btn-import-cancel')?.addEventListener('click', closeImportModal);
  $('btn-import-confirm')?.addEventListener('click', handleImportConfirm);
  $('import-broker-select')?.addEventListener('change', handleBrokerSelect);
  $('file-drop-area')?.addEventListener('click', () => $('import-file-input')?.click());
  $('import-file-input')?.addEventListener('change', handleFileSelect);
  const dropArea = $('file-drop-area');
  if (dropArea) {
    dropArea.addEventListener('dragover', (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
    dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
    dropArea.addEventListener('drop', (e) => { e.preventDefault(); dropArea.classList.remove('drag-over'); const file = e.dataTransfer.files?.[0]; if (file) handleFileSelect({ target: { files: [file] } }); });
  }
  $('modal-import-csv')?.addEventListener('click', (e) => { if (e.target === $('modal-import-csv')) closeImportModal(); });

  // Tax Pro
  $('btn-upgrade-tax-pro')?.addEventListener('click', () => showTaxProUpgradeModal());
  $('btn-taxpro-cancel')?.addEventListener('click',   () => hideTaxProUpgradeModal());
  $('btn-taxpro-confirm')?.addEventListener('click',  handleTaxProUpgrade);
  $('btn-refresh-tlh')?.addEventListener('click',     loadTaxLossHarvesting);
  $('tlh-bracket-select')?.addEventListener('change', loadTaxLossHarvesting);
});