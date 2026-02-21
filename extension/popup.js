let detailChart = null;
let mainChart = null;
let searchTimeout = null;
let assetForSale = null;
let authToken = null;
let currentUser = null;
let portfolioAssetsCount = 0;
let portfolioSymbolSet = new Set();
let refreshIntervalId = null;
let lastDataUpdate = 0; // ⭐ Controla atualização de dados
const REFRESH_INTERVAL_MS = 5000;
const DATA_UPDATE_THRESHOLD = 1000; // Só atualiza dados se mudou após 1s

const API_BASE = 'https://purp-backend.railway.app';
const FREE_ASSET_LIMIT = 4;

const formatMoney = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);

// ========== AUTENTICAÇÃO ==========

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
        authToken = token;
        currentUser = JSON.parse(userStr);
        return true;
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

function startAutoRefresh() {
    stopAutoRefresh();
    refreshIntervalId = setInterval(() => {
        if (authToken) {
            const now = Date.now();
            // ⭐ Só atualiza dados se passou tempo suficiente
            if (now - lastDataUpdate >= DATA_UPDATE_THRESHOLD) {
                lastDataUpdate = now;
                fetchPortfolio();
                loadMainChart(true); // ⭐ true = skip animation
            }
        }
    }, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
}

function showLoginScreen() {
    document.getElementById('login-screen').classList.remove('hidden');
}

function hideLoginScreen() {
    document.getElementById('login-screen').classList.add('hidden');
}

function isPremium() {
    return !!currentUser?.is_premium;
}

function normSymbolForCompare(sym) {
    return (sym || '')
        .toString()
        .trim()
        .toUpperCase()
        .replace('-USD', '');
}

function updateProfileBar() {
    const nameEl = document.getElementById('profile-username');
    const planEl = document.getElementById('profile-plan');
    const limitEl = document.getElementById('profile-assets-limit');
    const upgradeBtn = document.getElementById('btn-upgrade');

    if (nameEl) nameEl.innerText = currentUser?.username ? currentUser.username : '...';
    if (planEl) planEl.innerText = `Plano: ${isPremium() ? 'Premium' : 'Grátis'}`;

    if (limitEl) {
        limitEl.innerText = isPremium()
            ? `Ativos: ${portfolioAssetsCount}`
            : `Ativos: ${portfolioAssetsCount}/${FREE_ASSET_LIMIT}`;
    }

    if (upgradeBtn) {
        if (isPremium()) upgradeBtn.classList.add('hidden');
        else upgradeBtn.classList.remove('hidden');
    }
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
    } catch(e) {
        alert('Erro ao iniciar pagamento. Tente novamente.');
    }
}


function hideUpgradeModal() {
    document.getElementById('modal-upgrade')?.classList.remove('active');
}

async function handleLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');
    
    if (!username || !password) {
        errorEl.textContent = 'Preencha usuário e senha';
        errorEl.style.display = 'block';
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
            fetchPortfolio();
            loadMainChart();
            updateProfileBar();
            startAutoRefresh();
            errorEl.style.display = 'none';
        } else {
            const err = await res.json();
            errorEl.textContent = err.detail || 'Erro ao fazer login';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Erro de conexão';
        errorEl.style.display = 'block';
    }
}

async function handleRegister() {
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    const email = document.getElementById('register-email').value.trim();
    const errorEl = document.getElementById('register-error');
    
    if (!username || !email || !password || password.length < 4) {
        errorEl.textContent = 'Usuário, email e senha (mín. 4 caracteres) são obrigatórios';
        errorEl.style.display = 'block';
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
            fetchPortfolio();
            loadMainChart();
            updateProfileBar();
            startAutoRefresh();
            errorEl.style.display = 'none';
        } else {
            const err = await res.json();
            errorEl.textContent = err.detail || 'Erro ao criar conta';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Erro de conexão';
        errorEl.style.display = 'block';
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
    document.getElementById('login-error').style.display = 'none';
    document.getElementById('register-error').style.display = 'none';
}

// ========== INICIALIZAÇÃO ==========

document.addEventListener('DOMContentLoaded', () => {
    if (loadAuth()) {
        hideLoginScreen();
        fetchPortfolio();
        loadMainChart();
        updateProfileBar();
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
    
    // Menu hambúrguer com animação
    const btnHamburger = document.getElementById('btn-hamburger');
    const navMenu = document.getElementById('nav-menu');
    if (btnHamburger && navMenu) {
        btnHamburger.onclick = () => {
            const isOpen = !navMenu.classList.contains('hidden');
            if (isOpen) {
                navMenu.classList.add('hidden');
                btnHamburger.classList.remove('active');
            } else {
                navMenu.classList.remove('hidden');
                navMenu.style.animation = 'slideDown 0.3s ease-out';
                btnHamburger.classList.add('active');
            }
        };
    }
    
    // Fecha menu ao clicar em item
    document.getElementById('nav-carteira').onclick = () => {
        switchTab('dashboard');
        closeMenu();
    };
    document.getElementById('nav-adicionar').onclick = () => {
        switchTab('add-asset');
        closeMenu();
    };
    document.getElementById('nav-sair').onclick = () => {
        closeMenu();
        handleLogout();
    };

    // IA Portfolio
    const btnPortfolioAI = document.getElementById('btn-portfolio-ai');
    if (btnPortfolioAI) {
        btnPortfolioAI.onclick = handlePortfolioAI;
    }

    // Upgrade
    document.getElementById('btn-upgrade').onclick = () => showUpgradeModal('Desbloqueie IA e acompanhe mais de 4 ativos por US$ 15/mês.');
    document.getElementById('upgrade-cancel').onclick = hideUpgradeModal;
    document.getElementById('upgrade-confirm').onclick = () => {
        // Placeholder: aqui você pluga checkout (Stripe, etc.)
        hideUpgradeModal();
        alert("Checkout Premium: implemente seu link de pagamento aqui.");
    };
    
    // Enter key nos formulários
    document.getElementById('login-password').onkeypress = (e) => {
        if (e.key === 'Enter') handleLogin();
    };
    document.getElementById('register-password').onkeypress = (e) => {
        if (e.key === 'Enter') handleRegister();
    };
    
    // Back
    document.getElementById('btn-back').onclick = () => document.getElementById('detail-view').classList.remove('active');
    
    // Main Chart Controls
    document.getElementById('main-benchmark').onchange = loadMainChart;
    document.querySelectorAll('.time-btn-mini').forEach(btn => {
        btn.onclick = (e) => {
            document.querySelectorAll('.time-btn-mini').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            loadMainChart();
        };
    });

    // Actions
    document.getElementById('btn-save').onclick = handleAddAsset;
    
    // Modal Sell
    document.getElementById('modal-cancel').onclick = closeModal;
    document.getElementById('modal-confirm').onclick = confirmSell;
    document.getElementById('sell-amount-input').oninput = updateSellCalc;
    document.getElementById('btn-max').onclick = () => {
        if(assetForSale) {
            document.getElementById('sell-amount-input').value = assetForSale.amount;
            updateSellCalc();
        }
    };

    // Search
    document.getElementById('symbol').oninput = (e) => {
        clearTimeout(searchTimeout);
        if(e.target.value.length < 2) return document.getElementById('search-results').style.display='none';
        searchTimeout = setTimeout(() => performSearch(e.target.value), 400);
    };

    // Time Detail
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.onclick = (e) => {
            document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const sym = document.getElementById('detail-symbol').innerText;
            fetchHistoryAndRender(sym, e.target.getAttribute('data-period'));
        };
    });
}

// ========== GRÁFICO PRINCIPAL ==========

async function loadMainChart(skipAnimation = false) {
    if (!authToken) return;
    
    const ctx = document.getElementById('mainChart')?.getContext('2d');
    if (!ctx) return;
    
    if(mainChart) mainChart.destroy();

    const period = document.querySelector('.time-btn-mini.active')?.dataset.p || '1mo';
    const bench = document.getElementById('main-benchmark')?.value || '^GSPC';

    try {
        const res = await fetch(`${API_BASE}/portfolio/history?period=${period}&benchmark=${bench}`, {
            headers: getAuthHeaders()
        });
        
        if (!res.ok) {
            if (res.status === 401) {
                clearAuth();
                showLoginScreen();
            }
            return;
        }
        
        const data = await res.json();
        
        if(data.portfolio.length === 0) return;

        const startPort = data.portfolio[0];
        const startBench = data.benchmark[0];
        
        const normPort = data.portfolio.map(v => ((v - startPort)/startPort)*100);
        const normBench = data.benchmark.map(v => ((v - startBench)/startBench)*100);

        mainChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates,
                datasets: [
                    {
                        label: 'Minha Carteira',
                        data: normPort,
                        borderColor: '#7b42f6',
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.4
                    },
                    {
                        label: bench,
                        data: normBench,
                        borderColor: '#555',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        pointRadius: 0,
                        tension: 0.4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: skipAnimation ? false : {
                    duration: 300,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    legend: { display: false },
                    tooltip: { mode: 'index', intersect: false }
                },
                scales: {
                    x: { display: false },
                    y: { display: false }
                }
            }
        });

    } catch(e) { 
        console.error("Erro chart principal", e);
        if (e.message?.includes('401')) {
            clearAuth();
            showLoginScreen();
        }
    }
}

// ⭐ Atualizado para skipAnimation
async function fetchHistoryAndRender(symbol, period) {
    const ctx = document.getElementById('detailChart')?.getContext('2d');
    if(!ctx) return;
    if(detailChart) detailChart.destroy();

    try {
        const res = await fetch(`${API_BASE}/history/${symbol}?period=${period}`);
        const data = await res.json();

        if (!data.prices || data.prices.length === 0) {
            console.warn("Sem dados de preço para", symbol);
            return;
        }

        const grad = ctx.createLinearGradient(0,0,0,300);
        grad.addColorStop(0, 'rgba(123,66,246,0.5)');
        grad.addColorStop(1, 'rgba(123,66,246,0)');

        detailChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates || [],
                datasets: [{
                    data: data.prices,
                    borderColor: '#7b42f6',
                    backgroundColor: grad,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 300,
                    easing: 'easeOutQuart'
                },
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: false },
                scales: {
                    x: { display: false },
                    y: {
                        display: true,
                        position: 'right',
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    }
                }
            }
        });
    } catch(e) {
        console.error("Erro ao carregar histórico", e);
    }
}

// ========== BUSCA ==========

async function performSearch(q) {
    const res = await fetch(`${API_BASE}/search?q=${q}`);
    const data = await res.json();
    const box = document.getElementById('search-results');
    box.innerHTML = '';
    
    if(data.length > 0) {
        box.style.display = 'block';
        data.forEach(item => {
            const img = item.icon ? `<img src="${item.icon}" style="width:16px;height:16px;border-radius:50%;object-fit:cover;">` : '';
            const div = document.createElement('div');
            div.className = 'search-item';
            div.innerHTML = `${img} <strong>${item.symbol}</strong> <span class="search-tag">${item.type}</span>`;
            div.onclick = () => {
                document.getElementById('symbol').value = item.symbol;
                box.style.display = 'none';
            };
            box.appendChild(div);
        });
    } else box.style.display = 'none';
}

// ========== CARTEIRA ==========

async function fetchPortfolio() {
    if (!authToken) return;
    
    try {
        const res = await fetch(`${API_BASE}/portfolio/balance`, {
            headers: getAuthHeaders()
        });
        
        if (!res.ok) {
            if (res.status === 401) {
                clearAuth();
                showLoginScreen();
            }
            return;
        }
        
        const data = await res.json();
        document.getElementById('total-balance').innerText = formatMoney(data.total_balance_usd);
        portfolioAssetsCount = (data.assets || []).length;
        portfolioSymbolSet = new Set((data.assets || []).map(a => normSymbolForCompare(a.real_symbol || a.symbol)));
        updateProfileBar();
        
        const list = document.getElementById('assets-list');
        list.innerHTML = '';
        if(data.assets.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:20px;color:#666">Carteira vazia</div>';
            return;
        }

        data.assets.forEach(asset => {
            const div = document.createElement('div');
            div.className = 'asset-wrapper';
            const profit = asset.profit || 0;
            const color = profit >= 0 ? '#00ff88' : '#ff4d4d';
            
            // Ícone com fallback e tamanho fixo
            const iconSrc = asset.icon || '';
            const iconHtml = iconSrc 
                ? `<img src="${iconSrc}" class="asset-icon" onerror="this.style.display='none';">`
                : '<div class="asset-icon" style="background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;">' + asset.symbol.substring(0,2) + '</div>';
            
            div.innerHTML = `
                <div class="asset-main" style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; gap:10px; align-items:center; width:40%">
                        ${iconHtml}
                        <div>
                            <div style="font-weight:bold; font-size:15px">${asset.symbol}</div>
                            <div style="font-size:11px; color:#aaa">${formatMoney(asset.current_price)}</div>
                        </div>
                    </div>
                    <div style="width:60px; height:30px"><canvas id="c-${asset.id}"></canvas></div>
                    <div style="text-align:right; width:30%">
                        <div style="font-weight:bold">${formatMoney(asset.position_value)}</div>
                        <div style="color:${color}; font-size:11px">${profit>=0?'+':''}${formatMoney(profit)}</div>
                    </div>
                </div>
                <div class="action-bar">
                    <button class="icon-btn ai-btn" data-id="${asset.id}" style="color:#bca0dc;font-size:11px;">✨ Analisar</button>
                    <button class="icon-btn sell-btn" data-id="${asset.id}">📉 Vender</button>
                </div>
                <div id="ai-${asset.id}" class="ai-analysis-text" style="display:none;margin-top:5px;padding:8px;background:rgba(0,0,0,0.3);color:#ddd;border-radius:8px"></div>
            `;
            
            div.querySelector('.asset-main').onclick = () => openDetail(asset);
            div.querySelector('.sell-btn').onclick = (e) => { e.stopPropagation(); openSellModal(asset); };
            div.querySelector('.ai-btn').onclick = (e) => { e.stopPropagation(); askAI(asset); };

            list.appendChild(div);
            renderSpark(`c-${asset.id}`, asset.history, color);
        });
    } catch(e) { 
        console.error(e);
        if (e.message?.includes('401')) {
            clearAuth();
            showLoginScreen();
        }
    }
}

// ========== MODAL VENDA ==========

function openSellModal(asset) {
    assetForSale = asset;
    document.getElementById('modal-sell').classList.add('active');
    
    const input = document.getElementById('sell-amount-input');
    input.value = asset.amount;
    input.max = asset.amount;
    
    document.getElementById('modal-sell-info').innerText = `Possui: ${asset.amount} | Média: ${formatMoney(asset.purchase_price)}`;
    updateSellCalc();
}

function updateSellCalc() {
    if(!assetForSale) return;
    const input = document.getElementById('sell-amount-input');
    let qty = parseFloat(input.value);
    
    if(qty > assetForSale.amount) { qty = assetForSale.amount; input.value = qty; }
    if(qty < 0) qty = 0;

    const total = qty * assetForSale.current_price;
    const profit = (assetForSale.current_price - assetForSale.purchase_price) * qty;
    const isWin = profit >= 0;

    const valEl = document.getElementById('sell-profit-estimate');
    valEl.innerHTML = `Venda: ${formatMoney(total)}<br><span class="${isWin?'text-green':'text-red'}" style="font-size:14px">Resultado: ${formatMoney(profit)}</span>`;
}

async function confirmSell() {
    if(!assetForSale || !authToken) return;
    const qty = parseFloat(document.getElementById('sell-amount-input').value);
    const btn = document.getElementById('modal-confirm');
    
    btn.innerText = "...";
    try {
        const res = await fetch(`${API_BASE}/assets/${assetForSale.id}/sell`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: qty })
        });
        if(res.ok) {
            closeModal();
            fetchPortfolio();
            loadMainChart();
        } else {
            if (res.status === 401) {
                clearAuth();
                showLoginScreen();
            } else {
                alert("Erro venda");
            }
        }
    } catch(e) { 
        alert("Erro conexão");
    }
    finally { btn.innerText = "Confirmar"; }
}

function closeModal() {
    document.getElementById('modal-sell').classList.remove('active');
    assetForSale = null;
}

// ========== DETALHES ==========

function openDetail(asset) {
    document.getElementById('detail-view').classList.add('active');
    document.getElementById('detail-symbol').innerText = asset.symbol;
    document.getElementById('detail-price').innerText = formatMoney(asset.current_price);
    
    const iconEl = document.getElementById('detail-icon');
    if (asset.icon) {
        iconEl.src = asset.icon;
        iconEl.style.display = 'block';
        iconEl.onerror = () => {
            iconEl.style.display = 'none';
        };
    } else {
        iconEl.style.display = 'none';
    }
    
    document.getElementById('days-held-badge').innerText = `Holding: ${asset.days_held} dias`;
    
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('[data-period="1mo"]')?.classList.add('active');
    
    // Adiciona botão de toggle candles
    let candleBtn = document.getElementById('btn-toggle-candles');
    if (!candleBtn) {
        candleBtn = document.createElement('button');
        candleBtn.id = 'btn-toggle-candles';
        candleBtn.className = 'time-btn';
        candleBtn.textContent = '📊 Candles';
        candleBtn.style.marginLeft = '5px';
        document.querySelector('.time-selector').appendChild(candleBtn);
        candleBtn.onclick = () => {
            const isCandleMode = candleBtn.classList.contains('active');
            if (isCandleMode) {
                candleBtn.classList.remove('active');
                fetchHistoryAndRender(asset.real_symbol, '1mo');
            } else {
                candleBtn.classList.add('active');
                document.querySelectorAll('.time-btn:not(#btn-toggle-candles)').forEach(b => b.classList.remove('active'));
                renderCandleChart('detailChart', asset.real_symbol, '1mo');
            }
        };
    }
    
    fetchHistoryAndRender(asset.real_symbol, '1mo');
}

async function fetchHistoryAndRender(symbol, period) {
    const ctx = document.getElementById('detailChart')?.getContext('2d');
    if(!ctx) return;
    if(detailChart) detailChart.destroy();

    try {
        const res = await fetch(`${API_BASE}/history/${symbol}?period=${period}`);
        const data = await res.json();

        if (!data.prices || data.prices.length === 0) {
            console.warn("Sem dados de preço para", symbol);
            return;
        }

        const grad = ctx.createLinearGradient(0,0,0,300);
        grad.addColorStop(0, 'rgba(123,66,246,0.5)');
        grad.addColorStop(1, 'rgba(123,66,246,0)');

        detailChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.dates || [],
                datasets: [{
                    data: data.prices,
                    borderColor: '#7b42f6',
                    backgroundColor: grad,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    fill: true,
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 300,
                    easing: 'easeOutQuart'
                },
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: false },
                scales: {
                    x: { display: false },
                    y: {
                        display: true,
                        position: 'right',
                        grid: { color: 'rgba(255,255,255,0.05)' }
                    }
                }
            }
        });
    } catch(e) {
        console.error("Erro ao carregar histórico", e);
    }
}

// ========== HELPERS ==========

async function handleAddAsset() {
    if (!authToken) {
        showLoginScreen();
        return;
    }

    const inputSymNorm = normSymbolForCompare(document.getElementById('symbol').value);
    const isExistingAsset = portfolioSymbolSet.has(inputSymNorm);

    if (!isPremium() && portfolioAssetsCount >= FREE_ASSET_LIMIT && !isExistingAsset) {
        showUpgradeModal(`Você atingiu o limite de ${FREE_ASSET_LIMIT} ativos no plano grátis. Vire Premium por US$ 15/mês.`);
        return;
    }
    
    const s = document.getElementById('symbol').value.trim();
    const a = document.getElementById('amount').value;
    const p = document.getElementById('price').value;
    const d = document.getElementById('date').value;

    if(!s || !a || !p) return alert("Preencha tudo");
    
    const btn = document.getElementById('btn-save');
    btn.innerText = "..."; 
    btn.disabled = true;
    
    try {
        const res = await fetch(`${API_BASE}/assets/`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type':'application/json' },
            body: JSON.stringify({ symbol:s, amount: parseFloat(a), purchase_price: parseFloat(p), purchase_date: d || "" })
        });
        if(res.ok) {
            document.getElementById('add-form').reset();
            switchTab('dashboard');
            fetchPortfolio();
            loadMainChart();
        } else {
            if (res.status === 401) {
                clearAuth();
                showLoginScreen();
            } else if (res.status === 402) {
                let err = {};
                try { err = await res.json(); } catch(e) {}
                showUpgradeModal(err.detail || `Recurso premium. Vire Premium por US$ 15/mês.`);
            } else {
                alert("Não encontrado");
            }
        }
    } catch(e) { 
        alert("Erro");
    }
    finally { 
        btn.innerText = "Salvar"; 
        btn.disabled = false; 
    }
}

async function askAI(asset) {
    if (!authToken) return;

    if (!isPremium()) {
        showUpgradeModal("Recurso premium: sistema de IA disponível apenas no Premium. Vire Premium por US$ 15/mês.");
        return;
    }
    
    const div = document.getElementById(`ai-${asset.id}`);
    div.style.display='block'; 
    div.innerText='...';
    try {
        const res = await fetch(`${API_BASE}/analysis/${asset.symbol}?change=${asset.percent_change}`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            div.innerHTML = `<b style="color:#bca0dc">IA:</b> ${data.analysis}`;
        } else {
            if (res.status === 402) {
                let err = {};
                try { err = await res.json(); } catch(e) {}
                div.style.display='none';
                showUpgradeModal(err.detail || "Recurso premium: IA apenas no Premium. Vire Premium por US$ 15/mês.");
            } else {
                div.style.display='none';
            }
        }
    } catch(e) { 
        div.style.display='none'; 
    }
}

async function handlePortfolioAI() {
    if (!authToken) {
        showLoginScreen();
        return;
    }

    if (!isPremium()) {
        showUpgradeModal("Recurso premium: análise consolidada da carteira disponível apenas no Premium. Vire Premium por US$ 15/mês.");
        return;
    }

    const box = document.getElementById('ai-portfolio-text');
    const badge = document.getElementById('ai-portfolio-change');
    if (!box || !badge) return;

    box.innerText = 'Gerando análise da sua carteira nas últimas 24 horas...';

    try {
        const res = await fetch(`${API_BASE}/analysis/portfolio`, {
            headers: getAuthHeaders()
        });
        if (res.ok) {
            const data = await res.json();
            box.innerText = data.analysis || 'Não foi possível gerar uma análise no momento.';

            if (typeof data.change_pct === 'number') {
                const v = data.change_pct;
                badge.classList.remove('positive', 'negative');
                const formatted = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
                badge.innerText = formatted;
                if (v > 0) badge.classList.add('positive');
                else if (v < 0) badge.classList.add('negative');
            }
        } else if (res.status === 402) {
            let err = {};
            try { err = await res.json(); } catch(e) {}
            showUpgradeModal(err.detail || "Recurso premium: análise consolidada da carteira apenas no Premium. Vire Premium por US$ 15/mês.");
        } else {
            let msg = 'Erro ao buscar análise da carteira.';
            try {
                const err = await res.json();
                if (err.detail) msg = typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail);
            } catch (_) {}
            box.innerText = msg;
        }
    } catch (e) {
        box.innerText = 'Erro de conexão ao consultar a IA. Verifique se o servidor está rodando.';
    }
}

function renderSpark(id, data, color) {
    const ctx = document.getElementById(id)?.getContext('2d');
    if(!ctx) return;
    new Chart(ctx, {
        type: 'line',
        data: { labels: data.map((_, i) => i), datasets: [{ data: data, borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.4, fill: false }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: false, tooltip: false }, scales: { x: { display: false }, y: { display: false } }, layout: { padding: 0 } }
    });
}

function switchTab(t) {
    document.querySelectorAll('.container').forEach(e => e.classList.remove('active'));
    const el = document.getElementById(t);
    if (el) el.classList.add('active');
    const navCarteira = document.getElementById('nav-carteira');
    const navAdicionar = document.getElementById('nav-adicionar');
    if (navCarteira) navCarteira.classList.toggle('active', t === 'dashboard');
    if (navAdicionar) navAdicionar.classList.toggle('active', t === 'add-asset');
    if (t === 'dashboard') loadMainChart();
}

chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'Alerta de Preco - Purp',
    message: `${symbol} atingiu US$ ${price.toFixed(2)}`
});

async function exportCSV() {
    const res = await fetch(`${API_BASE}/portfolio/balance`, {
        headers: getAuthHeaders()
    });
    const data = await res.json();

    let csv = 'Simbolo,Quantidade,Preco Compra,Preco Atual,Valor,Lucro/Prejuizo\n';
    data.assets.forEach(a => {
        csv += `${a.symbol},${a.amount},${a.purchase_price},${a.current_price},${a.position_value},${a.profit}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'purp-carteira.csv';
    a.click();
}

// Função para converter USD para BRL
async function getExchangeRate(currency = 'BRL') {
    const res = await fetch(`https://api.exchangerate-api.com/v4/latest/USD`);
    const data = await res.json();
    return data.rates[currency];
}

// Uso: multiplique qualquer valor USD pela taxa:
const brlValue = usdValue * await getExchangeRate('BRL');
