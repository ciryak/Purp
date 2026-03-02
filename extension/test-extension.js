/**
 * Purp Extension — Comprehensive Readiness Test
 * Run via: node test-extension.js (from extension/ folder)
 * Tests: manifest, HTML structure, JS integrity, CSS variables, event bindings, function definitions
 * Exit code 0 = all pass, 1 = failures found
 */

const fs = require('fs');
const path = require('path');

const EXT = __dirname;
let passed = 0;
let failed = 0;
const failures = [];

function ok(name) { passed++; }
function fail(name, detail) { failed++; failures.push({ name, detail }); }
function test(name, condition, detail) {
  if (condition) ok(name); else fail(name, detail || 'assertion failed');
}

// ═══ 1. MANIFEST VALIDATION ═══
(function testManifest() {
  const raw = fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8');
  const m = JSON.parse(raw);

  test('manifest.version is semver', /^\d+\.\d+\.\d+$/.test(m.version), `got "${m.version}"`);
  test('manifest.manifest_version is 3', m.manifest_version === 3);
  test('manifest.description exists', typeof m.description === 'string' && m.description.length > 0);
  test('manifest.description <= 132 chars', m.description.length <= 132, `got ${m.description.length} chars`);
  test('manifest.homepage_url is getpurpai.com', m.homepage_url === 'https://getpurpai.com');
  test('manifest.name exists', typeof m.name === 'string' && m.name.length > 0);

  const hp = m.host_permissions || [];
  test('host_permissions includes Railway', hp.some(h => h.includes('purp-production.up.railway.app')));
  test('host_permissions includes Sentry', hp.some(h => h.includes('sentry.io')));
  test('host_permissions includes getpurpai.com', hp.some(h => h.includes('getpurpai.com')));

  const csp = m.content_security_policy?.extension_pages || '';
  test('CSP has script-src self', csp.includes("script-src 'self'"));
  test('CSP has style-src fonts.googleapis', csp.includes('style-src') && csp.includes('fonts.googleapis.com'));
  test('CSP has font-src fonts.gstatic', csp.includes('font-src') && csp.includes('fonts.gstatic.com'));
  test('CSP has connect-src fonts.googleapis', csp.includes('connect-src') && csp.includes('fonts.googleapis.com'));
  test('CSP has img-src self https data', csp.includes('img-src') && csp.includes('https:') && csp.includes('data:'));

  const perms = m.permissions || [];
  test('permissions includes storage', perms.includes('storage'));
  test('permissions includes alarms', perms.includes('alarms'));
  test('permissions includes notifications', perms.includes('notifications'));

  const action = m.action || {};
  test('action.default_popup is popup.html', action.default_popup === 'popup.html');

  const icons = m.icons || {};
  test('icons.16 defined', !!icons['16']);
  test('icons.48 defined', !!icons['48']);
  test('icons.128 defined', !!icons['128']);
})();

// ═══ 2. FILE EXISTENCE ═══
(function testFiles() {
  const required = [
    'popup.html', 'popup.js', 'style.css', 'verify-screen.js',
    'chart.js', 'bundle.min.js', 'manifest.json',
    'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
  ];
  required.forEach(f => {
    test(`file exists: ${f}`, fs.existsSync(path.join(EXT, f)));
  });

  test('Verify-screen.JS (uppercase) not referenced in HTML',
    !fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8').includes('Verify-screen.JS'));
})();

// ═══ 3. HTML STRUCTURE ═══
(function testHTML() {
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');

  // Required element IDs
  const requiredIds = [
    'toast-container', 'login-screen', 'login-form', 'register-form',
    'login-email', 'login-password', 'btn-login', 'btn-show-register', 'btn-show-login',
    'login-error', 'register-error',
    'reg-full-name', 'reg-email', 'reg-password', 'btn-register',
    'btn-hamburger', 'nav-menu', 'privacy-icon', 'btn-privacy-toggle',
    'nav-portfolio', 'nav-market', 'nav-add', 'nav-alerts', 'nav-import', 'nav-transactions', 'nav-logout',
    'top-tab-dashboard', 'top-tab-market',
    'dashboard', 'profile-avatar', 'profile-full-name', 'profile-plan', 'profile-count',
    'btn-upgrade', 'btn-quick-add', 'btn-quick-transactions',
    'total-balance', 'balance-performance', 'benchmark-select', 'benchmark-change',
    'mainChart', 'main-chart-placeholder',
    'ai-change-badge', 'ai-portfolio-text', 'btn-portfolio-ai',
    'portfolio-score-card', 'score-grade', 'score-gauge-value', 'score-overall',
    'score-diversification', 'score-risk', 'score-tax', 'score-consistency',
    'bar-diversification', 'bar-risk', 'bar-tax', 'bar-consistency',
    'score-insights', 'btn-share-performance',
    'tax-tools-section', 'cost-basis-method', 'tlh-total-badge', 'tlh-bracket-select', 'btn-refresh-tlh', 'tlh-list',
    'tax-pro-cta', 'btn-upgrade-tax-pro',
    'net-worth-card', 'btn-net-worth-add', 'net-worth-total',
    'nw-investments', 'nw-cash', 'nw-real-estate', 'nw-other', 'nw-debts',
    'rebalance-card', 'rebalance-targets', 'btn-rebalance-calc', 'rebalance-sum-warning', 'rebalance-tax-badge', 'rebalance-actions',
    'btn-export-csv', 'assets-list',
    'market-watch', 'market-watch-sub', 'market-stocks-list', 'market-cryptos-list',
    'transactions-page', 'transactions-list',
    'add-asset', 'symbol-input', 'search-dropdown', 'amount-input', 'price-input', 'date-input', 'btn-save-asset',
    'alerts-page', 'alerts-card', 'alert-type-input', 'alert-symbol-input', 'alert-target-input',
    'alert-target-label', 'alert-rsi-period-group', 'alert-rsi-period-input',
    'alert-target-allocation-group', 'alert-target-allocation-input',
    'alert-recurring-input', 'btn-create-alert', 'alerts-list',
    'import-page', 'import-csv-card', 'btn-open-import',
    'detail-view', 'btn-back', 'holding-badge', 'detail-symbol', 'detail-price', 'detailChart',
    'detail-icon-img', 'detail-icon-fb',
    'modal-sell', 'sell-qty', 'btn-max', 'sell-estimate', 'sell-info', 'btn-sell-cancel', 'btn-sell-confirm',
    'modal-upgrade', 'upgrade-reason', 'btn-upgrade-cancel', 'btn-upgrade-confirm',
    'modal-upgrade-tax-pro', 'btn-taxpro-cancel', 'btn-taxpro-confirm',
    'modal-broker-api', 'broker-api-title', 'broker-api-name', 'broker-api-key', 'broker-api-secret',
    'broker-api-result', 'btn-broker-api-cancel', 'btn-broker-api-fetch',
    'modal-import-csv', 'import-broker-select', 'import-file-input', 'file-drop-area', 'file-drop-label',
    'import-help-text', 'import-progress', 'import-progress-fill', 'import-status-text',
    'import-result', 'btn-import-cancel', 'btn-import-confirm',
    'modal-net-worth', 'nw-category', 'nw-label', 'nw-value', 'btn-nw-cancel', 'btn-nw-save',
  ];

  requiredIds.forEach(id => {
    test(`HTML id="${id}" exists`, html.includes(`id="${id}"`), `missing id="${id}"`);
  });

  // Scripts loaded in correct order
  test('bundle.min.js loaded before popup.js',
    html.indexOf('bundle.min.js') < html.indexOf('popup.js'));
  test('popup.js loaded before verify-screen.js',
    html.indexOf('popup.js') < html.indexOf('verify-screen.js'));
  test('chart.js loaded in head',
    html.indexOf('chart.js') < html.indexOf('</head>'));
  test('verify-screen.js reference (lowercase)',
    html.includes('src="verify-screen.js"'));

  // Links
  test('Privacy link to getpurpai.com', html.includes('href="https://getpurpai.com/privacy-policy"'));
  test('Terms link to getpurpai.com', html.includes('href="https://getpurpai.com/terms-of-service"'));
  test('No Railway links for privacy/terms',
    !html.includes('purp-production.up.railway.app/static/privacy') &&
    !html.includes('purp-production.up.railway.app/static/terms'));

  // Google Fonts preconnect
  test('Google Fonts preconnect', html.includes('rel="preconnect" href="https://fonts.googleapis.com"'));
  test('Google Fonts stylesheet', html.includes('fonts.googleapis.com/css2'));

  // Modals have modal-overlay class
  ['modal-sell', 'modal-upgrade', 'modal-upgrade-tax-pro', 'modal-broker-api', 'modal-import-csv', 'modal-net-worth'].forEach(id => {
    const regex = new RegExp(`id="${id}"[^>]*class="[^"]*modal-overlay`);
    test(`${id} has modal-overlay class`, regex.test(html), `${id} missing modal-overlay class`);
  });
})();

// ═══ 4. POPUP.JS FUNCTION DEFINITIONS ═══
(function testPopupJS() {
  const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

  const requiredFunctions = [
    'formatUSD', 'formatUSDCompact', 'formatPct', 'formatDateUS', 'isUSMarketOpen',
    'apiErrorDetail', 'toggleAuthMode', 'injectStyles', 'injectPortfolioScoreStyles',
    'applyVisibilityMask', 'getEyeIconSvg', 'updatePrivacyToggle',
    'toast', 'showError', 'clearError', 'authHeaders',
    'saveSession', 'loadSession', 'clearSession', 'handleLogout',
    'isPremium', 'isTaxPro', 'apiFetch', 'cachedFetch', 'assetIconUrl',
    'startRefresh', 'stopRefresh', 'showLoginScreen', 'hideLoginScreen',
    'focusModalFirstFocusable',
    'handleLogin', 'handleRegister', 'finalizeLoginUI', 'initDashboard',
    'updateProfileBar', 'showUpgradeModal', 'hideUpgradeModal', 'handleUpgrade',
    'closeMenu', 'switchTab',
    'loadMainChart', 'loadDetailChart', 'renderSpark',
    'performSearch', 'setAddAmountInputMode', 'resolveSymbolType',
    'fetchQuoteForSymbol', 'fetchSparkData', 'renderMarketRows', 'loadMarketWatch',
    'loadBalancePerformance', 'loadTransactions', 'checkAIStatus',
    'csvCell', 'exportPortfolioCsv',
    'loadPortfolioScore',
    'openNetWorthModal', 'closeNetWorthModal', 'loadNetWorth', 'saveNetWorthEntry',
    'renderRebalanceTargets', 'updateRebalanceTargetSum', 'calculateRebalance',
    'sharePerformanceCard', 'fetchPortfolio',
    'openDetail', 'openSellModal', 'closeSellModal', 'updateSellEstimate', 'confirmSell',
    'requestAssetAI', 'handlePortfolioAI', 'handleAddAsset',
    'updateAlertFormFields', 'renderAlertsList', 'loadAlerts', 'handleCreateAlert',
    'openImportModal', 'closeImportModal', 'updateImportConfirmBtn',
    'handleBrokerSelect', 'handleFileSelect', 'handleImportConfirm', 'showImportResult',
    'buildTaxTabBar', 'switchTaxTab', 'loadForm8949Preview', 'handleDownload8949',
    'loadTaxSummary', 'updateTaxToolsVisibility', 'loadTaxLossHarvesting',
    'showTaxProUpgradeModal', 'hideTaxProUpgradeModal', 'handleTaxProUpgrade',
    'ensureDividendCard', 'loadDividendCard',
    'buildCalendarStrip', 'buildUpcomingPayments', 'buildYieldTable', 'buildYieldRows',
  ];

  requiredFunctions.forEach(fn => {
    const hasFunc = new RegExp(`(function\\s+${fn}\\s*\\(|const\\s+${fn}\\s*=)`).test(js);
    test(`JS function defined: ${fn}`, hasFunc, `"${fn}" not found`);
  });

  // Config constants
  test('API_BASE defined', js.includes('const API_BASE'));
  test('API_BASE points to Railway', js.includes('purp-production.up.railway.app'));
  test('FREE_ASSET_LIMIT defined', js.includes('FREE_ASSET_LIMIT'));
  test('REFRESH_MS defined', js.includes('REFRESH_MS'));
  test('FEATURED_STOCKS defined', js.includes('FEATURED_STOCKS'));
  test('FEATURED_CRYPTOS defined', js.includes('FEATURED_CRYPTOS'));
  test('CACHE_TTL defined', js.includes('CACHE_TTL'));
  test('_cache defined', js.includes('const _cache'));
  test('_mainChartDirty defined', js.includes('_mainChartDirty'));

  // Sentry guard
  test('Sentry DSN is guarded', js.includes('const SENTRY_DSN') && js.includes('if (SENTRY_DSN)'));
  test('Sentry not hardcoded as literal "SENTRY_DSN"', !js.includes('dsn: "SENTRY_DSN"'));
  test('tracesSampleRate is 0.2', js.includes('tracesSampleRate: 0.2'));

  // renderSpark destroys existing chart
  test('renderSpark uses Chart.getChart', js.includes('Chart.getChart(canvas)'));
  test('renderSpark calls destroy()', js.includes('if (existing) existing.destroy()'));
  test('renderSpark uses getElementById', js.includes('document.getElementById(canvasId)'));

  // No console.log in production
  const consoleLogCount = (js.match(/console\.log\(/g) || []).length;
  test('No console.log() calls', consoleLogCount === 0, `found ${consoleLogCount} console.log() calls`);

  // Event listeners for all key buttons
  const listenerTargets = [
    'btn-login', 'btn-register', 'btn-show-register', 'btn-show-login',
    'btn-hamburger', 'nav-portfolio', 'nav-market', 'nav-add', 'nav-alerts',
    'nav-import', 'nav-transactions', 'nav-logout',
    'top-tab-dashboard', 'top-tab-market', 'btn-quick-add', 'btn-quick-transactions',
    'btn-privacy-toggle', 'btn-upgrade', 'btn-upgrade-cancel', 'btn-upgrade-confirm',
    'btn-export-csv', 'btn-portfolio-ai', 'btn-share-performance',
    'btn-net-worth-add', 'btn-nw-cancel', 'btn-nw-save', 'btn-rebalance-calc',
    'btn-back', 'benchmark-select',
    'btn-save-asset', 'btn-create-alert', 'alert-type-input', 'symbol-input',
    'sell-qty', 'btn-max', 'btn-sell-cancel', 'btn-sell-confirm',
    'btn-open-import', 'btn-import-cancel', 'btn-import-confirm',
    'import-broker-select', 'file-drop-area', 'import-file-input',
    'btn-broker-api-cancel', 'btn-broker-api-fetch',
    'btn-upgrade-tax-pro', 'btn-taxpro-cancel', 'btn-taxpro-confirm',
    'btn-refresh-tlh', 'tlh-bracket-select',
    'modal-net-worth', 'modal-import-csv',
  ];
  listenerTargets.forEach(id => {
    const pattern = new RegExp(`['"]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
    test(`listener target "${id}" referenced`, pattern.test(js), `"${id}" not found in JS`);
  });

  // DOMContentLoaded
  test('DOMContentLoaded listener', js.includes("document.addEventListener('DOMContentLoaded'"));

  // Escape key handler
  test('Escape key handler', js.includes("e.key !== 'Escape'") || js.includes("e.key === 'Escape'"));

  // Login/password Enter key
  test('login-password Enter key', js.includes("login-password") && js.includes("'Enter'"));
  test('reg-password Enter key', js.includes("reg-password") && js.includes("'Enter'"));

  // initDashboard phased loading
  test('initDashboard has phased loading (300ms)', js.includes('setTimeout') && /300\)/.test(js));
  test('initDashboard has phased loading (800ms)', /800\)/.test(js));

  // handleLogout destroys charts
  test('handleLogout destroys mainChart', /handleLogout[\s\S]{0,500}mainChart\.destroy/.test(js));
  test('handleLogout destroys detailChart', /handleLogout[\s\S]{0,500}detailChart\.destroy/.test(js));
})();

// ═══ 5. VERIFY-SCREEN.JS ═══
(function testVerifyScreen() {
  const js = fs.readFileSync(path.join(EXT, 'verify-screen.js'), 'utf8');

  test('buildVerifyScreen defined', js.includes('function buildVerifyScreen'));
  test('showVerifyScreen defined', js.includes('function showVerifyScreen'));
  test('Uses API_BASE for fetch', js.includes('API_BASE'));
  test('Calls /auth/verify-email', js.includes('/auth/verify-email'));
  test('Calls /auth/resend-verification', js.includes('/auth/resend-verification'));
  test('6-digit code inputs (vd0-vd5)', js.includes('vd0') && js.includes('vd${i}'));
  test('Paste handler for code', js.includes('paste'));
  test('Back button calls clearSession', js.includes('clearSession'));
  test('Back button calls showLoginScreen', js.includes('showLoginScreen'));
  test('Shake animation on error', js.includes('vfyShake'));
  test('Resend countdown timer', js.includes('Resend in'));
})();

// ═══ 6. CSS VALIDATION ═══
(function testCSS() {
  const css = fs.readFileSync(path.join(EXT, 'style.css'), 'utf8');

  const requiredVars = [
    '--bg', '--bg2', '--bg3', '--card', '--border', '--accent', '--accent-l',
    '--green', '--red', '--green-l', '--red-l', '--positive', '--negative',
    '--text', '--text2', '--text3', '--font', '--mono',
  ];
  requiredVars.forEach(v => {
    test(`CSS var ${v} defined`, css.includes(`${v}:`), `${v} not found in :root`);
  });

  // Key class selectors (in style.css file)
  const requiredClasses = [
    '.screen', '.login-box', '.btn-primary', '.btn-ghost', '.btn-link',
    '.nav-menu', '.nav-item', '.nav-footer-link',
    '.balance-card', '.balance-value',
    '.modal-overlay', '.modal-box', '.modal-title', '.modal-actions',
    '.field-group', '.field-label', '.select-ctrl',
    '.page', '.page-header', '.page-title', '.page-sub',
    '.sensitive-value', '.search-dropdown',
    '.profile-bar', '.profile-avatar', '.plan-badge',
    '.section-heading',
  ];
  requiredClasses.forEach(cls => {
    test(`CSS class "${cls}" exists`, css.includes(cls), `${cls} not found in CSS`);
  });

  // Classes injected via JS (injectPortfolioScoreStyles)
  const jsInjected = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  ['.score-card'].forEach(cls => {
    test(`JS-injected CSS class "${cls}"`, jsInjected.includes(cls), `${cls} not found in popup.js styles`);
  });

  // No external imports besides Google Fonts
  const imports = css.match(/@import\s+url\([^)]+\)/g) || [];
  imports.forEach(imp => {
    test(`CSS import is Google Fonts: ${imp.slice(0, 60)}`, imp.includes('fonts.googleapis.com'));
  });
})();

// ═══ 7. CROSS-FILE CONSISTENCY ═══
(function testCrossFile() {
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

  // Every modal referenced in JS exists in HTML
  const modalIds = ['modal-sell', 'modal-upgrade', 'modal-upgrade-tax-pro', 'modal-broker-api', 'modal-import-csv', 'modal-net-worth'];
  modalIds.forEach(id => {
    test(`Modal ${id} in HTML + JS`, html.includes(`id="${id}"`) && js.includes(`'${id}'`));
  });

  // Key elements that JS writes to exist in HTML
  const writeTargets = [
    'assets-list', 'market-stocks-list', 'market-cryptos-list', 'transactions-list',
    'alerts-list', 'tlh-list', 'rebalance-targets', 'rebalance-actions', 'score-insights',
  ];
  writeTargets.forEach(id => {
    test(`Write target ${id} in HTML`, html.includes(`id="${id}"`));
  });

  // Verify screen functions are accessible from popup.js scope
  test('popup.js references showVerifyScreen', js.includes('showVerifyScreen'));
  test('popup.js references clearSession', js.includes('clearSession'));
})();

// ═══ 8. SECURITY CHECKS ═══
(function testSecurity() {
  const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');

  test('No eval() in popup.js', !js.includes('eval('));
  test('No innerHTML with user input (XSS basic check)',
    !/(innerHTML\s*=\s*[^;]*(?:\.value|user|email|password))/.test(js));
  test('No hardcoded API keys', !/[A-Za-z0-9]{32,}/.test(js.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/`[^`]*`/g, '')));
  test('autocomplete=off on API key inputs', html.includes('id="broker-api-key"') && html.includes('autocomplete="off"'));
})();

// ═══ RESULTS ═══
console.log('\n' + '='.repeat(60));
console.log(`  PURP EXTENSION TEST RESULTS`);
console.log('='.repeat(60));
console.log(`  PASSED: ${passed}`);
console.log(`  FAILED: ${failed}`);
console.log(`  TOTAL:  ${passed + failed}`);
console.log(`  RATE:   ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
console.log('='.repeat(60));

if (failures.length > 0) {
  console.log('\n  FAILURES:\n');
  failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.name}`);
    if (f.detail !== 'assertion failed') console.log(`     -> ${f.detail}`);
  });
  console.log('');
}

process.exit(failed > 0 ? 1 : 0);
