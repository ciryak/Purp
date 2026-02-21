/* ═══════════════════════════════════════════════════════════════
   Purp — Extension Frontend v2
   Fixes:
   - Toast system replaces all alert() calls
   - Search dropdown correctly uses 'icon' field from API
   - Form fields cleared by direct value reset (no <form> needed)
   - Field validation before any fetch call
   - 401 auto-logout on every fetch
   - Autocomplete closes on outside click
   - All strings in English
   ════════════════════════════════════════════════════════════════ */

// ── Config ───────────────────────────────────────────────────────
const API_BASE          = 'https://purp-backend.railway.app';
const FREE_ASSET_LIMIT  = 4;
const REFRESH_MS        = 60_000; // 60 s

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

const $ = (id) => document.getElementById(id);
const formatUSD = (v) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v ?? 0);

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

// ── ERROR PILL ───────────────────────────────────────────────────
function showError(elId, msg) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(elId) {
  const el = $(elId);
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

// ── AUTH HELPERS ─────────────────────────────────────────────────
function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...(authToken ? { 'X-Auth-Token': authToken } : {}),
    ...extra,
  };
}

function saveSession(token, user) {
  authToken   = token;
  currentUser = user;
  try {
    localStorage.setItem('purp_token', token);
    localStorage.setItem('purp_user',  JSON.stringify(user));
  } catch (e) {
    // Storage blocked in some environments
  }
}

function loadSession() {
  try {
    const t = localStorage.getItem('purp_token');
    const u = localStorage.getItem('purp_user');
    if (t && u) {
      authToken   = t;
      currentUser = JSON.parse(u);
      return true;
    }
  } catch (e) {}
  return false;
}

function clearSession() {
  authToken   = null;
  currentUser = null;
  portfolioCount   = 0;
  portfolioSymbols = new Set();
  stopRefresh();
  try {
    localStorage.removeItem('purp_token');
    localStorage.removeItem('purp_user');
  } catch (e) {}
}

function isPremium() { return !!currentUser?.is_premium; }

// ── SAFE FETCH ───────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, opts);

    if (res.status === 401) {
      clearSession();
      showLoginScreen();
      toast('Session expired — please sign in again', 'warning');
      return null;
    }

    return res;
  } catch (e) {
    console.error('Network error:', e);
    return null;
  }
}

// ── REFRESH ──────────────────────────────────────────────────────
function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (authToken) { fetchPortfolio(); loadMainChart(true); }
  }, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ── SCREENS ──────────────────────────────────────────────────────
function showLoginScreen() {
  $('login-screen').classList.remove('hidden');
}
function hideLoginScreen() {
  $('login-screen').classList.add('hidden');
}

// ── LOGIN ────────────────────────────────────────────────────────
async function handleLogin() {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  clearError('login-error');

  if (!username || !password) {
    showError('login-error', 'Please fill in username and password');
    return;
  }

  const btn = $('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await apiFetch('/auth/login', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username, password }),
    });

    if (!res) { return; }

    if (res.ok) {
      const data = await res.json();
      saveSession(data.token, data.user);
      hideLoginScreen();
      updateProfileBar();
      fetchPortfolio();
      loadMainChart();
      startRefresh();
    } else {
      const err = await res.json().catch(() => ({}));
      showError('login-error', err.detail || 'Incorrect username or password');
    }
  } finally {
    btn.disabled   = false;
    btn.textContent = 'Sign In';
  }
}

// ── REGISTER ─────────────────────────────────────────────────────
async function handleRegister() {
  const username = $('reg-username').value.trim();
  const email    = $('reg-email').value.trim();
  const password = $('reg-password').value;
  clearError('register-error');

  if (!username || !email || !password) {
    showError('register-error', 'All fields are required');
    return;
  }
  if (username.length < 3) {
    showError('register-error', 'Username must be at least 3 characters');
    return;
  }
  if (password.length < 4) {
    showError('register-error', 'Password must be at least 4 characters');
    return;
  }
  if (!email.includes('@')) {
    showError('register-error', 'Enter a valid email address');
    return;
  }

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
      showError('register-error', `Network error: ${networkErr.message}. Check your connection.`);
      return;
    }

    if (res.ok) {
      const data = await res.json();
      saveSession(data.token, data.user);
      hideLoginScreen();
      updateProfileBar();
      fetchPortfolio();
      loadMainChart();
      startRefresh();
      toast('Account created! 🎉', 'success', 5000);
    } else {
      // Show full error detail for debugging
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        errMsg = errBody.detail || errBody.message || JSON.stringify(errBody);
      } catch (e) {
        try { errMsg = `HTTP ${res.status}: ${await res.text()}`; } catch {}
      }
      showError('register-error', errMsg);
      console.error('Register error:', res.status, errMsg);
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create Account';
  }
}

// ── LOGOUT ───────────────────────────────────────────────────────
async function handleLogout() {
  closeMenu();
  try {
    await apiFetch('/auth/logout', { method: 'POST', headers: authHeaders() });
  } catch (e) {}
  clearSession();
  showLoginScreen();
}

// ── TOGGLE LOGIN/REGISTER ────────────────────────────────────────
function toggleAuthMode() {
  const loginEl = $('login-form');
  const regEl   = $('register-form');
  const showingLogin = loginEl.style.display !== 'none';
  loginEl.style.display = showingLogin ? 'none'  : 'block';
  regEl.style.display   = showingLogin ? 'block' : 'none';
  clearError('login-error');
  clearError('register-error');
}

// ── PROFILE BAR ──────────────────────────────────────────────────
function updateProfileBar() {
  const name = currentUser?.username || '—';
  $('profile-username').textContent = name;
  $('profile-avatar').textContent   = name.charAt(0).toUpperCase();

  const planEl = $('profile-plan');
  if (isPremium()) {
    planEl.textContent = 'Premium';
    planEl.className   = 'plan-badge premium';
  } else {
    planEl.textContent = 'Free';
    planEl.className   = 'plan-badge';
  }

  $('profile-count').textContent = isPremium()
    ? `${portfolioCount} assets`
    : `${portfolioCount}/${FREE_ASSET_LIMIT} assets`;

  $('btn-upgrade').style.display = isPremium() ? 'none' : '';
}

// ── UPGRADE MODAL ────────────────────────────────────────────────
function showUpgradeModal(reason) {
  $('upgrade-reason').textContent = reason || 'Unlock advanced features.';
  $('modal-upgrade').classList.add('active');
}
function hideUpgradeModal() {
  $('modal-upgrade').classList.remove('active');
}
async function handleUpgrade() {
  hideUpgradeModal();
  const btn = $('btn-upgrade-confirm');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const res = await apiFetch('/stripe/create-checkout', {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res) return;

    if (res.ok) {
      const data = await res.json();
      if (data.checkout_url) {
        chrome.tabs.create({ url: data.checkout_url });
      }
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.detail || 'Could not initiate payment. Try again.', 'error');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Get Premium';
  }
}

// ── MENU ─────────────────────────────────────────────────────────
function closeMenu() {
  $('nav-menu').classList.add('hidden');
  $('btn-hamburger').classList.remove('open');
}

// ── TABS ─────────────────────────────────────────────────────────
function switchTab(id) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $(id)?.classList.add('active');
  $('nav-portfolio').classList.toggle('active', id === 'dashboard');
  $('nav-add').classList.toggle('active', id === 'add-asset');
  if (id === 'dashboard') loadMainChart();
}

// ── MAIN CHART ───────────────────────────────────────────────────
async function loadMainChart(skipAnim = false) {
  if (!authToken) return;
  const ctx = $('mainChart')?.getContext('2d');
  if (!ctx) return;
  if (mainChart) { mainChart.destroy(); mainChart = null; }

  const period = document.querySelector('.pill.active')?.dataset.p || '1mo';
  const bench  = $('benchmark-select')?.value || '^GSPC';

  const res = await apiFetch(
    `/portfolio/history?period=${period}&benchmark=${encodeURIComponent(bench)}`,
    { headers: authHeaders() }
  );
  if (!res || !res.ok) return;
  const data = await res.json();
  if (!data.portfolio?.length) return;

  const s0 = data.portfolio[0];
  const b0 = data.benchmark[0] || 1;
  const normP = data.portfolio.map((v) => ((v - s0) / (s0 || 1)) * 100);
  const normB = data.benchmark.map((v) => ((v - b0) / (b0 || 1)) * 100);

  mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dates,
      datasets: [
        { label: 'Portfolio', data: normP, borderColor: '#a78bfa', borderWidth: 2, pointRadius: 0, tension: 0.4 },
        { label: bench,       data: normB, borderColor: '#444',    borderWidth: 1, borderDash: [4,4], pointRadius: 0, tension: 0.4 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: skipAnim ? false : { duration: 400 },
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
      scales: { x: { display: false }, y: { display: false } },
    },
  });
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
  grad.addColorStop(0, 'rgba(124,58,237,0.4)');
  grad.addColorStop(1, 'rgba(124,58,237,0)');

  detailChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.dates || [],
      datasets: [{ data: data.prices, borderColor: '#7c3aed', backgroundColor: grad,
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, fill: true, tension: 0.4 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: true, position: 'right',
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: 'rgba(255,255,255,0.3)', font: { family: 'DM Mono', size: 9 } } },
      },
    },
  });
}

// ── SPARKLINE ────────────────────────────────────────────────────
function renderSpark(canvasId, data, color) {
  const ctx = $(canvasId)?.getContext('2d');
  if (!ctx || !data?.length) return;
  new Chart(ctx, {
    type: 'line',
    data: { labels: data.map((_, i) => i), datasets: [
      { data, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: false },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales:  { x: { display: false }, y: { display: false } },
      animation: false,
    },
  });
}

// ── SEARCH (autocomplete) ────────────────────────────────────────
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

      // Icon: try item.icon (always set by API), fallback to initials
      let iconHtml;
      if (item.icon) {
        iconHtml = `<img
          class="search-item-icon"
          src="${item.icon}"
          alt="${item.symbol}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div class="search-item-fb" style="display:none;">${sym2}</div>`;
      } else {
        iconHtml = `<div class="search-item-fb">${sym2}</div>`;
      }

      const row = document.createElement('div');
      row.className = 'search-item';
      row.innerHTML = `
        ${iconHtml}
        <span class="search-item-name">${item.symbol}</span>
        <span class="search-item-sub">${item.name || ''}</span>
        <span class="search-tag">${item.type || ''}</span>`;

      row.addEventListener('click', () => {
        $('symbol-input').value = item.symbol;
        box.style.display = 'none';
      });

      box.appendChild(row);
    });

    box.style.display = 'block';
  } catch (e) {
    console.error('Search error:', e);
    box.style.display = 'none';
  }
}

// ── PORTFOLIO ────────────────────────────────────────────────────
async function fetchPortfolio() {
  if (!authToken) return;

  const res = await apiFetch('/portfolio/balance', { headers: authHeaders() });
  if (!res || !res.ok) return;

  const data = await res.json();

  $('total-balance').textContent = formatUSD(data.total_balance_usd);
  portfolioCount   = (data.assets || []).length;
  portfolioSymbols = new Set(
    (data.assets || []).map((a) => (a.real_symbol || a.symbol || '').toUpperCase())
  );
  updateProfileBar();

  const list = $('assets-list');
  list.innerHTML = '';

  if (!data.assets?.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">Portfolio is empty</div>
        <div class="empty-sub">Add your first asset using the menu above to start tracking your investments.</div>
      </div>`;
    return;
  }

  data.assets.forEach((asset) => {
    const profit   = asset.profit ?? 0;
    const isProfit = profit >= 0;
    const pctTxt   = asset.percent_change != null
      ? `${asset.percent_change >= 0 ? '+' : ''}${asset.percent_change.toFixed(2)}%`
      : '';

    const sym2 = (asset.symbol || '').substring(0, 2).toUpperCase();
    let iconHtml;
    if (asset.icon) {
      iconHtml = `
        <img class="asset-icon-img" src="${asset.icon}" alt="${asset.symbol}"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
        <div class="asset-icon-fb" style="display:none;">${sym2}</div>`;
    } else {
      iconHtml = `<div class="asset-icon-fb">${sym2}</div>`;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'asset-wrapper';
    wrapper.innerHTML = `
      <div class="asset-main">
        <div class="asset-left">
          <div class="asset-icon-wrap">${iconHtml}</div>
          <div>
            <div class="asset-name">${asset.symbol}</div>
            <div class="asset-price">
              ${formatUSD(asset.current_price)}
              <span class="${isProfit ? 'text-green' : 'text-red'}">${pctTxt}</span>
            </div>
          </div>
        </div>
        <div class="asset-spark"><canvas id="spark-${asset.id}"></canvas></div>
        <div class="asset-values">
          <div class="asset-val">${formatUSD(asset.position_value)}</div>
          <div class="asset-profit ${isProfit ? 'text-green' : 'text-red'}">
            ${isProfit ? '+' : ''}${formatUSD(profit)}
          </div>
        </div>
      </div>

      <div class="action-bar">
        <button class="action-btn ai"   data-id="${asset.id}">✨ AI Analysis</button>
        <button class="action-btn sell" data-id="${asset.id}">📉 Sell</button>
      </div>

      <div class="ai-result" id="ai-res-${asset.id}"></div>`;

    // Click on main row → detail view
    wrapper.querySelector('.asset-main').addEventListener('click', () => openDetail(asset));

    // Sell button
    wrapper.querySelector('.action-btn.sell').addEventListener('click', (e) => {
      e.stopPropagation();
      openSellModal(asset);
    });

    // AI button
    wrapper.querySelector('.action-btn.ai').addEventListener('click', (e) => {
      e.stopPropagation();
      requestAssetAI(asset);
    });

    list.appendChild(wrapper);
    renderSpark(`spark-${asset.id}`, asset.history || [], isProfit ? '#10b981' : '#ef4444');
  });
}

// ── DETAIL VIEW ──────────────────────────────────────────────────
function openDetail(asset) {
  const view = $('detail-view');
  view.classList.add('active');

  $('detail-symbol').textContent = asset.symbol;
  $('detail-price').textContent  = formatUSD(asset.current_price);
  $('holding-badge').textContent = `${asset.days_held ?? 0} days held`;

  const imgEl = $('detail-icon-img');
  const fbEl  = $('detail-icon-fb');
  fbEl.textContent = (asset.symbol || '').substring(0, 2).toUpperCase();

  if (asset.icon) {
    imgEl.src = asset.icon;
    imgEl.style.display = 'block';
    fbEl.style.display  = 'none';
    imgEl.onerror = () => {
      imgEl.style.display = 'none';
      fbEl.style.display  = 'flex';
    };
  } else {
    imgEl.style.display = 'none';
    fbEl.style.display  = 'flex';
  }

  document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.time-btn[data-period="1mo"]')?.classList.add('active');
  loadDetailChart(asset.real_symbol || asset.symbol, '1mo');
}

// ── SELL MODAL ───────────────────────────────────────────────────
function openSellModal(asset) {
  assetForSale = asset;
  const qty = $('sell-qty');
  qty.value = asset.amount;
  qty.max   = asset.amount;
  $('sell-info').textContent =
    `Held: ${asset.amount}  •  Avg cost: ${formatUSD(asset.purchase_price)}`;
  updateSellEstimate();
  $('modal-sell').classList.add('active');
}

function closeSellModal() {
  $('modal-sell').classList.remove('active');
  assetForSale = null;
}

function updateSellEstimate() {
  if (!assetForSale) return;
  let qty = parseFloat($('sell-qty').value) || 0;
  if (qty > assetForSale.amount) { qty = assetForSale.amount; $('sell-qty').value = qty; }
  if (qty < 0) qty = 0;

  const total  = qty * assetForSale.current_price;
  const pnl    = (assetForSale.current_price - assetForSale.purchase_price) * qty;
  const isWin  = pnl >= 0;

  $('sell-estimate').innerHTML = `
    ${formatUSD(total)}<br>
    <span class="${isWin ? 'text-green' : 'text-red'}" style="font-size:13px;">
      ${isWin ? '+' : ''}${formatUSD(pnl)}
    </span>`;
}

async function confirmSell() {
  if (!assetForSale || !authToken) return;
  const qty = parseFloat($('sell-qty').value);
  if (!qty || qty <= 0) { toast('Enter a valid amount to sell', 'warning'); return; }

  const btn = $('btn-sell-confirm');
  btn.disabled    = true;
  btn.textContent = '…';

  try {
    const res = await apiFetch(`/assets/${assetForSale.id}/sell`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ amount: qty }),
    });
    if (!res) return;

    if (res.ok) {
      const data = await res.json();
      const pnl  = data.pnl ?? 0;
      const sign = pnl >= 0 ? '+' : '';
      toast(`Sold! P&L: ${sign}${formatUSD(pnl)}`, pnl >= 0 ? 'success' : 'info');
      closeSellModal();
      fetchPortfolio();
      loadMainChart();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.detail || 'Failed to sell. Try again.', 'error');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Confirm Sale';
  }
}

// ── AI — SINGLE ASSET ────────────────────────────────────────────
async function requestAssetAI(asset) {
  if (!authToken) return;
  if (!isPremium()) {
    showUpgradeModal('AI analysis per asset is a Premium feature.');
    return;
  }

  const el = $(`ai-res-${asset.id}`);
  if (!el) return;
  el.style.display = 'block';
  el.textContent   = 'Analyzing with Gemini…';

  const res = await apiFetch(
    `/analysis/${encodeURIComponent(asset.symbol)}?change=${asset.percent_change ?? 0}`,
    { headers: authHeaders() }
  );
  if (!res) { el.style.display = 'none'; return; }

  if (res.ok) {
    const data = await res.json();
    el.innerHTML = `<strong style="color:var(--accent-l)">AI:</strong> ${data.analysis}`;
  } else if (res.status === 402) {
    el.style.display = 'none';
    const err = await res.json().catch(() => ({}));
    showUpgradeModal(err.detail || 'Premium feature.');
  } else {
    el.style.display = 'none';
    toast('AI analysis temporarily unavailable', 'warning');
  }
}

// ── AI — PORTFOLIO ───────────────────────────────────────────────
async function handlePortfolioAI() {
  if (!authToken) { showLoginScreen(); return; }
  if (!isPremium()) {
    showUpgradeModal('Portfolio AI analysis is a Premium feature. Upgrade for unlimited insights.');
    return;
  }

  const textEl  = $('ai-portfolio-text');
  const badgeEl = $('ai-change-badge');
  const btn     = $('btn-portfolio-ai');

  textEl.textContent  = 'Analyzing portfolio with Gemini…';
  btn.disabled        = true;
  btn.textContent     = '✨ Analyzing…';

  try {
    const res = await apiFetch('/analysis/portfolio', { headers: authHeaders() });
    if (!res) { textEl.textContent = 'Connection error. Try again.'; return; }

    if (res.ok) {
      const data = await res.json();
      textEl.textContent = data.analysis || 'Analysis unavailable.';

      if (typeof data.change_pct === 'number') {
        const v = data.change_pct;
        badgeEl.className   = `change-badge ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`;
        badgeEl.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      }
    } else if (res.status === 402) {
      const err = await res.json().catch(() => ({}));
      showUpgradeModal(err.detail || 'Premium feature.');
      textEl.textContent = 'Available on Premium plan.';
    } else {
      textEl.textContent = 'Analysis error. Please try again.';
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = '✨ Analyze Portfolio';
  }
}

// ── ADD ASSET ────────────────────────────────────────────────────
async function handleAddAsset() {
  if (!authToken) { showLoginScreen(); return; }

  const sym    = $('symbol-input').value.trim().toUpperCase();
  const amount = parseFloat($('amount-input').value);
  const price  = parseFloat($('price-input').value);
  const date   = $('date-input').value;

  if (!sym)              { toast('Please enter an asset symbol', 'warning'); return; }
  if (!amount || amount <= 0) { toast('Enter a valid quantity', 'warning'); return; }
  if (!price  || price  <= 0) { toast('Enter a valid price',    'warning'); return; }

  // Free tier pre-check
  const isExisting = portfolioSymbols.has(sym);
  if (!isPremium() && portfolioCount >= FREE_ASSET_LIMIT && !isExisting) {
    showUpgradeModal(`Free plan is limited to ${FREE_ASSET_LIMIT} assets. Upgrade to add unlimited assets.`);
    return;
  }

  const btn = $('btn-save-asset');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    const res = await apiFetch('/assets/', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ symbol: sym, amount, purchase_price: price, purchase_date: date || null }),
    });
    if (!res) return;

    if (res.ok) {
      // Clear fields
      $('symbol-input').value = '';
      $('amount-input').value = '';
      $('price-input').value  = '';
      $('date-input').value   = '';
      $('search-dropdown').style.display = 'none';

      switchTab('dashboard');
      await fetchPortfolio();
      loadMainChart();
      toast(`${sym} added to your portfolio ✓`, 'success');
    } else if (res.status === 402) {
      const err = await res.json().catch(() => ({}));
      showUpgradeModal(err.detail || 'Upgrade to Premium for more assets.');
    } else if (res.status === 404) {
      toast(`Asset '${sym}' not found. Check the symbol and try again.`, 'error');
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.detail || 'Failed to add asset. Please try again.', 'error');
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save Asset';
  }
}

// ── INIT & LISTENERS ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (loadSession()) {
    hideLoginScreen();
    updateProfileBar();
    fetchPortfolio();
    loadMainChart();
    startRefresh();
  } else {
    showLoginScreen();
  }

  // ── Auth
  $('btn-login')?.addEventListener('click', handleLogin);
  $('btn-register')?.addEventListener('click', handleRegister);
  $('btn-show-register')?.addEventListener('click', toggleAuthMode);
  $('btn-show-login')?.addEventListener('click', toggleAuthMode);

  $('login-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });
  $('reg-password')?.addEventListener('keydown',   (e) => { if (e.key === 'Enter') handleRegister(); });

  // ── Hamburger
  $('btn-hamburger')?.addEventListener('click', () => {
    const isOpen = !$('nav-menu').classList.contains('hidden');
    if (isOpen) {
      closeMenu();
    } else {
      $('nav-menu').classList.remove('hidden');
      $('btn-hamburger').classList.add('open');
    }
  });

  // ── Nav
  $('nav-portfolio')?.addEventListener('click', () => { switchTab('dashboard'); closeMenu(); });
  $('nav-add')?.addEventListener('click',       () => { switchTab('add-asset'); closeMenu(); });
  $('nav-logout')?.addEventListener('click',    () => { handleLogout(); });

  // ── Upgrade
  $('btn-upgrade')?.addEventListener('click', () =>
    showUpgradeModal('Unlock unlimited assets, AI analysis, and more for $15/mo.')
  );
  $('btn-upgrade-cancel')?.addEventListener('click', hideUpgradeModal);
  $('btn-upgrade-confirm')?.addEventListener('click', handleUpgrade);

  // ── Portfolio AI
  $('btn-portfolio-ai')?.addEventListener('click', handlePortfolioAI);

  // ── Detail back
  $('btn-back')?.addEventListener('click', () => $('detail-view').classList.remove('active'));

  // ── Detail time buttons
  document.querySelectorAll('.time-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.time-btn').forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      const sym = $('detail-symbol').textContent;
      if (sym && sym !== '—') loadDetailChart(sym, e.target.dataset.period);
    });
  });

  // ── Main chart controls
  $('benchmark-select')?.addEventListener('change', () => loadMainChart());
  document.querySelectorAll('.pill').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.pill').forEach((b) => b.classList.remove('active'));
      e.target.classList.add('active');
      loadMainChart();
    });
  });

  // ── Add asset
  $('btn-save-asset')?.addEventListener('click', handleAddAsset);
  $('symbol-input')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    if (v.length < 2) { $('search-dropdown').style.display = 'none'; return; }
    searchTimer = setTimeout(() => performSearch(v), 380);
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-wrap')) {
      $('search-dropdown').style.display = 'none';
    }
  });

  // ── Sell modal
  $('sell-qty')?.addEventListener('input', updateSellEstimate);
  $('btn-max')?.addEventListener('click', () => {
    if (assetForSale) { $('sell-qty').value = assetForSale.amount; updateSellEstimate(); }
  });
  $('btn-sell-cancel')?.addEventListener('click', closeSellModal);
  $('btn-sell-confirm')?.addEventListener('click', confirmSell);
});
