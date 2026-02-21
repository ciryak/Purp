// ===== ESTADO GLOBAL =====
let detailChart = null;
let mainChart = null;
let searchTimeout = null;
let assetForSale = null;
let authToken = null;
let currentUser = null;
let portfolioAssetsCount = 0;
let portfolioSymbolSet = new Set();
let refreshIntervalId = null;
let lastDataUpdate = 0;

const REFRESH_INTERVAL_MS = 30000; // 30s — não sobrecarrega o backend
const API_BASE = 'https://purp-backend.railway.app';
const FREE_ASSET_LIMIT = 4;

const formatMoney = (val) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val ?? 0);

// ===== AUTH HELPERS =====

function getAuthHeaders() {
    return authToken ? { 'X-Auth-Token': authToken } : {};
}

function saveAuth(token, user) {
    authToken = token;
    currentUser = user;
    localStorage.setItem('authToken', token);
    localStorage.setItem('currentUser', JSON.stringify(user));
}

function loadAuth() {
    const token = localStorage.getItem('authToken');
    const userStr = localStorage.getItem('currentUser');
    if (token && userStr) {
        try {
            authToken = token;
            currentUser = JSON.parse(userStr);
            return true;
        } catch (e) { return false; }
    }
    return false;
}

function clearAuth() {
    authToken = null;
    currentUser = null;
    portfolioAssetsCount = 0;
    portfolioSymbolSet = new Set();
    stopAutoRefresh();
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
}

function isPremium() {
    return !!currentUser?.is_premium;
}

function normSymbolForCompare(sym) {
    return (sym || '').toString().trim().toUpperCase().replace('-USD', '');
}

// ===== REFRESH =====

function startAutoRefresh() {
    stopAutoRefresh();
    refreshIntervalId = setInterval(() => {
        if (!authToken) return;
        const now = Date.now();
        if (now - lastDataUpdate >= REFRESH_INTERVAL_MS) {
            lastDataUpdate = now;
            fetchPortfolio();
            loadMainChart(true);
        }
    }, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
}

// ===== LOGIN / REGISTER / LOGOUT =====

function showLoginScreen() {
    document.getElementById('login-screen').classList.remove('hidden');
}

function hideLoginScreen() {
    document.getElementById('login-screen').classList.add('hidden');
}

async function handleLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');

    if (!username || !password) {
        errorEl.textContent = 'Preencha usuário e senha';
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            const data = await res.json();
            saveAuth(data.token, data.user);
            hideLoginScreen();
            updateProfileBar();
            fetchPortfolio();
            loadMainChart();
            startAutoRefresh();
            errorEl.textContent = '';
        } else {
            const err = await res.json().catch(() => ({}));
            errorEl.textContent = err.detail || 'Usuário ou senha incorretos';
        }
    } catch (e) {
        errorEl.textContent = 'Erro de conexão';
    }
}

async function handleRegister() {
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const email = document.getElementById('register-email').value.trim();
    const errorEl = document.getElementById('register-error');

    if (!username || !email || !password || password.length < 4) {
        errorEl.textContent = 'Preencha todos os campos (senha mín. 4 caracteres)';
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        if (res.ok) {
            const data = await res.json();
            saveAuth(data.token, data.user);
            hideLoginScreen();
            updateProfileBar();
            fetchPortfolio();
            loadMainChart();
            startAutoRefresh();
            errorEl.textContent = '';
        } else {
            const err = await res.json().catch(() => ({}));
            errorEl.textContent = err.detail || 'Erro ao criar conta';
        }
    } catch (e) {
        errorEl.textContent = 'Erro de conexão';
    }
}

async function handleLogout() {
    try {
        await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
    } catch (e) {}
    clearAuth();
    showLoginScreen();
}

function toggleLoginRegister() {
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const isLogin = loginForm.style.display !== 'none';
    loginForm.style.display = isLogin ? 'none' : 'block';
    registerForm.style.display = isLogin ? 'block' : 'none';
    document.getElementById('login-error').textContent = '';
    document.getElementById('register-error').textContent = '';
}

// ===== PROFILE BAR =====

function updateProfileBar() {
    const nameEl = document.getElementById('profile-username');
    const planEl = document.getElementById('profile-plan');
    const limitEl = document.getElementById('profile-assets-limit');
    const upgradeBtn = document.getElementById('btn-upgrade');
    const avatarEl = document.getElementById('profile-avatar-letter');

    const username = currentUser?.username || '...';
    if (nameEl) nameEl.innerText = username;
    if (avatarEl) avatarEl.innerText = username.charAt(0).toUpperCase();

    if (planEl) {
        planEl.innerText = isPremium() ? 'Premium' : 'Grátis';
        planEl.className = isPremium() ? 'plan-badge premium' : 'plan-badge';
    }

    if (limitEl) {
        limitEl.innerText = isPremium()
            ? `${portfolioAssetsCount} ativos`
            : `${portfolioAssetsCount}/${FREE_ASSET_LIMIT} ativos`;
    }

    if (upgradeBtn) {
        upgradeBtn.style.display = isPremium() ? 'none' : '';
    }
}

// ===== UPGRADE MODAL =====

function showUpgradeModal(reason) {
    const reasonEl = document.getElementById('upgrade-reason');
    if (reasonEl) reasonEl.innerText = reason || 'Desbloqueie recursos avançados.';
    document.getElementById('modal-upgrade')?.classList.add('active');
}

function hideUpgradeModal() {
    document.getElementById('modal-upgrade')?.classList.remove('active');
}

async function handleUpgrade() {
    try {
        const res = await fetch(`${API_BASE}/stripe/create-checkout`, {
            method: 'POST',
            headers: getAuthHeaders()
        });
        const data = await res.json();
        if (data.checkout_url) {
            chrome.tabs.create({ url: data.checkout_url });
        }
    } catch (e) {
        alert('Erro ao iniciar pagamento. Tente novamente.');
    }
}

// Expõe globalmente para uso inline se necessário
window.handleUpgrade = handleUpgrade;

// ===== MENU =====

function closeMenu() {
    const navMenu = document.getElementById('nav-menu');
    const btnHamburger = document.getElementById('btn-hamburger');
    navMenu?.classList.add('hidden');
    btnHamburger?.classList.remove('active');
}

// ===== INICIALIZAÇÃO =====

document.addEventListener('DOMContentLoaded', () => {
    if (loadAuth()) {
        hideLoginScreen();
        updateProfileBar();
        fetchPortfolio();
        loadMainChart();
        startAutoRefresh();
    } else {
        showLoginScreen();
    }
    setupListeners();
    document.getElementById('nav-carteira')?.classList.add('active');
});

function setupListeners() {
    // Auth
    document.getElementById('btn-login').onclick = handleLogin;
    document.getElementById('btn-register').onclick = handleRegister;
    document.getElementById('btn-show-register').onclick = toggleLoginRegister;
    document.getElementById('btn-show-login').onclick = toggleLoginRegister;

    document.getElementById('login-password').onkeypress = (e) => {
        if (e.key === 'Enter') handleLogin();
    };
    document.getElementById('register-password').onkeypress = (e) => {
        if (e.key === 'Enter') handleRegister();
    };

    // Hamburger
    const btnHamburger = document.getElementById('btn-hamburger');
    const navMenu = document.getElementById('nav-menu');
    if (btnHamburger && navMenu) {
        btnHamburger.onclick = () => {
            const isOpen = !navMenu.classList.contains('hidden');
            if (isOpen) {
                closeMenu();
            } else {
                navMenu.classList.remove('hidden');
                btnHamburger.classList.add('active');
            }
        };
    }

    // Nav items
    document.getElementById('nav-carteira').onclick = () => { switchTab('dashboard'); closeMenu(); };
    document.getElementById('nav-adicionar').onclick = () => { switchTab('add-asset'); closeMenu(); };
    document.getElementById('nav-sair').onclick = () => { closeMenu(); handleLogout(); };

    // IA Portfolio
    document.getElementById('btn-portfolio-ai')?.addEventListener('click', handlePortfolioAI);

    // Upgrade
    document.getElementById('btn-upgrade').onclick = () =>
        showUpgradeModal('Desbloqueie IA e acompanhe ativos ilimitados por US$ 15/mês.');
    document.getElementById('upgrade-cancel').onclick = hideUpgradeModal;
    document.getElementById('upgrade-confirm').onclick = () => {
        hideUpgradeModal();
        handleUpgrade();
    };

    // Back
    document.getElementById('btn-back').onclick = () =>
        document.getElementById('detail-view').classList.remove('active');

    // Main chart controls
    document.getElementById('main-benchmark').onchange = () => loadMainChart();
    document.querySelectorAll('.pill').forEach(btn => {
        btn.onclick = (e) => {
            document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            loadMainChart();
        };
    });

    // Save asset
    document.getElementById('btn-save').onclick = handleAddAsset;

    // Modal sell
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').onclick = confirmSell;
    document.getElementById('sell-amount-input').oninput = updateSellCalc;
    document.getElementById('btn-max').onclick = () => {
        if (assetForSale) {
            document.getElementById('sell-amount-input').value = assetForSale.amount;
            updateSellCalc();
        }
    };

    // Search
    document.getElementById('symbol').oninput = (e) => {
        clearTimeout(searchTimeout);
        const val = e.target.value.trim();
        if (val.length < 2) {
            document.getElementById('search-results').style.display = 'none';
            return;
        }
        searchTimeout = setTimeout(() => performSearch(val), 400);
    };

    // Time detail chart
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.onclick = (e) => {
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const sym = document.getElementById('detail-symbol').innerText;
            if (sym && sym !== '—') fetchHistoryAndRender(sym, e.target.getAttribute('data-period'));
        };
    });
}

// ===== GRÁFICO PRINCIPAL =====

async function loadMainChart(skipAnimation = false) {
    if (!authToken) return;

    const ctx = document.getElementById('mainChart')?.getContext('2d');
    if (!ctx) return;

    if (mainChart) { mainChart.destroy(); mainChart = null; }

    const period = document.querySelector('.pill.active')?.dataset.p || '1mo';
    const bench = document.getElementById('main-benchmark')?.value || '^GSPC';

    try {
        const res = await fetch(`${API_BASE}/portfolio/history?period=${period}&benchmark=${bench}`, {
            headers: getAuthHeaders()
        });

        if (!res.ok) {
            if (res.status === 401) { clearAuth(); showLoginScreen(); }
            return;
        }

        const data = await res.json();
        if (!data.portfolio || data.portfolio.length === 0) return;

        const startPort = data.portfolio[0];
        const startBench = data.benchmark[0] || 1;

        const normPort = data.portfolio.map(v => ((v - startPort) / startPort) * 100);
        const normBench = data.benchmark.map(v => ((v - startBench) / startBench) * 100);

        mainChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates,
                datasets: [
                    {
                        label: 'Carteira',
                        data: normPort,
                        borderColor: '#a78bfa',
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.4
                    },
                    {
                        label: bench,
                        data: normBench,
                        borderColor: '#444',
                        borderWidth: 1,
                        borderDash: [4, 4],
                        pointRadius: 0,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: skipAnimation ? false : { duration: 400, easing: 'easeOutQuart' },
                plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
                scales: { x: { display: false }, y: { display: false } }
            }
        });
    } catch (e) {
        console.error('Erro chart principal:', e);
    }
}

// ===== HISTÓRICO DETALHE =====

async function fetchHistoryAndRender(symbol, period) {
    const ctx = document.getElementById('detailChart')?.getContext('2d');
    if (!ctx) return;
    if (detailChart) { detailChart.destroy(); detailChart = null; }

    try {
        const res = await fetch(`${API_BASE}/history/${symbol}?period=${period}`);
        const data = await res.json();

        if (!data.prices || data.prices.length === 0) return;

        const grad = ctx.createLinearGradient(0, 0, 0, 280);
        grad.addColorStop(0, 'rgba(124,58,237,0.4)');
        grad.addColorStop(1, 'rgba(124,58,237,0)');

        detailChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates || [],
                datasets: [{
                    data: data.prices,
                    borderColor: '#7c3aed',
                    backgroundColor: grad,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300, easing: 'easeOutQuart' },
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { display: false } },
                scales: {
                    x: { display: false },
                    y: {
                        display: true,
                        position: 'right',
                        grid: { color: 'rgba(255,255,255,0.04)' },
                        ticks: { color: 'rgba(255,255,255,0.3)', font: { family: 'DM Mono', size: 9 } }
                    }
                }
            }
        });
    } catch (e) {
        console.error('Erro histórico:', e);
    }
}

// ===== BUSCA =====

async function performSearch(q) {
    try {
        const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        const box = document.getElementById('search-results');
        box.innerHTML = '';

        if (data.length > 0) {
            box.style.display = 'block';
            data.forEach(item => {
                const imgHtml = item.icon
                    ? `<img src="${item.icon}" alt="${item.symbol}" onerror="this.style.display='none'">`
                    : '';
                const div = document.createElement('div');
                div.className = 'search-item';
                div.innerHTML = `${imgHtml}<strong>${item.symbol}</strong><span style="font-size:11px;color:var(--text-2)">${item.name || ''}</span><span class="search-tag">${item.type}</span>`;
                div.onclick = () => {
                    document.getElementById('symbol').value = item.symbol;
                    box.style.display = 'none';
                };
                box.appendChild(div);
            });
        } else {
            box.style.display = 'none';
        }
    } catch (e) {
        console.error('Erro busca:', e);
    }
}

// ===== CARTEIRA =====

async function fetchPortfolio() {
    if (!authToken) return;

    try {
        const res = await fetch(`${API_BASE}/portfolio/balance`, {
            headers: getAuthHeaders()
        });

        if (!res.ok) {
            if (res.status === 401) { clearAuth(); showLoginScreen(); }
            return;
        }

        const data = await res.json();
        document.getElementById('total-balance').innerText = formatMoney(data.total_balance_usd);
        portfolioAssetsCount = (data.assets || []).length;
        portfolioSymbolSet = new Set((data.assets || []).map(a => normSymbolForCompare(a.real_symbol || a.symbol)));
        updateProfileBar();

        const list = document.getElementById('assets-list');
        list.innerHTML = '';

        if (data.assets.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📭</div>
                    <div class="empty-title">Carteira vazia</div>
                    <div class="empty-sub">Adicione seu primeiro ativo para começar a acompanhar seu portfólio.</div>
                </div>`;
            return;
        }

        data.assets.forEach(asset => {
            const div = document.createElement('div');
            div.className = 'asset-wrapper';
            const profit = asset.profit || 0;
            const isProfit = profit >= 0;
            const colorClass = isProfit ? 'text-green' : 'text-red';
            const profitSign = isProfit ? '+' : '';
            const pct = asset.percent_change ? `${asset.percent_change >= 0 ? '+' : ''}${asset.percent_change.toFixed(2)}%` : '';

            const sym2 = (asset.symbol || '').substring(0, 2).toUpperCase();
            const iconHtml = asset.icon
                ? `<img src="${asset.icon}" class="asset-icon" alt="${asset.symbol}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                   <div class="asset-icon-fallback" style="display:none;">${sym2}</div>`
                : `<div class="asset-icon-fallback">${sym2}</div>`;

            div.innerHTML = `
                <div class="asset-main">
                    <div class="asset-left">
                        <div style="position:relative;width:34px;height:34px;flex-shrink:0;">
                            ${iconHtml}
                        </div>
                        <div>
                            <div class="asset-name">${asset.symbol}</div>
                            <div class="asset-price">${formatMoney(asset.current_price)} <span class="${colorClass}">${pct}</span></div>
                        </div>
                    </div>
                    <div class="asset-spark"><canvas id="c-${asset.id}"></canvas></div>
                    <div class="asset-values">
                        <div class="asset-value">${formatMoney(asset.position_value)}</div>
                        <div class="asset-profit ${colorClass}">${profitSign}${formatMoney(profit)}</div>
                    </div>
                </div>
                <div class="action-bar">
                    <button class="icon-btn ai-btn" data-id="${asset.id}">✨ Análise IA</button>
                    <button class="icon-btn sell-btn" data-id="${asset.id}">📉 Vender</button>
                </div>
                <div id="ai-${asset.id}" class="ai-analysis-text"></div>
            `;

            div.querySelector('.asset-main').onclick = () => openDetail(asset);
            div.querySelector('.sell-btn').onclick = (e) => { e.stopPropagation(); openSellModal(asset); };
            div.querySelector('.ai-btn').onclick = (e) => { e.stopPropagation(); askAI(asset); };

            list.appendChild(div);
            renderSpark(`c-${asset.id}`, asset.history || [], isProfit ? '#10b981' : '#ef4444');
        });
    } catch (e) {
        console.error('Erro fetchPortfolio:', e);
    }
}

// ===== MODAL VENDA =====

function openSellModal(asset) {
    assetForSale = asset;
    document.getElementById('modal-sell').classList.add('active');

    const input = document.getElementById('sell-amount-input');
    input.value = asset.amount;
    input.max = asset.amount;

    document.getElementById('modal-sell-info').innerText =
        `Qtd atual: ${asset.amount} • Preço médio: ${formatMoney(asset.purchase_price)}`;
    updateSellCalc();
}

function updateSellCalc() {
    if (!assetForSale) return;
    const input = document.getElementById('sell-amount-input');
    let qty = parseFloat(input.value) || 0;

    if (qty > assetForSale.amount) { qty = assetForSale.amount; input.value = qty; }
    if (qty < 0) qty = 0;

    const total = qty * assetForSale.current_price;
    const profit = (assetForSale.current_price - assetForSale.purchase_price) * qty;
    const isWin = profit >= 0;

    document.getElementById('sell-profit-estimate').innerHTML =
        `${formatMoney(total)}<br><span class="${isWin ? 'text-green' : 'text-red'}" style="font-size:13px;">
            ${isWin ? '+' : ''}${formatMoney(profit)}
        </span>`;
}

async function confirmSell() {
    if (!assetForSale || !authToken) return;
    const qty = parseFloat(document.getElementById('sell-amount-input').value);
    if (!qty || qty <= 0) return;

    const btn = document.getElementById('modal-confirm');
    btn.innerText = '...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/assets/${assetForSale.id}/sell`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: qty })
        });

        if (res.ok) {
            closeModal();
            fetchPortfolio();
            loadMainChart();
        } else if (res.status === 401) {
            clearAuth();
            showLoginScreen();
        } else {
            const err = await res.json().catch(() => ({}));
            alert(err.detail || 'Erro ao vender');
        }
    } catch (e) {
        alert('Erro de conexão');
    } finally {
        btn.innerText = 'Confirmar Venda';
        btn.disabled = false;
    }
}

function closeModal() {
    document.getElementById('modal-sell').classList.remove('active');
    assetForSale = null;
}

// ===== DETALHE =====

function openDetail(asset) {
    const detailView = document.getElementById('detail-view');
    detailView.classList.add('active');

    document.getElementById('detail-symbol').innerText = asset.symbol;
    document.getElementById('detail-price').innerText = formatMoney(asset.current_price);
    document.getElementById('days-held-badge').innerText = `Holding: ${asset.days_held || 0} dias`;

    // Ícone com fallback
    const iconEl = document.getElementById('detail-icon');
    const fallbackEl = document.getElementById('detail-icon-fallback');
    if (asset.icon) {
        iconEl.src = asset.icon;
        iconEl.style.display = 'block';
        fallbackEl.style.display = 'none';
        iconEl.onerror = () => {
            iconEl.style.display = 'none';
            fallbackEl.style.display = 'flex';
            fallbackEl.innerText = asset.symbol.substring(0, 2).toUpperCase();
        };
    } else {
        iconEl.style.display = 'none';
        fallbackEl.style.display = 'flex';
        fallbackEl.innerText = asset.symbol.substring(0, 2).toUpperCase();
    }

    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-period="1mo"]')?.classList.add('active');
    fetchHistoryAndRender(asset.real_symbol || asset.symbol, '1mo');
}

// ===== IA INDIVIDUAL =====

async function askAI(asset) {
    if (!authToken) return;

    if (!isPremium()) {
        showUpgradeModal('Análise IA individual disponível apenas no plano Premium.');
        return;
    }

    const div = document.getElementById(`ai-${asset.id}`);
    if (!div) return;
    div.style.display = 'block';
    div.innerHTML = '<span style="color:var(--text-3)">Analisando...</span>';

    try {
        const res = await fetch(
            `${API_BASE}/analysis/${encodeURIComponent(asset.symbol)}?change=${asset.percent_change || 0}`,
            { headers: getAuthHeaders() }
        );

        if (res.ok) {
            const data = await res.json();
            div.innerHTML = `<strong style="color:var(--accent-light)">IA:</strong> ${data.analysis}`;
        } else if (res.status === 402) {
            div.style.display = 'none';
            const err = await res.json().catch(() => ({}));
            showUpgradeModal(err.detail || 'Recurso Premium.');
        } else {
            div.style.display = 'none';
        }
    } catch (e) {
        div.style.display = 'none';
    }
}

// ===== IA PORTFOLIO =====

async function handlePortfolioAI() {
    if (!authToken) { showLoginScreen(); return; }

    if (!isPremium()) {
        showUpgradeModal('Análise consolidada da carteira disponível apenas no plano Premium.');
        return;
    }

    const box = document.getElementById('ai-portfolio-text');
    const badge = document.getElementById('ai-portfolio-change');
    if (!box || !badge) return;

    box.innerText = 'Gerando análise...';

    try {
        const res = await fetch(`${API_BASE}/analysis/portfolio`, {
            headers: getAuthHeaders()
        });

        if (res.ok) {
            const data = await res.json();
            box.innerText = data.analysis || 'Análise indisponível no momento.';

            if (typeof data.change_pct === 'number') {
                const v = data.change_pct;
                badge.classList.remove('positive', 'negative');
                badge.innerText = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
                badge.classList.add(v > 0 ? 'positive' : v < 0 ? 'negative' : '');
            }
        } else if (res.status === 402) {
            const err = await res.json().catch(() => ({}));
            showUpgradeModal(err.detail || 'Recurso Premium.');
            box.innerText = 'Disponível apenas no plano Premium.';
        } else {
            box.innerText = 'Erro ao buscar análise.';
        }
    } catch (e) {
        box.innerText = 'Erro de conexão com o servidor.';
    }
}

// ===== SPARKLINE =====

function renderSpark(id, data, color) {
    const ctx = document.getElementById(id)?.getContext('2d');
    if (!ctx || !data || data.length === 0) return;

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map((_, i) => i),
            datasets: [{
                data,
                borderColor: color,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.4,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } }
        }
    });
}

// ===== TABS =====

function switchTab(t) {
    document.querySelectorAll('.container').forEach(e => e.classList.remove('active'));
    document.getElementById(t)?.classList.add('active');

    document.getElementById('nav-carteira')?.classList.toggle('active', t === 'dashboard');
    document.getElementById('nav-adicionar')?.classList.toggle('active', t === 'add-asset');

    if (t === 'dashboard') loadMainChart();
}

// ===== ADD ASSET =====

async function handleAddAsset() {
    if (!authToken) { showLoginScreen(); return; }

    const symRaw = document.getElementById('symbol').value.trim();
    const inputSymNorm = normSymbolForCompare(symRaw);
    const isExisting = portfolioSymbolSet.has(inputSymNorm);

    if (!isPremium() && portfolioAssetsCount >= FREE_ASSET_LIMIT && !isExisting) {
        showUpgradeModal(`Limite de ${FREE_ASSET_LIMIT} ativos atingido. Vire Premium para ilimitados.`);
        return;
    }

    const amount = document.getElementById('amount').value;
    const price = document.getElementById('price').value;
    const purchaseDate = document.getElementById('date').value;

    if (!symRaw || !amount || !price) {
        alert('Preencha símbolo, quantidade e preço.');
        return;
    }

    const btn = document.getElementById('btn-save');
    btn.innerText = '...';
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/assets/`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol: symRaw,
                amount: parseFloat(amount),
                purchase_price: parseFloat(price),
                purchase_date: purchaseDate || ''
            })
        });

        if (res.ok) {
            document.getElementById('add-form')?.reset();
            document.getElementById('symbol').value = '';
            document.getElementById('amount').value = '';
            document.getElementById('price').value = '';
            document.getElementById('date').value = '';
            switchTab('dashboard');
            fetchPortfolio();
            loadMainChart();
        } else if (res.status === 401) {
            clearAuth();
            showLoginScreen();
        } else if (res.status === 402) {
            const err = await res.json().catch(() => ({}));
            showUpgradeModal(err.detail || 'Recurso Premium.');
        } else if (res.status === 404) {
            alert('Ativo não encontrado. Verifique o símbolo.');
        } else {
            alert('Erro ao salvar ativo.');
        }
    } catch (e) {
        alert('Erro de conexão.');
    } finally {
        btn.innerText = 'Salvar Ativo';
        btn.disabled = false;
    }
}

// ===== EXPORT CSV =====

async function exportCSV() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_BASE}/portfolio/balance`, { headers: getAuthHeaders() });
        const data = await res.json();

        let csv = 'Simbolo,Quantidade,Preco Compra,Preco Atual,Valor,Lucro/Prejuizo\n';
        (data.assets || []).forEach(a => {
            csv += `${a.symbol},${a.amount},${a.purchase_price},${a.current_price},${a.position_value},${a.profit}\n`;
        });

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'purp-carteira.csv';
        link.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error('Erro ao exportar CSV:', e);
    }
}
