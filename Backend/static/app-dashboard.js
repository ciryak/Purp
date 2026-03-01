(function () {
  "use strict";

  var STORAGE_KEY = "purp-portfolio-storage";
  var SEARCH_HISTORY_KEY = "purp-search-history";
  var THEME_KEY = "purp-theme";
  var AUTH_TOKEN_KEY = "auth_token";
  var AUTH_USER_KEY = "purp_user";
  var SYNC_SERVER_KEY = "purp_sync_server";

  var COIN_IDS = {
    BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
    XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", AVAX: "avalanche-2",
    DOT: "polkadot", LINK: "chainlink",
  };
  var CRYPTO_TICKERS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "BITCOIN", "ETHEREUM"]);
  var CRYPTO_COIN_IDS = { BITCOIN: "bitcoin", ETHEREUM: "ethereum" };
  function cryptoCoinId(ticker) {
    var t = (ticker || "").toUpperCase();
    return CRYPTO_COIN_IDS[t] || COIN_IDS[t] || t.toLowerCase();
  }

  function isCrypto(ticker) {
    return CRYPTO_TICKERS.has((ticker || "").toUpperCase());
  }

  function getStored() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function setStored(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
  }
  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  }
  function getAuthUser() {
    try {
      var raw = localStorage.getItem(AUTH_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function clearSession() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  }

  function getTheme() {
    var t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "dark";
  }
  function setTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }
  function applyTheme(theme) {
    var next = theme || getTheme();
    document.body.setAttribute("data-theme", next);
    var isDark = next === "dark";
    var icon = isDark ? "sun" : "moon";
    document.querySelectorAll("#btn-theme i, #settings-theme-btn i").forEach(function (i) {
      i.setAttribute("data-lucide", icon);
    });
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  }

  function getApiBase() {
    if (typeof window !== "undefined" && (window.location.origin.startsWith("http://localhost") || window.location.origin.startsWith("http://127.0.0.1"))) return "";
    return "https://purp-production.up.railway.app";
  }

  function fetchWithAuth(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var token = getAuthToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    opts.headers = headers;
    var base = getApiBase();
    return fetch(base + path, opts);
  }

  function getLocale() {
    return (state.user && state.user.locale) ? state.user.locale : "pt-BR";
  }
  function getCurrency() {
    return (state.user && state.user.currency) ? state.user.currency : "BRL";
  }
  function formatCurrency(value) {
    if (value == null || isNaN(value)) return "—";
    try {
      return new Intl.NumberFormat(getLocale(), { style: "currency", currency: getCurrency() }).format(value);
    } catch (e) {
      return getCurrency() === "USD" ? "$" + value.toFixed(2) : "R$ " + value.toFixed(2);
    }
  }
  function formatDate(dateStr) {
    if (!dateStr) return "";
    try {
      var d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
      return d.toLocaleDateString(getLocale());
    } catch (e) {
      return dateStr;
    }
  }

  if (!getAuthToken()) {
    window.location.href = "/";
    throw new Error("redirect");
  }

  var state = {
    transactions: getStored().transactions || [],
    tickers: getStored().tickers || [],
    valuesHidden: !!getStored().valuesHidden,
    notifications: getStored().notifications || [],
    news: [],
    prices: {},
    changes: {},
    movers: [],
    portfolioScore: null,
    marketAnalysisText: null,
    userGoals: null,
    user: null,
    portfolioSort: "value",
    moversSort: "change-desc",
    portfolioFromServer: false,
  };
  var _lastModalTrigger = null;

  function persist() {
    setStored({
      transactions: state.transactions,
      tickers: state.tickers,
      valuesHidden: state.valuesHidden,
      notifications: state.notifications,
    });
  }

  function buildPositions(prices) {
    var byTicker = {};
    state.transactions.forEach(function (t) {
      var key = (t.ticker || "").toUpperCase();
      var prev = byTicker[key] || { totalQty: 0, costBase: 0 };
      if (t.type === "buy") {
        byTicker[key] = {
          totalQty: prev.totalQty + t.quantity,
          costBase: prev.costBase + t.quantity * t.price,
        };
      } else {
        var ratio = prev.totalQty > 0 ? t.quantity / prev.totalQty : 0;
        byTicker[key] = {
          totalQty: prev.totalQty - t.quantity,
          costBase: prev.costBase * (1 - ratio),
        };
      }
    });
    var positions = [];
    var total = 0;
    Object.keys(byTicker).forEach(function (ticker) {
      var p = byTicker[ticker];
      if (p.totalQty <= 0) return;
      var currentPrice = prices[ticker] || 0;
      var currentValue = p.totalQty * currentPrice;
      var averagePrice = p.costBase / p.totalQty;
      var pnlAbsolute = currentValue - p.costBase;
      var pnlPercent = p.costBase > 0 ? (pnlAbsolute / p.costBase) * 100 : 0;
      positions.push({
        ticker: ticker,
        quantity: p.totalQty,
        averagePrice: averagePrice,
        currentPrice: currentPrice,
        currentValue: currentValue,
        pnlAbsolute: pnlAbsolute,
        pnlPercent: pnlPercent,
      });
      total += currentValue;
    });
    positions.forEach(function (p) {
      p.allocationPercent = total > 0 ? (p.currentValue / total) * 100 : 0;
    });
    return { positions: positions, totalValue: total };
  }

  function fetchPrices(tickers, callback) {
    var cryptos = tickers.filter(function (t) { return isCrypto(t); });
    var stocks = tickers.filter(function (t) { return !isCrypto(t); });
    var prices = {};
    var changes = {};
    var completed = 0;
    var total = (cryptos.length ? 1 : 0) + stocks.length;

    function checkDone() {
      completed++;
      if (completed >= total) {
        state.prices = prices;
        state.changes = changes;
        if (callback) callback();
      }
    }

    if (cryptos.length > 0) {
      var ids = cryptos.map(function (t) { return cryptoCoinId(t); }).join(",");
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd&include_24hr_change=true")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          cryptos.forEach(function (t) {
            var id = cryptoCoinId(t);
            var o = data[id];
            if (o && o.usd != null) prices[t] = o.usd;
            if (o && o.usd_24h_change != null) changes[t] = o.usd_24h_change;
          });
          checkDone();
        })
        .catch(checkDone);
    }
    stocks.forEach(function (sym) {
      var base = getApiBase();
      fetch(base + "/api/proxy/yahoo-chart?symbol=" + encodeURIComponent(sym))
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (json) {
          var meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
          if (meta) {
            var price = meta.regularMarketPrice;
            var prev = meta.chartPreviousClose || meta.previousClose;
            prices[sym] = price;
            changes[sym] = prev ? ((price - prev) / prev) * 100 : 0;
          }
          checkDone();
        })
        .catch(checkDone);
    });
    if (total === 0 && callback) callback();
  }

  function allTickers() {
    var set = {};
    (state.positions || []).forEach(function (p) { set[p.ticker] = true; });
    state.tickers.forEach(function (t) { set[t.toUpperCase()] = true; });
    return Object.keys(set);
  }

  function render() {
    if (!state.portfolioFromServer) {
      var built = buildPositions(state.prices);
      state.positions = built.positions;
      state.totalValue = built.totalValue;
    }

    var positions = state.positions;
    var totalValue = state.totalValue;
    var displayTotal = state.valuesHidden ? "••••" : formatCurrency(totalValue);
    var dayChangePct = 0;
    if (positions.length > 0) {
      var dayChange = positions.reduce(function (s, p) {
        var ch = (state.changes[p.ticker] || 0) / 100;
        return s + p.currentValue * ch;
      }, 0);
      dayChangePct = totalValue > 0 ? (dayChange / totalValue) * 100 : 0;
    }

    var sortBy = state.portfolioSort || "value";
    if (positions.length > 1) {
      positions = positions.slice().sort(function (a, b) {
        if (sortBy === "value") return (b.currentValue || 0) - (a.currentValue || 0);
        if (sortBy === "pnl") return (b.pnlPercent != null ? b.pnlPercent : 0) - (a.pnlPercent != null ? a.pnlPercent : 0);
        if (sortBy === "ticker") return (a.ticker || "").localeCompare(b.ticker || "");
        return 0;
      });
    }

    var portfolioEmpty = document.getElementById("portfolio-empty");
    var portfolioContent = document.getElementById("portfolio-content");
    var portfolioTotalValue = document.getElementById("portfolio-total-value");
    var portfolioPositions = document.getElementById("portfolio-positions");
    var portfolioSortSelect = document.getElementById("portfolio-sort");
    if (portfolioSortSelect && state.portfolioSort) portfolioSortSelect.value = state.portfolioSort;

    if (positions.length === 0) {
      if (portfolioEmpty) portfolioEmpty.style.display = "block";
      if (portfolioContent) portfolioContent.style.display = "none";
    } else {
      if (portfolioEmpty) portfolioEmpty.style.display = "none";
      if (portfolioContent) portfolioContent.style.display = "block";
      if (portfolioTotalValue) {
        portfolioTotalValue.textContent = displayTotal;
        if (dayChangePct !== 0) {
          var span = document.createElement("span");
          span.style.color = dayChangePct >= 0 ? "var(--green-l)" : "var(--red-l)";
          span.textContent = " " + (dayChangePct >= 0 ? "+" : "") + dayChangePct.toFixed(2) + "%";
          portfolioTotalValue.appendChild(span);
        }
      }
      if (portfolioPositions) {
        portfolioPositions.innerHTML = positions.map(function (p) {
          var val = state.valuesHidden ? "••••" : formatCurrency(p.currentValue);
          var pnlClass = p.pnlPercent >= 0 ? "positive" : "negative";
          var pnlStr;
          if (p.currentPrice == null || p.currentPrice === 0) {
            pnlStr = "—";
            pnlClass = "";
          } else {
            pnlStr = (p.pnlPercent >= 0 ? "+" : "") + p.pnlPercent.toFixed(2) + "%";
          }
          return "<li data-ticker=\"" + p.ticker + "\"><span class=\"pos-ticker\">" + p.ticker + "</span><span class=\"pos-value\">" + val + "</span> <span class=\"pos-pnl " + pnlClass + "\">" + pnlStr + "</span></li>";
        }).join("");
      }
    }

    var watchlistEmpty = document.getElementById("watchlist-empty");
    var watchlistList = document.getElementById("watchlist-list");
    if (watchlistList) {
      if (state.tickers.length === 0) {
        watchlistEmpty.style.display = "block";
        watchlistList.innerHTML = "";
      } else {
        watchlistEmpty.style.display = "none";
        watchlistList.innerHTML = state.tickers.map(function (t) {
          var price = state.prices[t] || 0;
          var ch = state.changes[t] || 0;
          var chClass = ch >= 0 ? "up" : "dn";
          var chStr = (ch >= 0 ? "+" : "") + ch.toFixed(2) + "%";
          return "<li data-ticker=\"" + t + "\"><span class=\"wl-ticker\">" + t + "</span><span class=\"wl-price\">" + formatCurrency(price) + "</span> <span class=\"wl-chg " + chClass + "\">" + chStr + "</span></li>";
        }).join("");
      }
    }

    var scoreValue = document.getElementById("score-value");
    var scoreClassEl = document.getElementById("score-class");
    var score = 50;
    var grade = "—";
    if (state.portfolioScore && state.portfolioScore.overall != null) {
      score = Math.round(state.portfolioScore.overall);
      grade = state.portfolioScore.grade || (score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Fair" : "Poor");
    } else if (positions.length > 0) {
      score = Math.min(100, 40 + Math.min(positions.length * 10, 30) + (state.totalValue > 10000 ? 10 : 0));
      grade = score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Fair" : "Poor";
    }
    if (scoreValue) scoreValue.textContent = score;
    if (scoreClassEl) scoreClassEl.textContent = grade;
    var gauge = document.getElementById("score-gauge");
    if (gauge) gauge.style.setProperty("--score", String(score));
    var scoreExplanation = document.getElementById("score-explanation");
    if (scoreExplanation) scoreExplanation.textContent = "Baseado em diversificação, risco e consistência.";
    var scoreInsightsEl = document.getElementById("score-insights");
    if (scoreInsightsEl) {
      if (state.portfolioScore && state.portfolioScore.insights && state.portfolioScore.insights.length > 0) {
        scoreInsightsEl.innerHTML = "<p class=\"score-insight-title\">Sugestões:</p><ul class=\"score-insight-list\">" + state.portfolioScore.insights.slice(0, 3).map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ul>";
        scoreInsightsEl.style.display = "block";
      } else {
        scoreInsightsEl.innerHTML = "";
        scoreInsightsEl.style.display = "none";
      }
    }

    var moversList = document.getElementById("movers-list");
    if (moversList) {
      var movers = state.movers && state.movers.length > 0 ? state.movers : [
        { symbol: "BTC", percent_change: state.changes["BTC"] || 2.5 },
        { symbol: "ETH", percent_change: state.changes["ETH"] || 1.8 },
        { symbol: "NVDA", percent_change: state.changes["NVDA"] || 3.2 },
        { symbol: "AAPL", percent_change: state.changes["AAPL"] || -0.5 },
        { symbol: "TSLA", percent_change: state.changes["TSLA"] || 4.1 },
      ];
      var moversSort = state.moversSort || "change-desc";
      movers = movers.slice().sort(function (a, b) {
        var pa = a.percent_change != null ? a.percent_change : (a.changePercent != null ? a.changePercent : 0);
        var pb = b.percent_change != null ? b.percent_change : (b.changePercent != null ? b.changePercent : 0);
        if (moversSort === "change-desc") return pb - pa;
        if (moversSort === "change-asc") return pa - pb;
        if (moversSort === "ticker") return (a.symbol || a.ticker || "").localeCompare(b.symbol || b.ticker || "");
        return 0;
      });
      moversList.innerHTML = movers.map(function (m) {
        var ticker = m.symbol || m.ticker;
        var pct = m.percent_change != null ? m.percent_change : (m.changePercent != null ? m.changePercent : 0);
        var c = pct >= 0 ? "up" : "dn";
        var str = (pct >= 0 ? "+" : "") + (typeof pct === "number" ? pct.toFixed(2) : pct) + "%";
        return "<li data-ticker=\"" + ticker + "\"><span class=\"mover-ticker\">" + ticker + "</span><span class=\"mover-chg " + c + "\">" + str + "</span></li>";
      }).join("");
      var moversSortSelect = document.getElementById("movers-sort");
      if (moversSortSelect && state.moversSort) moversSortSelect.value = state.moversSort;
    }

    var widgetGoalsEmpty = document.getElementById("widget-goals-empty");
    var widgetGoalsList = document.getElementById("widget-goals-list");
    if (widgetGoalsEmpty && widgetGoalsList) {
      var goals = (state.userGoals && state.userGoals.goals) || [];
      if (goals.length === 0) {
        widgetGoalsEmpty.style.display = "block";
        widgetGoalsList.style.display = "none";
        widgetGoalsList.innerHTML = "";
      } else {
        widgetGoalsEmpty.style.display = "none";
        widgetGoalsList.style.display = "block";
        widgetGoalsList.innerHTML = goals.slice(0, 3).map(function (g) {
          var pct = Math.min(100, (g.progress_pct || 0));
          return "<div class=\"widget-goal-item\"><div class=\"widget-goal-label\">" + (g.label || "") + "</div><div class=\"goal-progress\"><div class=\"goal-progress-bar\" style=\"width:" + pct + "%\"></div></div><span class=\"widget-goal-values\">" + formatCurrency(g.current_value || 0) + " / " + formatCurrency(g.target_value || 0) + " (" + (g.progress_pct || 0) + "%)</span></div>";
        }).join("");
      }
    }

    var analysisContainer = document.getElementById("widget-analysis");
    if (analysisContainer) {
      var analysisSlot = analysisContainer.querySelector(".widget-analysis-content") || analysisContainer.querySelector(".widget-empty-inline");
      if (!analysisSlot) {
        var h3 = analysisContainer.querySelector("h3");
        analysisSlot = h3 ? h3.nextElementSibling : null;
      }
      if (!analysisSlot) {
        analysisSlot = document.createElement("div");
        analysisContainer.appendChild(analysisSlot);
      }
      if (state.marketAnalysisText) {
        var analysisHtml = (state.marketAnalysisText || "").replace(/</g, "&lt;");
        analysisSlot.className = "widget-analysis-content";
        analysisSlot.innerHTML = analysisHtml;
      } else if (state.marketAnalysisText === false) {
        analysisSlot.className = "widget-empty-inline";
        analysisSlot.textContent = "Faça upgrade para ver análise com IA.";
      } else {
        analysisSlot.className = "widget-empty-inline";
        analysisSlot.textContent = "Ative o plano Investor para ver análises com IA.";
      }
    }

    var pieEl = document.getElementById("portfolio-pie");
    if (pieEl && positions.length > 0) {
      var totalPct = 0;
      var segments = positions.map(function (p, i) {
        var pct = p.allocationPercent || 0;
        totalPct += pct;
        return pct;
      });
      if (totalPct > 0) {
        var colors = ["#7c3aed", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6"];
        var conicParts = segments.map(function (pct, i) {
          return colors[i % colors.length] + " " + (i === 0 ? "0" : segments.slice(0, i).reduce(function (a, b) { return a + b; }, 0)) + "% " + (segments.slice(0, i + 1).reduce(function (a, b) { return a + b; }, 0)) + "%";
        }).join(", ");
        pieEl.style.background = "conic-gradient(" + conicParts + ")";
        pieEl.style.width = "100%";
        pieEl.style.height = "100%";
        pieEl.style.borderRadius = "50%";
      }
    } else if (pieEl) {
      pieEl.style.background = "";
    }
  }

  function refreshPrices() {
    var tickers = allTickers();
    if (tickers.length === 0) tickers = ["BTC", "ETH", "AAPL"];
    fetchPrices(tickers, function () {
      fetchMovers();
      fetchPortfolioScore();
      fetchUserGoals();
      fetchMarketAnalysis();
      render();
      fetchNews();
    });
  }

  function fetchMovers() {
    var base = getApiBase();
    fetch(base + "/movers")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = [];
        if (data && data.gainers) list = list.concat(data.gainers);
        if (data && data.losers) list = list.concat(data.losers);
        if (list.length === 0 && data && data.all) list = data.all.slice(0, 10);
        state.movers = list.map(function (m) {
          return { symbol: m.symbol || m.ticker, percent_change: m.percent_change, current_price: m.current_price, icon: m.icon };
        });
        render();
      })
      .catch(function () { state.movers = []; });
  }

  function fetchPortfolioScore() {
    fetchWithAuth("/portfolio/score")
      .then(function (r) {
        if (r.ok) return r.json();
        return null;
      })
      .then(function (data) {
        state.portfolioScore = data;
        render();
      })
      .catch(function () { state.portfolioScore = null; });
  }

  function fetchUserGoals() {
    fetchWithAuth("/user/goals")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        state.userGoals = data;
        render();
      })
      .catch(function () { state.userGoals = null; });
  }

  function fetchMarketAnalysis() {
    fetchWithAuth("/analysis/portfolio")
      .then(function (r) {
        if (r.status === 402) {
          state.marketAnalysisText = false;
          return;
        }
        if (r.ok) return r.json();
        state.marketAnalysisText = null;
        return null;
      })
      .then(function (data) {
        if (data && data.analysis) state.marketAnalysisText = data.analysis;
        render();
      })
      .catch(function () { state.marketAnalysisText = null; });
  }

  function openTransactionModalWithAsset(ticker, price, type) {
    _lastModalTrigger = document.activeElement;
    var txModal = document.getElementById("transaction-modal");
    var txTicker = document.getElementById("tx-ticker");
    var txPrice = document.getElementById("tx-price");
    var txDate = document.getElementById("tx-date");
    var txTypeBuy = document.querySelector(".tx-type-btn[data-type=\"buy\"]");
    var txTypeSell = document.querySelector(".tx-type-btn[data-type=\"sell\"]");
    var txTypeInput = document.getElementById("tx-type");
    if (txTicker) txTicker.value = (ticker || "").toUpperCase();
    if (txPrice) txPrice.value = price != null ? String(price) : (state.prices[ticker] != null ? state.prices[ticker] : "");
    if (txDate) txDate.value = new Date().toISOString().slice(0, 10);
    if (type === "sell" && txTypeSell) {
      txTypeSell.classList.add("active");
      if (txTypeBuy) txTypeBuy.classList.remove("active");
      if (txTypeInput) txTypeInput.value = "sell";
    } else {
      if (txTypeBuy) txTypeBuy.classList.add("active");
      if (txTypeSell) txTypeSell.classList.remove("active");
      if (txTypeInput) txTypeInput.value = "buy";
    }
    if (txModal) txModal.setAttribute("aria-hidden", "false");
    createIcons();
  }

  function openAssetPanel(ticker) {
    if (!ticker) return;
    _lastModalTrigger = document.activeElement;
    var titleEl = document.getElementById("asset-panel-title");
    var bodyEl = document.getElementById("asset-panel-body");
    var panel = document.getElementById("asset-panel");
    if (titleEl) titleEl.textContent = ticker;
    if (bodyEl) bodyEl.innerHTML = "<p class=\"text-muted\">Carregando…</p>";
    if (panel) panel.setAttribute("aria-hidden", "false");
    createIcons();

    var symbol = encodeURIComponent(ticker);
    Promise.all([
      fetchWithAuth("/snapshot/" + symbol).then(function (r) { return r.ok ? r.json() : null; }),
      fetchWithAuth("/analysis/" + symbol).then(function (r) {
        if (r.status === 402) return { upgrade: true };
        return r.ok ? r.json() : null;
      }),
    ]).then(function (results) {
      var snapshot = results[0];
      var analysis = results[1];
      var price = (snapshot && snapshot.price != null) ? snapshot.price : (state.prices[ticker] != null ? state.prices[ticker] : 0);
      var change = (snapshot && snapshot.change_percent != null) ? snapshot.change_percent : (state.changes[ticker] != null ? state.changes[ticker] : null);
      var name = (snapshot && snapshot.name) ? snapshot.name : ticker;
      var changeStr = change != null ? ((change >= 0 ? "+" : "") + change.toFixed(2) + "%") : "—";
      var changeClass = change != null ? (change >= 0 ? "positive" : "negative") : "";
      var html = "<p><strong>" + name + "</strong></p><p>Preço: $" + Number(price).toFixed(2) + "</p><p class=\"pos-pnl " + changeClass + "\">Variação 24h: " + changeStr + "</p>";
      if (analysis && analysis.upgrade) {
        html += "<p class=\"text-muted\">Faça upgrade para ver análise com IA.</p>";
      } else if (analysis && analysis.analysis) {
        html += "<div class=\"asset-panel-analysis\">" + analysis.analysis.replace(/</g, "&lt;") + "</div>";
      }
      html += "<div class=\"asset-panel-actions\"><button type=\"button\" class=\"btn btn-primary btn-register-buy\">Registrar compra</button> <button type=\"button\" class=\"btn btn-secondary btn-register-sell\">Registrar venda</button></div>";
      html += "<p><button type=\"button\" class=\"btn btn-secondary btn-create-alert\" data-ticker=\"" + (ticker || "").replace(/"/g, "&quot;") + "\">Criar alerta</button></p>";
      if (bodyEl) bodyEl.innerHTML = html;
      bodyEl.querySelectorAll(".btn-register-buy").forEach(function (btn) {
        btn.addEventListener("click", function () { openTransactionModalWithAsset(ticker, price, "buy"); });
      });
      bodyEl.querySelectorAll(".btn-register-sell").forEach(function (btn) {
        btn.addEventListener("click", function () { openTransactionModalWithAsset(ticker, price, "sell"); });
      });
      bodyEl.querySelectorAll(".btn-create-alert").forEach(function (btn) {
        btn.addEventListener("click", function () { openAlertsModal(btn.getAttribute("data-ticker") || ticker); });
      });
      createIcons();
    }).catch(function () {
      var price = state.prices[ticker] != null ? state.prices[ticker] : 0;
      var change = state.changes[ticker];
      var changeStr = change != null ? ((change >= 0 ? "+" : "") + change.toFixed(2) + "%") : "—";
      var changeClass = change != null ? (change >= 0 ? "positive" : "negative") : "";
      var html = "<p>Preço: $" + Number(price).toFixed(2) + "</p><p class=\"pos-pnl " + changeClass + "\">Variação: " + changeStr + "</p>";
      html += "<div class=\"asset-panel-actions\"><button type=\"button\" class=\"btn btn-primary btn-register-buy\">Registrar compra</button> <button type=\"button\" class=\"btn btn-secondary btn-register-sell\">Registrar venda</button></div>";
      html += "<p><button type=\"button\" class=\"btn btn-secondary btn-create-alert\" data-ticker=\"" + (ticker || "").replace(/"/g, "&quot;") + "\">Criar alerta</button></p>";
      if (bodyEl) bodyEl.innerHTML = html;
      bodyEl.querySelectorAll(".btn-register-buy").forEach(function (btn) {
        btn.addEventListener("click", function () { openTransactionModalWithAsset(ticker, price, "buy"); });
      });
      bodyEl.querySelectorAll(".btn-register-sell").forEach(function (btn) {
        btn.addEventListener("click", function () { openTransactionModalWithAsset(ticker, price, "sell"); });
      });
      bodyEl.querySelectorAll(".btn-create-alert").forEach(function (btn) {
        btn.addEventListener("click", function () { openAlertsModal(btn.getAttribute("data-ticker") || ticker); });
      });
      createIcons();
    });
  }

  function openAlertsModal(prefillTicker) {
    _lastModalTrigger = document.activeElement;
    var modal = document.getElementById("alerts-modal");
    if (!modal) return;
    modal.setAttribute("aria-hidden", "false");
    var symbolInp = document.getElementById("alert-symbol");
    if (symbolInp) symbolInp.value = (prefillTicker || "").toUpperCase();
    var wrapEl = document.getElementById("alerts-list-wrap");
    if (wrapEl) {
      wrapEl.innerHTML = "<p class=\"text-muted\">Carregando…</p><div id=\"alerts-list\"></div>";
    }
    fetchWithAuth("/alerts").then(function (r) { return r.ok ? r.json() : { alerts: [] }; }).then(function (data) {
      var alerts = data.alerts || [];
      if (!wrapEl) return;
      var listHtml = "";
      if (alerts.length === 0) {
        listHtml = "<p class=\"text-muted\">Nenhum alerta.</p>";
      } else {
        listHtml = "<div id=\"alerts-list\">" + alerts.map(function (a) {
          var typeLabel = a.alert_type === "price_above" ? "Acima de" : a.alert_type === "price_below" ? "Abaixo de" : a.alert_type;
          var status = a.active ? "Ativo" : "Pausado";
          return "<div class=\"alert-item\" data-id=\"" + a.id + "\"><span class=\"alert-info\">" + (a.symbol || "") + " — " + typeLabel + " " + (a.target_value != null ? a.target_value : "") + "</span> <span class=\"alert-status\">" + status + "</span> <button type=\"button\" class=\"btn-small alert-toggle\" data-id=\"" + a.id + "\">" + (a.active ? "Pausar" : "Ativar") + "</button> <button type=\"button\" class=\"btn-small alert-delete\" data-id=\"" + a.id + "\">Excluir</button></div>";
        }).join("") + "</div>";
      }
      wrapEl.innerHTML = listHtml;
      var listEl = wrapEl.querySelector("#alerts-list");
      if (listEl) {
        listEl.querySelectorAll(".alert-toggle").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = parseInt(btn.getAttribute("data-id"), 10);
            fetchWithAuth("/alerts/" + id + "/toggle", { method: "POST" }).then(function () { openAlertsModal(); });
          });
        });
        listEl.querySelectorAll(".alert-delete").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var id = parseInt(btn.getAttribute("data-id"), 10);
            fetchWithAuth("/alerts/" + id, { method: "DELETE" }).then(function (r) {
              if (r.ok) { var item = listEl.querySelector(".alert-item[data-id=\"" + id + "\"]"); if (item) item.remove(); }
            });
          });
        });
      }
    });
    var resultEl = document.getElementById("alerts-result");
    if (resultEl) resultEl.textContent = "";
    createIcons();
  }

  function fetchNews() {
    var tickers = allTickers();
    var base = getApiBase();
    var cutoff = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    fetch(base + "/api/proxy/news")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = (data && data.Data) ? data.Data : [];
        list = list.filter(function (n) {
          var pub = n.published_on;
          if (pub != null && pub < cutoff) return false;
          return true;
        });
        list.sort(function (a, b) {
          var pa = a.published_on || 0;
          var pb = b.published_on || 0;
          return pb - pa;
        });
        var upper = tickers.map(function (t) { return t.toUpperCase(); });
        var filtered = list.filter(function (n) {
          if (upper.length === 0) return true;
          var text = ((n.title || "") + " " + (n.body || "")).toUpperCase();
          return upper.some(function (t) { return text.indexOf(t) !== -1; });
        });
        if (filtered.length === 0) filtered = list.slice(0, 8);
        state.news = filtered.slice(0, 8).map(function (n) {
          return {
            id: n.id || n.url,
            headline: n.title || "",
            source: n.source || "",
            url: n.url || "#",
            datetime: n.published_on || Math.floor(Date.now() / 1000),
          };
        });
        renderNews();
      })
      .catch(function () { state.news = []; renderNews(); });
  }

  function renderNews() {
    var listEl = document.getElementById("news-list");
    var emptyEl = document.getElementById("news-empty");
    if (!listEl) return;
    if (state.news.length === 0) {
      if (emptyEl) emptyEl.style.display = "block";
      listEl.innerHTML = "";
    } else {
      if (emptyEl) emptyEl.style.display = "none";
      listEl.innerHTML = state.news.map(function (n) {
        var dateStr = "";
        if (n.datetime) {
          var d = new Date(n.datetime * 1000);
          var now = new Date();
          var diff = Math.floor((now - d) / 60000);
          if (diff < 60) dateStr = diff + " min atrás";
          else if (diff < 1440) dateStr = Math.floor(diff / 60) + " h atrás";
          else dateStr = d.toLocaleDateString("pt-BR");
        }
        return "<li><a href=\"" + (n.url || "#") + "\" target=\"_blank\" rel=\"noopener\" class=\"news-headline\">" + (n.headline || "").replace(/</g, "&lt;") + "</a><span class=\"news-meta\">" + (n.source || "") + (dateStr ? " · " + dateStr : "") + "</span></li>";
      }).join("");
    }
  }

  if (!state.portfolioFromServer) {
    state.positions = buildPositions(state.prices).positions;
    state.totalValue = buildPositions(state.prices).totalValue;
  }

  function createIcons() {
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  }

  function buildShareCard() {
    var card = document.getElementById("share-card");
    if (!card) return;
    var positions = state.positions || [];
    var tickers = state.tickers || [];
    var count = positions.length;
    var watchlistOnly = tickers.filter(function (t) { return !positions.some(function (p) { return p.ticker === t; }); });
    var totalAssets = count + watchlistOnly.length;
    if (totalAssets === 0) totalAssets = 1;
    var topPerformer = null;
    var topPct = -Infinity;
    positions.forEach(function (p) {
      var pct = p.pnlPercent != null ? p.pnlPercent : (state.changes[p.ticker] || 0);
      if (pct > topPct) { topPct = pct; topPerformer = { ticker: p.ticker, pct: pct }; }
    });
    if (!topPerformer && tickers.length > 0) {
      tickers.forEach(function (t) {
        var ch = state.changes[t] || 0;
        if (ch > topPct) { topPct = ch; topPerformer = { ticker: t, pct: ch }; }
      });
    }
    var year = new Date().getFullYear();
    var topHtml = topPerformer
      ? "<span class=\"share-top\">Top: <span class=\"ticker\">" + topPerformer.ticker + "</span> " + (topPerformer.pct >= 0 ? "+" : "") + topPerformer.pct.toFixed(1) + "%</span>"
      : "<span class=\"share-top\">Adicione ativos para ver seu top</span>";
    card.innerHTML =
      "<img src=\"icons/icon16.png\" alt=\"\" class=\"share-logo\" width=\"48\" height=\"48\" />" +
      "<div class=\"share-brand\">PURP</div>" +
      "<div class=\"share-title\">Meu Purp " + year + "</div>" +
      "<div class=\"share-stat\">" + totalAssets + "</div>" +
      "<div class=\"share-stat-label\">ativos na carteira</div>" +
      topHtml +
      "<div class=\"share-year\">purp.ai · " + year + "</div>";
  }

  function openShareModal() {
    _lastModalTrigger = document.activeElement;
    buildShareCard();
    document.getElementById("share-modal").setAttribute("aria-hidden", "false");
    createIcons();
  }

  function shareDownloadPng() {
    var card = document.getElementById("share-card");
    if (!card) return;
    if (typeof html2canvas === "undefined") {
      alert("Carregando... Tente novamente em um instante.");
      return;
    }
    html2canvas(card, { scale: 2, useCORS: true, allowTaint: true, backgroundColor: null })
      .then(function (canvas) {
        canvas.toBlob(function (blob) {
          if (!blob) return;
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "purp-carteira-" + new Date().getFullYear() + ".png";
          a.click();
          URL.revokeObjectURL(url);
        }, "image/png");
      })
      .catch(function () { alert("Erro ao gerar imagem."); });
  }

  function focusBeforeHide(modalEl, savedFocus) {
    try {
      if (savedFocus && typeof savedFocus.focus === "function" && document.contains(savedFocus)) savedFocus.focus();
      else {
        document.body.setAttribute("tabindex", "-1");
        document.body.focus();
      }
    } catch (e) {}
    if (modalEl) modalEl.setAttribute("aria-hidden", "true");
  }

  function showUnverifiedBanner() {
    if (document.getElementById("unverified-banner")) return;
    var banner = document.createElement("div");
    banner.id = "unverified-banner";
    banner.style.cssText = "background:#6d28d9;color:#fff;text-align:center;padding:10px 16px;font-size:14px;position:relative;z-index:39;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;";
    banner.innerHTML = "<span>Seu e-mail ainda não foi verificado.</span><button id=\"resend-verify-btn\" type=\"button\" style=\"background:#fff;color:#6d28d9;border:none;border-radius:6px;padding:5px 14px;font-size:13px;font-weight:600;cursor:pointer;\">Reenviar código</button><button type=\"button\" style=\"position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;\" aria-label=\"Fechar\">&times;</button>";
    var header = document.querySelector(".dashboard-header");
    if (header && header.nextSibling) header.parentNode.insertBefore(banner, header.nextSibling);
    else document.body.prepend(banner);
    banner.querySelector("#resend-verify-btn").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = "Enviando…";
      fetchWithAuth("/auth/resend-verification", { method: "POST" })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function () { btn.textContent = "E-mail enviado!"; })
        .catch(function () { btn.textContent = "Erro. Tente novamente."; btn.disabled = false; });
    });
    banner.querySelector("[aria-label=\"Fechar\"]").addEventListener("click", function () {
      banner.remove();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(getTheme());

    function updateUserMenu(me) {
      state.user = me;
      if (me) {
        try { localStorage.setItem(AUTH_USER_KEY, JSON.stringify(me)); } catch (e) {}
      }
      var name = (me && (me.full_name || me.username)) ? (me.full_name || me.username) : (me && me.email) || "User";
      var letter = (name || "U").charAt(0).toUpperCase();
      var headerLetter = document.getElementById("header-user-letter");
      if (headerLetter) headerLetter.textContent = letter;
      var menuName = document.getElementById("user-menu-name");
      if (menuName) menuName.textContent = name;
      var menuEmail = document.getElementById("user-menu-email");
      if (menuEmail) menuEmail.textContent = (me && me.email) || "";
    }

    var user = getAuthUser();
    updateUserMenu(user || state.user);

    fetchWithAuth("/auth/me")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        state.user = me || getAuthUser() || state.user;
        updateUserMenu(state.user);

        if (me && me.is_verified === false) {
          showUnverifiedBanner();
        }

        var promises = [];

        if (me) {
          promises.push(
            fetchWithAuth("/portfolio/balance")
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (data) {
                if (data && Array.isArray(data.assets) && data.assets.length > 0) {
                  var totalBal = data.total_balance_usd || 0;
                  state.positions = data.assets.map(function (a) {
                    return {
                      ticker: (a.symbol || "").toUpperCase(),
                      quantity: a.amount || 0,
                      averagePrice: a.purchase_price || 0,
                      currentPrice: a.current_price || 0,
                      currentValue: a.position_value || 0,
                      pnlAbsolute: a.profit || 0,
                      pnlPercent: a.percent_change || 0,
                      allocationPercent: totalBal > 0 ? ((a.position_value || 0) / totalBal) * 100 : 0,
                    };
                  });
                  state.totalValue = totalBal;
                  state.portfolioFromServer = true;
                }
              })
              .catch(function () {})
          );

          promises.push(
            fetchWithAuth("/watchlist")
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (data) {
                if (data && Array.isArray(data.items)) {
                  var existing = {};
                  state.tickers.forEach(function (t) { existing[t.toUpperCase()] = true; });
                  data.items.forEach(function (item) {
                    var sym = (item.symbol || "").toUpperCase();
                    if (sym && !existing[sym]) {
                      state.tickers.push(sym);
                      existing[sym] = true;
                    }
                  });
                  persist();
                }
              })
              .catch(function () {})
          );
        }

        var syncOn = localStorage.getItem(SYNC_SERVER_KEY) === "true";
        if (syncOn) {
          promises.push(
            fetchWithAuth("/transactions")
              .then(function (r) { return r.ok ? r.json() : []; })
              .then(function (arr) {
                if (Array.isArray(arr) && arr.length > 0) {
                  state.transactions = arr.map(function (t) {
                    return { id: t.id, ticker: t.symbol || t.ticker, type: t.type || "buy", quantity: parseFloat(t.amount) || 0, price: parseFloat(t.price) || 0, date: t.date || "", notes: "" };
                  });
                  persist();
                }
              })
              .catch(function () {})
          );
        }

        Promise.all(promises).then(function () {
          refreshPrices();
        });
      })
      .catch(function () {
        refreshPrices();
      });

    document.querySelectorAll("[data-open-transaction]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        _lastModalTrigger = document.activeElement;
        document.getElementById("transaction-modal").setAttribute("aria-hidden", "false");
        document.getElementById("tx-date").value = new Date().toISOString().slice(0, 10);
        createIcons();
      });
    });
    document.querySelectorAll("[data-open-asset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        _lastModalTrigger = document.activeElement;
        document.getElementById("asset-panel").setAttribute("aria-hidden", "false");
        document.getElementById("asset-panel-title").textContent = "AI Insights";
        var body = document.getElementById("asset-panel-body");
        if (body) body.innerHTML = "<p class=\"text-muted\">Carregando…</p>";
        createIcons();
        fetchWithAuth("/analysis/portfolio")
          .then(function (r) {
            if (r.status === 402) {
              if (body) body.innerHTML = "<p class=\"text-muted\">Faça upgrade para ver análise com IA.</p>";
              return;
            }
            return r.ok ? r.json() : null;
          })
          .then(function (data) {
            if (body && data && data.analysis) body.innerHTML = "<div class=\"asset-panel-analysis\">" + data.analysis.replace(/</g, "&lt;") + "</div>";
            else if (body && !body.innerHTML.includes("upgrade")) body.innerHTML = "<p class=\"text-muted\">Em breve.</p>";
            createIcons();
          })
          .catch(function () {
            if (body) body.innerHTML = "<p class=\"text-muted\">Em breve.</p>";
            createIcons();
          });
      });
    });

    var txModal = document.getElementById("transaction-modal");
    var txForm = document.getElementById("transaction-form");
    var txCancel = document.getElementById("tx-cancel");
    var txTicker = document.getElementById("tx-ticker");
    var txPrice = document.getElementById("tx-price");
    var txTypeBuy = document.querySelector(".tx-type-btn[data-type=\"buy\"]");
    var txTypeSell = document.querySelector(".tx-type-btn[data-type=\"sell\"]");
    var txTypeInput = document.getElementById("tx-type");

    function closeTxModal() {
      focusBeforeHide(txModal, _lastModalTrigger);
    }
    txModal.querySelector(".modal-backdrop").addEventListener("click", closeTxModal);
    txModal.querySelector(".modal-close").addEventListener("click", closeTxModal);
    txCancel.addEventListener("click", closeTxModal);

    if (txTypeBuy) txTypeBuy.addEventListener("click", function () {
      txTypeBuy.classList.add("active");
      if (txTypeSell) txTypeSell.classList.remove("active");
      txTypeInput.value = "buy";
    });
    if (txTypeSell) txTypeSell.addEventListener("click", function () {
      txTypeSell.classList.add("active");
      if (txTypeBuy) txTypeBuy.classList.remove("active");
      txTypeInput.value = "sell";
    });

    var tickerDropdown = document.getElementById("tx-ticker-dropdown");
    var txTickerSearchTimeout;
    var txTickerActiveIndex = -1;

    function txTickerSelectOption(ticker, price) {
      if (!ticker) return;
      ticker = ticker.toUpperCase();
      txTicker.value = ticker;
      if (price != null && !isNaN(price)) txPrice.value = price;
      tickerDropdown.style.display = "none";
      tickerDropdown.innerHTML = "";
      if (txTicker.setAttribute) txTicker.setAttribute("aria-expanded", "false");
      txTicker.removeAttribute("aria-activedescendant");
      txTickerActiveIndex = -1;
      try {
        var prev = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
        prev = [ticker].concat(prev.filter(function (x) { return x !== ticker; })).slice(0, 5);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(prev));
      } catch (e) {}
    }

    function txTickerSetButtonsAndListeners(items) {
      tickerDropdown.innerHTML = items.map(function (item, i) {
        var t = item.ticker || item;
        var label = item.label != null ? item.label : t;
        return "<button type=\"button\" id=\"tx-ticker-opt-" + i + "\" role=\"option\" aria-selected=\"false\" data-ticker=\"" + t + "\" data-price=\"" + (item.price != null ? item.price : "") + "\">" + label + "</button>";
      }).join("");
      tickerDropdown.style.display = "block";
      if (txTicker.setAttribute) txTicker.setAttribute("aria-expanded", "true");
      txTickerActiveIndex = -1;
      tickerDropdown.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () {
          txTickerSelectOption(b.getAttribute("data-ticker"), parseFloat(b.getAttribute("data-price"), 10));
        });
      });
    }

    if (txTicker) txTicker.addEventListener("input", function () {
      var q = txTicker.value.trim().toUpperCase();
      if (q.length < 1) { tickerDropdown.innerHTML = ""; tickerDropdown.style.display = "none"; if (txTicker.setAttribute) txTicker.setAttribute("aria-expanded", "false"); return; }
      clearTimeout(txTickerSearchTimeout);
      txTickerSearchTimeout = setTimeout(function () {
        if (q.length >= 2) {
          fetch(getApiBase() + "/search?q=" + encodeURIComponent(q))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              var list = Array.isArray(data) ? data : (data && data.results ? data.results : []);
              var items = list.slice(0, 8).map(function (item) {
                var sym = item.symbol || item.ticker || item;
                var label = typeof sym === "string" ? sym : (item.name || item.symbol || item.ticker || "");
                var tickerVal = typeof sym === "string" ? sym : (item.symbol || item.ticker || "");
                var p = state.prices[tickerVal] != null ? state.prices[tickerVal] : (item.price != null ? item.price : null);
                return { ticker: tickerVal, label: label || tickerVal, price: p };
              });
              if (items.length === 0) items = [{ ticker: q, label: q, price: state.prices[q] }];
              txTickerSetButtonsAndListeners(items);
            })
            .catch(function () {
              txTickerSetButtonsAndListeners([{ ticker: q, label: q, price: state.prices[q] }]);
            });
        } else {
          var recent = [];
          try { recent = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]").slice(0, 5); } catch (e) {}
          var list = recent.filter(function (s) { return s.indexOf(q) !== -1; });
          if (list.length === 0) list = [q];
          txTickerSetButtonsAndListeners(list.map(function (s) { return { ticker: s, label: s, price: state.prices[s] }; }));
        }
      }, 200);
    });
    if (txTicker) txTicker.addEventListener("keydown", function (e) {
      var hidden = tickerDropdown.style.display === "none" || !tickerDropdown.innerHTML;
      var buttons = tickerDropdown.querySelectorAll("button[data-ticker]");
      if (e.key === "Escape") {
        tickerDropdown.style.display = "none";
        tickerDropdown.innerHTML = "";
        txTicker.setAttribute("aria-expanded", "false");
        txTicker.removeAttribute("aria-activedescendant");
        txTickerActiveIndex = -1;
        return;
      }
      if (hidden || buttons.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        txTickerActiveIndex = txTickerActiveIndex >= buttons.length - 1 ? 0 : txTickerActiveIndex + 1;
        buttons.forEach(function (b, i) { b.setAttribute("aria-selected", i === txTickerActiveIndex ? "true" : "false"); });
        txTicker.setAttribute("aria-activedescendant", "tx-ticker-opt-" + txTickerActiveIndex);
        buttons[txTickerActiveIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        txTickerActiveIndex = txTickerActiveIndex <= 0 ? buttons.length - 1 : txTickerActiveIndex - 1;
        buttons.forEach(function (b, i) { b.setAttribute("aria-selected", i === txTickerActiveIndex ? "true" : "false"); });
        txTicker.setAttribute("aria-activedescendant", "tx-ticker-opt-" + txTickerActiveIndex);
        buttons[txTickerActiveIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && txTickerActiveIndex >= 0 && buttons[txTickerActiveIndex]) {
        e.preventDefault();
        var b = buttons[txTickerActiveIndex];
        txTickerSelectOption(b.getAttribute("data-ticker"), parseFloat(b.getAttribute("data-price"), 10));
      }
    });
    if (txTicker) txTicker.addEventListener("blur", function () {
      setTimeout(function () { if (tickerDropdown) { tickerDropdown.style.display = "none"; txTickerActiveIndex = -1; } }, 150);
    });

    txForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var type = txTypeInput.value;
      var ticker = (document.getElementById("tx-ticker").value || "").toUpperCase();
      var quantity = parseFloat(document.getElementById("tx-quantity").value, 10);
      var price = parseFloat(document.getElementById("tx-price").value, 10);
      var date = document.getElementById("tx-date").value;
      var notes = (document.getElementById("tx-notes") && document.getElementById("tx-notes").value) || "";
      if (!ticker || !quantity || !price || !date) return;
      if (type === "sell") {
        var pos = state.positions.find(function (p) { return p.ticker === ticker; });
        if (!pos || pos.quantity < quantity) {
          alert("Quantidade maior que a posição");
          return;
        }
      }
      state.transactions.push({
        id: crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now(),
        ticker: ticker,
        type: type,
        quantity: quantity,
        price: price,
        date: date,
        notes: notes,
        createdAt: new Date().toISOString(),
      });
      persist();
      refreshPrices();
      closeTxModal();
      txForm.reset();
      document.getElementById("tx-date").value = new Date().toISOString().slice(0, 10);
    });

    var assetPanel = document.getElementById("asset-panel");
    if (assetPanel) {
      assetPanel.querySelector(".asset-panel-backdrop").addEventListener("click", function () {
        focusBeforeHide(assetPanel, _lastModalTrigger);
      });
      var closeBtn = assetPanel.querySelector(".asset-panel-close");
      if (closeBtn) closeBtn.addEventListener("click", function () { focusBeforeHide(assetPanel, _lastModalTrigger); });
    }

    document.getElementById("btn-settings").addEventListener("click", function () {
      _lastModalTrigger = document.activeElement;
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "false");
      var btnVal = document.getElementById("settings-values-btn");
      if (btnVal) btnVal.textContent = state.valuesHidden ? "On" : "Off";
      var u = state.user;
      var notifEmail = document.getElementById("settings-notif-email");
      var notifDigest = document.getElementById("settings-notif-digest");
      var notifBrowser = document.getElementById("settings-notif-browser");
      if (notifEmail) { notifEmail.textContent = (u && u.notification_email) ? "On" : "Off"; notifEmail.setAttribute("aria-pressed", (u && u.notification_email) ? "true" : "false"); }
      if (notifDigest) { notifDigest.textContent = (u && u.notification_digest) ? "On" : "Off"; notifDigest.setAttribute("aria-pressed", (u && u.notification_digest) ? "true" : "false"); }
      if (notifBrowser) { notifBrowser.textContent = (u && u.notification_browser) ? "On" : "Off"; notifBrowser.setAttribute("aria-pressed", (u && u.notification_browser) ? "true" : "false"); }
      var localeSel = document.getElementById("settings-locale");
      var currencySel = document.getElementById("settings-currency");
      if (localeSel && u && u.locale) localeSel.value = u.locale;
      if (currencySel && u && u.currency) currencySel.value = u.currency;
      createIcons();
    });
    document.getElementById("settings-drawer").querySelector(".settings-backdrop").addEventListener("click", function () {
      focusBeforeHide(document.getElementById("settings-drawer"), _lastModalTrigger);
    });
    document.getElementById("settings-drawer").querySelector(".settings-close").addEventListener("click", function () {
      focusBeforeHide(document.getElementById("settings-drawer"), _lastModalTrigger);
    });
    document.getElementById("settings-values-btn").addEventListener("click", function () {
      state.valuesHidden = !state.valuesHidden;
      persist();
      render();
      this.textContent = state.valuesHidden ? "On" : "Off";
    });
    document.getElementById("btn-theme").addEventListener("click", function () {
      var next = document.body.getAttribute("data-theme") === "light" ? "dark" : "light";
      setTheme(next);
    });
    var settingsThemeBtn = document.getElementById("settings-theme-btn");
    if (settingsThemeBtn) settingsThemeBtn.addEventListener("click", function () {
      var next = document.body.getAttribute("data-theme") === "light" ? "dark" : "light";
      setTheme(next);
    });
    document.getElementById("settings-export-csv").addEventListener("click", function () {
      if (state.transactions.length === 0) { alert("Nenhuma transação para exportar"); return; }
      var csv = ["Date,Ticker,Type,Quantity,Price,Total,Notes"].concat(state.transactions.map(function (t) {
        return t.date + "," + t.ticker + "," + t.type + "," + t.quantity + "," + t.price + "," + (t.quantity * t.price).toFixed(2) + ",\"" + (t.notes || "").replace(/"/g, '""') + "\"";
      })).join("\n");
      var blob = new Blob([csv], { type: "text/csv" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "purp-portfolio-" + new Date().toISOString().slice(0, 10) + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    var settingsExportFiscal = document.getElementById("settings-export-fiscal");
    if (settingsExportFiscal) settingsExportFiscal.addEventListener("click", function () {
      var year = new Date().getFullYear();
      fetchWithAuth("/tax/form-8949?year=" + year).then(function (r) {
        if (r.status === 402) { alert("Plano Tax Pro necessário para relatório fiscal."); return; }
        if (!r.ok) return r.text().then(function (t) { alert("Erro: " + (t || r.status)); });
        return r.blob().then(function (blob) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "form-8949-" + year + ".csv";
          a.click();
          URL.revokeObjectURL(a.href);
        });
      });
    });
    function patchPreferences(prefs) {
      fetchWithAuth("/user/preferences", {
        method: "PATCH",
        body: JSON.stringify(prefs),
      }).then(function (r) {
        if (r.ok) return r.json();
        return null;
      }).then(function (data) {
        if (data && state.user) {
          state.user.notification_email = data.notification_email;
          state.user.notification_digest = data.notification_digest;
          state.user.notification_browser = data.notification_browser;
        }
      }).catch(function () {});
    }
    document.getElementById("settings-notif-email").addEventListener("click", function () {
      var next = !(state.user && state.user.notification_email);
      this.textContent = next ? "On" : "Off";
      this.setAttribute("aria-pressed", next ? "true" : "false");
      patchPreferences({ notification_email: next, notification_digest: state.user && state.user.notification_digest, notification_browser: state.user && state.user.notification_browser });
    });
    document.getElementById("settings-notif-digest").addEventListener("click", function () {
      var next = !(state.user && state.user.notification_digest);
      this.textContent = next ? "On" : "Off";
      this.setAttribute("aria-pressed", next ? "true" : "false");
      patchPreferences({ notification_email: state.user && state.user.notification_email, notification_digest: next, notification_browser: state.user && state.user.notification_browser });
    });
    document.getElementById("settings-notif-browser").addEventListener("click", function () {
      var next = !(state.user && state.user.notification_browser);
      this.textContent = next ? "On" : "Off";
      this.setAttribute("aria-pressed", next ? "true" : "false");
      patchPreferences({ notification_email: state.user && state.user.notification_email, notification_digest: state.user && state.user.notification_digest, notification_browser: next });
    });
    document.getElementById("settings-edit-profile").addEventListener("click", function () {
      _lastModalTrigger = document.activeElement;
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
      var u = state.user;
      document.getElementById("profile-full-name").value = (u && (u.full_name || u.username)) || "";
      document.getElementById("profile-email").value = (u && u.email) || "";
      document.getElementById("edit-profile-result").textContent = "";
      document.getElementById("edit-profile-modal").setAttribute("aria-hidden", "false");
      createIcons();
    });
    document.getElementById("settings-change-password").addEventListener("click", function () {
      _lastModalTrigger = document.activeElement;
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
      document.getElementById("current-password").value = "";
      document.getElementById("new-password").value = "";
      document.getElementById("change-password-result").textContent = "";
      document.getElementById("change-password-modal").setAttribute("aria-hidden", "false");
      createIcons();
    });
    document.getElementById("settings-locale").addEventListener("change", function () {
      var locale = this.value;
      if (!state.user) return;
      fetchWithAuth("/user/profile", { method: "PATCH", body: JSON.stringify({ locale: locale }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data) state.user.locale = data.locale; })
        .catch(function () {});
    });
    document.getElementById("settings-currency").addEventListener("change", function () {
      var currency = this.value;
      if (!state.user) return;
      fetchWithAuth("/user/profile", { method: "PATCH", body: JSON.stringify({ currency: currency }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) { if (data) state.user.currency = data.currency; render(); })
        .catch(function () {});
    });
    document.getElementById("settings-manage-subscription").addEventListener("click", function () {
      var body = { plan: "investor" };
      if (state.user && state.user.referred_by_id) body.promotion_code = "promo_1T5zIiP6HjWToP4aqM1sVwQj";
      fetchWithAuth("/stripe/create-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.detail || e.message || "Erro"); }); })
        .then(function (data) {
          if (data && data.checkout_url) window.open(data.checkout_url, "_blank");
        })
        .catch(function (err) { alert(err.message || "Erro ao abrir checkout."); });
    });

    function openTransactionsPanel() {
      _lastModalTrigger = document.activeElement;
      var transactionsPanel = document.getElementById("transactions-panel");
      var listEl = document.getElementById("transactions-panel-list");
      if (!transactionsPanel || !listEl) return;
      var txs = (state.transactions || []).slice().sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
      if (txs.length === 0) {
        listEl.innerHTML = "<p class=\"text-muted\">Nenhuma transação. Toque em \"Nova transação\" para registrar.</p>";
      } else {
        listEl.innerHTML = txs.map(function (t) {
          var typeClass = t.type === "buy" ? "tx-type-buy" : "tx-type-sell";
          var typeLabel = t.type === "buy" ? "Compra" : "Venda";
          var total = (t.quantity * t.price) || 0;
          return "<div class=\"tx-item\"><div><span class=\"tx-date\">" + (t.date || "") + "</span> <span class=\"tx-ticker\">" + (t.ticker || "") + "</span> <span class=\"" + typeClass + "\">" + typeLabel + "</span></div><div>" + t.quantity + " × " + formatCurrency(t.price) + " = " + formatCurrency(total) + "</div></div>";
        }).join("");
      }
      transactionsPanel.setAttribute("aria-hidden", "false");
      createIcons();
    }

    var settingsTransactionsListBtn = document.getElementById("settings-transactions-list");
    if (settingsTransactionsListBtn) {
      settingsTransactionsListBtn.addEventListener("click", function () {
        document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
        openTransactionsPanel();
      });
    }

    var editProfileModal = document.getElementById("edit-profile-modal");
    if (editProfileModal) {
      editProfileModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(editProfileModal, _lastModalTrigger); });
      editProfileModal.querySelector(".edit-profile-close").addEventListener("click", function () { focusBeforeHide(editProfileModal, _lastModalTrigger); });
    }
    document.getElementById("edit-profile-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var fullName = document.getElementById("profile-full-name").value.trim();
      var email = document.getElementById("profile-email").value.trim().toLowerCase();
      var resultEl = document.getElementById("edit-profile-result");
      fetchWithAuth("/user/profile", {
        method: "PATCH",
        body: JSON.stringify({ full_name: fullName || null, email: email || null }),
      }).then(function (r) {
        if (r.ok) return r.json();
        return r.json().then(function (err) { throw new Error(err.detail || err.message || "Erro"); });
      }).then(function (data) {
        if (data) {
          state.user = Object.assign(state.user || {}, data);
          if (data.full_name != null) state.user.full_name = data.full_name;
          if (data.email != null) state.user.email = data.email;
          resultEl.textContent = "Salvo.";
          resultEl.style.color = "var(--positive, green)";
          var menuName = document.getElementById("user-menu-name");
          if (menuName) menuName.textContent = state.user.full_name || state.user.username || "User";
          setTimeout(function () { focusBeforeHide(document.getElementById("edit-profile-modal"), _lastModalTrigger); }, 500);
        }
      }).catch(function (err) {
        resultEl.textContent = err.message || "Erro ao salvar.";
        resultEl.style.color = "var(--negative, red)";
      });
    });

    var changePasswordModal = document.getElementById("change-password-modal");
    if (changePasswordModal) {
      changePasswordModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(changePasswordModal, _lastModalTrigger); });
      changePasswordModal.querySelector(".change-password-close").addEventListener("click", function () { focusBeforeHide(changePasswordModal, _lastModalTrigger); });
    }
    document.getElementById("change-password-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var current = document.getElementById("current-password").value;
      var newPw = document.getElementById("new-password").value;
      var resultEl = document.getElementById("change-password-result");
      fetchWithAuth("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: newPw }),
      }).then(function (r) {
        if (r.ok) return;
        return r.json().then(function (err) { throw new Error(err.detail || err.message || "Erro"); });
      }).then(function () {
        resultEl.textContent = "Senha alterada.";
        resultEl.style.color = "var(--positive, green)";
        document.getElementById("current-password").value = "";
        document.getElementById("new-password").value = "";
        setTimeout(function () { focusBeforeHide(document.getElementById("change-password-modal"), _lastModalTrigger); }, 500);
      }).catch(function (err) {
        resultEl.textContent = err.message || "Erro ao alterar senha.";
        resultEl.style.color = "var(--negative, red)";
      });
    });
    document.getElementById("settings-import-csv").addEventListener("click", function () {
      _lastModalTrigger = document.activeElement;
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
      document.getElementById("import-modal").setAttribute("aria-hidden", "false");
      document.getElementById("import-file").value = "";
      document.getElementById("import-result").textContent = "";
    });

    document.getElementById("import-modal").querySelector(".modal-backdrop").addEventListener("click", function () {
      focusBeforeHide(document.getElementById("import-modal"), _lastModalTrigger);
    });
    document.getElementById("import-modal").querySelector(".import-close").addEventListener("click", function () {
      focusBeforeHide(document.getElementById("import-modal"), _lastModalTrigger);
    });
    document.getElementById("import-do").addEventListener("click", function () {
      var input = document.getElementById("import-file");
      if (!input.files || !input.files[0]) { document.getElementById("import-result").textContent = "Selecione um arquivo."; return; }
      var file = input.files[0];
      var reader = new FileReader();
      reader.onload = function () {
        var text = reader.result;
        var lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) { document.getElementById("import-result").textContent = "Arquivo vazio ou inválido."; return; }
        var header = lines[0].toLowerCase().split(",").map(function (s) { return s.trim().replace(/^"|"$/g, ""); });
        var dateIdx = header.indexOf("date");
        var tickerIdx = header.indexOf("ticker");
        var typeIdx = header.indexOf("type");
        var qtyIdx = header.indexOf("quantity");
        var priceIdx = header.indexOf("price");
        if (dateIdx < 0 || tickerIdx < 0 || typeIdx < 0 || qtyIdx < 0 || priceIdx < 0) {
          document.getElementById("import-result").textContent = "Cabeçalho esperado: Date,Ticker,Type,Quantity,Price[,Notes]";
          return;
        }
        var txs = [];
        for (var i = 1; i < lines.length; i++) {
          var parts = lines[i].split(",").map(function (s) { return s.trim().replace(/^"|"$/g, ""); });
          if (parts.length < 5) continue;
          var date = parts[dateIdx];
          var ticker = parts[tickerIdx].toUpperCase();
          var typeStr = parts[typeIdx].toLowerCase();
          var type = typeStr.indexOf("sell") !== -1 ? "sell" : "buy";
          var qty = parseFloat(parts[qtyIdx].replace(",", "."), 10);
          var price = parseFloat(parts[priceIdx].replace(",", "."), 10);
          if (!date || !ticker || isNaN(qty) || isNaN(price)) continue;
          txs.push({ ticker: ticker, type: type, quantity: qty, price: price, date: date, notes: parts[5] || "" });
        }
        state.transactions = txs.map(function (t) {
          return {
            id: crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random(),
            ticker: t.ticker,
            type: t.type,
            quantity: t.quantity,
            price: t.price,
            date: t.date,
            notes: t.notes || "",
            createdAt: new Date().toISOString(),
          };
        });
        persist();
        refreshPrices();
        document.getElementById("import-result").textContent = "Importadas " + txs.length + " transações.";
        focusBeforeHide(document.getElementById("import-modal"), _lastModalTrigger);
      };
      reader.readAsText(file);
    });

    document.getElementById("btn-toggle-values").addEventListener("click", function () {
      state.valuesHidden = !state.valuesHidden;
      persist();
      render();
      this.innerHTML = state.valuesHidden ? "<i data-lucide=\"eye-off\" width=\"20\" height=\"20\"></i>" : "<i data-lucide=\"eye\" width=\"20\" height=\"20\"></i>";
      createIcons();
    });

    document.getElementById("btn-user").addEventListener("click", function (e) {
      e.stopPropagation();
      var panel = document.getElementById("user-menu");
      panel.setAttribute("aria-hidden", panel.getAttribute("aria-hidden") === "true" ? "false" : "true");
    });
    document.querySelectorAll("#user-menu button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("user-menu").setAttribute("aria-hidden", "true");
        if (btn.getAttribute("data-action") === "logout") {
          clearSession();
          window.location.href = "/";
        }
        if (btn.getAttribute("data-action") === "account") {
          _lastModalTrigger = document.activeElement;
          var accountModal = document.getElementById("account-modal");
          accountModal.setAttribute("aria-hidden", "false");
          var body = document.getElementById("account-modal-body");
          var netWorthEl = document.getElementById("account-net-worth");
          if (netWorthEl) netWorthEl.textContent = "Carregando…";
          fetchWithAuth("/auth/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
            if (me) updateUserMenu(me);
          });
          fetchWithAuth("/net-worth")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
              if (netWorthEl && data && data.net_worth != null) {
                var txt = formatCurrency(data.net_worth);
                if (data.percent_change != null) txt += " <span class=\"account-change " + (data.percent_change >= 0 ? "positive" : "negative") + "\">(" + (data.percent_change >= 0 ? "+" : "") + data.percent_change.toFixed(1) + "% vs. mês anterior)</span>";
                netWorthEl.innerHTML = txt;
              } else if (netWorthEl) netWorthEl.textContent = formatCurrency(0);
            })
            .catch(function () { if (netWorthEl) netWorthEl.textContent = "—"; });
          var firstFocus = accountModal.querySelector("button, [href], input, select, textarea");
          if (firstFocus) setTimeout(function () { firstFocus.focus(); }, 100);
          var syncToggle = document.getElementById("account-sync-toggle");
          if (syncToggle) {
            var syncOn = localStorage.getItem(SYNC_SERVER_KEY) === "true";
            syncToggle.textContent = syncOn ? "On" : "Off";
            syncToggle.onclick = function () {
              var next = localStorage.getItem(SYNC_SERVER_KEY) !== "true";
              localStorage.setItem(SYNC_SERVER_KEY, next ? "true" : "false");
              this.textContent = next ? "On" : "Off";
              if (next) {
                fetchWithAuth("/transactions").then(function (r) { return r.ok ? r.json() : []; }).then(function (arr) {
                  if (Array.isArray(arr)) {
                    state.transactions = arr.map(function (t) {
                      return { id: t.id, ticker: t.symbol || t.ticker, type: t.type || "buy", quantity: parseFloat(t.amount) || 0, price: parseFloat(t.price) || 0, date: t.date || "", notes: "" };
                    });
                    persist();
                    render();
                  }
                });
              }
            };
          }
          createIcons();
        }
      });
    });

    document.getElementById("btn-notifications").addEventListener("click", function (e) {
      e.stopPropagation();
      var panel = document.getElementById("notifications-panel");
      panel.setAttribute("aria-hidden", panel.getAttribute("aria-hidden") === "true" ? "false" : "true");
      var unread = state.notifications.filter(function (n) { return !n.isRead; }).length;
      var badge = document.getElementById("notif-badge");
      badge.style.display = unread > 0 ? "inline-flex" : "none";
      badge.textContent = unread;
      if (state.notifications.length === 0) {
        panel.innerHTML = "<div class=\"notif-empty\">Nenhuma notificação.</div>";
      } else {
        panel.innerHTML = state.notifications.slice(0, 10).map(function (n) {
          return "<div class=\"notif-item " + (n.isRead ? "" : "unread") + "\"><span class=\"notif-title\">" + (n.title || "") + "</span><span class=\"notif-msg\">" + (n.message || "") + "</span></div>";
        }).join("");
      }
    });

    var searchInput = document.getElementById("header-search-input");
    var searchDropdown = document.getElementById("header-search-dropdown");
    var searchDropdownTimeout;
    var headerSearchActiveIndex = -1;

    function headerSearchSelectTicker(ticker) {
      ticker = (ticker || "").toUpperCase();
      searchInput.value = "";
      searchDropdown.setAttribute("aria-hidden", "true");
      if (searchInput) searchInput.setAttribute("aria-expanded", "false");
      if (searchInput) searchInput.removeAttribute("aria-activedescendant");
      headerSearchActiveIndex = -1;
      try {
        var prev = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
        prev = [ticker].concat(prev.filter(function (x) { return x !== ticker; })).slice(0, 5);
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(prev));
      } catch (e) {}
      if (state.tickers.indexOf(ticker) === -1) {
        state.tickers.push(ticker);
        persist();
        if (getAuthToken()) {
          fetchWithAuth("/watchlist", { method: "POST", body: JSON.stringify({ symbol: ticker }) }).catch(function () {});
        }
        refreshPrices();
      }
      openAssetPanel(ticker);
      createIcons();
    }

    function headerSearchSetButtonsAndListeners() {
      var buttons = searchDropdown.querySelectorAll("button[data-ticker]");
      headerSearchActiveIndex = -1;
      buttons.forEach(function (b, i) {
        b.id = "header-search-opt-" + i;
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", "false");
        b.addEventListener("click", function () { headerSearchSelectTicker(b.getAttribute("data-ticker")); });
      });
    }

    if (searchInput) searchInput.addEventListener("input", function () {
      var q = this.value.trim();
      if (q.length < 1) {
        var recent = [];
        try { recent = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]").slice(0, 5); } catch (e) {}
        if (recent.length === 0) { searchDropdown.innerHTML = ""; searchDropdown.setAttribute("aria-hidden", "true"); if (searchInput) searchInput.setAttribute("aria-expanded", "false"); return; }
        searchDropdown.innerHTML = "<div class=\"recent-label\">Recentes</div>" + recent.map(function (s, i) {
          return "<button type=\"button\" data-ticker=\"" + s + "\">" + s + "</button>";
        }).join("");
        searchDropdown.setAttribute("aria-hidden", "false");
        if (searchInput) searchInput.setAttribute("aria-expanded", "true");
        headerSearchSetButtonsAndListeners();
        return;
      }
      clearTimeout(searchDropdownTimeout);
      if (q.length >= 2) {
        searchDropdownTimeout = setTimeout(function () {
          fetch(getApiBase() + "/search?q=" + encodeURIComponent(q))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              var list = Array.isArray(data) ? data : (data && data.results ? data.results : []);
              var items = list.slice(0, 8).map(function (item) {
                var sym = item.symbol || item.ticker || item;
                var label = typeof sym === "string" ? sym : (item.name || item.symbol || item.ticker || "");
                var tickerVal = typeof sym === "string" ? sym : (item.symbol || item.ticker || "");
                return "<button type=\"button\" data-ticker=\"" + tickerVal + "\">" + (label || tickerVal) + "</button>";
              });
              if (items.length === 0) items = ["<button type=\"button\" data-ticker=\"" + q.toUpperCase() + "\">" + q.toUpperCase() + "</button>"];
              searchDropdown.innerHTML = items.join("");
              searchDropdown.setAttribute("aria-hidden", "false");
              if (searchInput) searchInput.setAttribute("aria-expanded", "true");
              headerSearchSetButtonsAndListeners();
            })
            .catch(function () {
              searchDropdown.innerHTML = "<button type=\"button\" data-ticker=\"" + q.toUpperCase() + "\">" + q.toUpperCase() + "</button>";
              searchDropdown.setAttribute("aria-hidden", "false");
              if (searchInput) searchInput.setAttribute("aria-expanded", "true");
              headerSearchSetButtonsAndListeners();
            });
        }, 300);
        return;
      }
      searchDropdown.innerHTML = "<button type=\"button\" data-ticker=\"" + q.toUpperCase() + "\">" + q.toUpperCase() + "</button>";
      searchDropdown.setAttribute("aria-hidden", "false");
      if (searchInput) searchInput.setAttribute("aria-expanded", "true");
      headerSearchSetButtonsAndListeners();
    });
    if (searchInput) searchInput.addEventListener("keydown", function (e) {
      var hidden = searchDropdown.getAttribute("aria-hidden") === "true";
      var buttons = searchDropdown.querySelectorAll("button[data-ticker]");
      if (e.key === "Escape") {
        searchDropdown.setAttribute("aria-hidden", "true");
        if (searchInput) searchInput.setAttribute("aria-expanded", "false");
        searchInput.removeAttribute("aria-activedescendant");
        headerSearchActiveIndex = -1;
        searchInput.blur();
        return;
      }
      if (hidden || buttons.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        headerSearchActiveIndex = headerSearchActiveIndex >= buttons.length - 1 ? 0 : headerSearchActiveIndex + 1;
        buttons.forEach(function (b, i) { b.setAttribute("aria-selected", i === headerSearchActiveIndex ? "true" : "false"); });
        searchInput.setAttribute("aria-activedescendant", "header-search-opt-" + headerSearchActiveIndex);
        buttons[headerSearchActiveIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        headerSearchActiveIndex = headerSearchActiveIndex <= 0 ? buttons.length - 1 : headerSearchActiveIndex - 1;
        buttons.forEach(function (b, i) { b.setAttribute("aria-selected", i === headerSearchActiveIndex ? "true" : "false"); });
        searchInput.setAttribute("aria-activedescendant", "header-search-opt-" + headerSearchActiveIndex);
        buttons[headerSearchActiveIndex].scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && headerSearchActiveIndex >= 0 && buttons[headerSearchActiveIndex]) {
        e.preventDefault();
        headerSearchSelectTicker(buttons[headerSearchActiveIndex].getAttribute("data-ticker"));
      }
    });
    if (searchInput) searchInput.addEventListener("blur", function () {
      setTimeout(function () {
        searchDropdown.setAttribute("aria-hidden", "true");
        if (searchInput) searchInput.setAttribute("aria-expanded", "false");
        searchInput.removeAttribute("aria-activedescendant");
        headerSearchActiveIndex = -1;
      }, 200);
    });

    document.body.addEventListener("click", function () {
      document.getElementById("user-menu").setAttribute("aria-hidden", "true");
      document.getElementById("notifications-panel").setAttribute("aria-hidden", "true");
      document.getElementById("screenshot-menu").setAttribute("aria-hidden", "true");
    });
    document.getElementById("btn-screenshot").addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = document.getElementById("screenshot-menu");
      menu.setAttribute("aria-hidden", menu.getAttribute("aria-hidden") === "true" ? "false" : "true");
    });
    document.getElementById("screenshot-menu").querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("screenshot-menu").setAttribute("aria-hidden", "true");
        openShareModal();
      });
    });
    document.querySelector(".share-modal-backdrop").addEventListener("click", function () {
      focusBeforeHide(document.getElementById("share-modal"), _lastModalTrigger);
    });
    document.querySelector(".share-modal-close").addEventListener("click", function () {
      focusBeforeHide(document.getElementById("share-modal"), _lastModalTrigger);
    });
    document.getElementById("share-download-png").addEventListener("click", function () {
      shareDownloadPng();
    });

    var wlList = document.getElementById("watchlist-list");
    if (wlList) wlList.addEventListener("click", function (e) {
      var li = e.target.closest("li[data-ticker]");
      if (!li) return;
      openAssetPanel(li.getAttribute("data-ticker"));
    });

    var portfolioPositionsEl = document.getElementById("portfolio-positions");
    if (portfolioPositionsEl) portfolioPositionsEl.addEventListener("click", function (e) {
      var li = e.target.closest("li[data-ticker]");
      if (!li) return;
      openAssetPanel(li.getAttribute("data-ticker"));
    });

    var moversListEl = document.getElementById("movers-list");
    if (moversListEl) moversListEl.addEventListener("click", function (e) {
      var li = e.target.closest("li[data-ticker]");
      if (!li) return;
      openAssetPanel(li.getAttribute("data-ticker"));
    });

    document.querySelectorAll("[data-focus-watchlist]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var el = document.getElementById("widget-watchlist");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    var portfolioSortEl = document.getElementById("portfolio-sort");
    if (portfolioSortEl) portfolioSortEl.addEventListener("change", function () {
      state.portfolioSort = this.value || "value";
      render();
    });
    var moversSortEl = document.getElementById("movers-sort");
    if (moversSortEl) moversSortEl.addEventListener("change", function () {
      state.moversSort = this.value || "change-desc";
      render();
    });

    var headerSyncEl = document.getElementById("header-sync-indicator");
    if (headerSyncEl) {
      headerSyncEl.setAttribute("title", getAuthToken() ? "Dados sincronizados com sua conta" : "Modo local");
    }

    var accountModal = document.getElementById("account-modal");
    if (accountModal) {
      accountModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(accountModal, _lastModalTrigger); });
      accountModal.querySelector(".account-modal-close").addEventListener("click", function () { focusBeforeHide(accountModal, _lastModalTrigger); });
      accountModal.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && accountModal.getAttribute("aria-hidden") === "false") {
          e.preventDefault();
          focusBeforeHide(accountModal, _lastModalTrigger);
        }
      });
      var accountSessionsBtn = document.getElementById("account-sessions-btn");
      if (accountSessionsBtn) accountSessionsBtn.addEventListener("click", function () {
        _lastModalTrigger = document.activeElement;
        var sm = document.getElementById("sessions-modal");
        if (sm) sm.setAttribute("aria-hidden", "false");
        var listEl = document.getElementById("sessions-list");
        if (listEl) listEl.innerHTML = "Carregando…";
        fetchWithAuth("/user/sessions").then(function (r) { return r.ok ? r.json() : { sessions: [] }; }).then(function (data) {
          var sessions = data.sessions || [];
          if (listEl) {
            if (sessions.length === 0) listEl.innerHTML = "<p class=\"text-muted\">Nenhuma sessão ativa.</p>";
            else {
              listEl.innerHTML = sessions.map(function (s) {
                return "<div class=\"session-item\" data-id=\"" + s.id + "\"><span class=\"session-info\">" + (s.user_agent || "Dispositivo") + " — " + (s.created_at || "").slice(0, 19) + "</span> <button type=\"button\" class=\"btn-secondary btn-small session-revoke\" data-id=\"" + s.id + "\">Encerrar</button></div>";
              }).join("");
              listEl.querySelectorAll(".session-revoke").forEach(function (btn) {
                btn.addEventListener("click", function () {
                  var id = parseInt(btn.getAttribute("data-id"), 10);
                  fetchWithAuth("/user/sessions/" + id, { method: "DELETE" }).then(function (r) {
                    if (r.ok) { var item = listEl.querySelector(".session-item[data-id=\"" + id + "\"]"); if (item) item.remove(); }
                  });
                });
              });
            }
          }
        });
        var revokeAllBtn = document.getElementById("sessions-revoke-all");
        if (revokeAllBtn) revokeAllBtn.onclick = function () {
          fetchWithAuth("/user/sessions/revoke-all", { method: "POST" }).then(function (r) {
            if (r.ok && listEl) listEl.innerHTML = "<p class=\"text-muted\">Todas as sessões foram encerradas.</p>";
          });
        };
        createIcons();
      });
      var accountDeleteBtn = document.getElementById("account-delete-btn");
      if (accountDeleteBtn) accountDeleteBtn.addEventListener("click", function () {
        _lastModalTrigger = document.activeElement;
        var dm = document.getElementById("delete-account-modal");
        if (dm) {
          var step1 = document.getElementById("delete-account-step1");
          var step2 = document.getElementById("delete-account-step2");
          if (step1) step1.style.display = "block";
          if (step2) step2.style.display = "none";
          var conf = document.getElementById("delete-account-confirm");
          if (conf) conf.value = "";
          var errEl = document.getElementById("delete-account-err");
          if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }
          dm.setAttribute("aria-hidden", "false");
        }
        createIcons();
      });
      var accountGoalsBtn = document.getElementById("account-goals-btn");
      if (accountGoalsBtn) accountGoalsBtn.addEventListener("click", function () {
        _lastModalTrigger = document.activeElement;
        var gm = document.getElementById("goals-modal");
        if (gm) gm.setAttribute("aria-hidden", "false");
        var listEl = document.getElementById("goals-list");
        if (listEl) listEl.innerHTML = "Carregando…";
        fetchWithAuth("/user/goals").then(function (r) { return r.ok ? r.json() : { goals: [] }; }).then(function (data) {
          var goals = data.goals || [];
          if (listEl) {
            if (goals.length === 0) listEl.innerHTML = "<p class=\"text-muted\">Nenhuma meta. Crie uma abaixo.</p>";
            else {
              listEl.innerHTML = goals.map(function (g) {
                var pct = Math.min(100, (g.progress_pct || 0));
                return "<div class=\"goal-item\" data-id=\"" + g.id + "\"><div class=\"goal-header\"><strong>" + (g.label || "") + "</strong> <button type=\"button\" class=\"btn-small goal-delete\" data-id=\"" + g.id + "\">Excluir</button></div><div class=\"goal-progress\"><div class=\"goal-progress-bar\" style=\"width:" + pct + "%\"></div></div><span class=\"goal-values\">" + formatCurrency(g.current_value || 0) + " / " + formatCurrency(g.target_value || 0) + " (" + (g.progress_pct || 0) + "%)</span></div>";
              }).join("");
              listEl.querySelectorAll(".goal-delete").forEach(function (btn) {
                btn.addEventListener("click", function () {
                  var id = parseInt(btn.getAttribute("data-id"), 10);
                  fetchWithAuth("/user/goals/" + id, { method: "DELETE" }).then(function (r) {
                    if (r.ok) { var item = listEl.querySelector(".goal-item[data-id=\"" + id + "\"]"); if (item) item.remove(); }
                  });
                });
              });
            }
          }
        });
        createIcons();
      });
      var goalCreateBtn = document.getElementById("goal-create");
      if (goalCreateBtn) goalCreateBtn.addEventListener("click", function () {
        var label = (document.getElementById("goal-label") && document.getElementById("goal-label").value) || "";
        var target = parseFloat((document.getElementById("goal-target") && document.getElementById("goal-target").value)) || 0;
        var targetDate = (document.getElementById("goal-date") && document.getElementById("goal-date").value) || null;
        if (!label.trim()) return;
        fetchWithAuth("/user/goals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label.trim(), target_value: target, target_date: targetDate || undefined }),
        }).then(function (r) { return r.json(); }).then(function (g) {
          var listEl = document.getElementById("goals-list");
          if (listEl && listEl.innerHTML.indexOf("Nenhuma meta") !== -1) listEl.innerHTML = "";
          if (listEl) {
            var pct = Math.min(100, (g.progress_pct || 0));
            var html = "<div class=\"goal-item\" data-id=\"" + g.id + "\"><div class=\"goal-header\"><strong>" + (g.label || "") + "</strong> <button type=\"button\" class=\"btn-small goal-delete\" data-id=\"" + g.id + "\">Excluir</button></div><div class=\"goal-progress\"><div class=\"goal-progress-bar\" style=\"width:" + pct + "%\"></div></div><span class=\"goal-values\">" + formatCurrency(g.current_value || 0) + " / " + formatCurrency(g.target_value || 0) + " (" + (g.progress_pct || 0) + "%)</span></div>";
            listEl.insertAdjacentHTML("afterbegin", html);
            listEl.querySelector(".goal-delete").addEventListener("click", function () {
              fetchWithAuth("/user/goals/" + g.id, { method: "DELETE" }).then(function (r) {
                if (r.ok) { var item = listEl.querySelector(".goal-item[data-id=\"" + g.id + "\"]"); if (item) item.remove(); }
              });
            });
          }
          if (document.getElementById("goal-label")) document.getElementById("goal-label").value = "";
          if (document.getElementById("goal-target")) document.getElementById("goal-target").value = "";
          if (document.getElementById("goal-date")) document.getElementById("goal-date").value = "";
        });
      });
      var accountReferralBtn = document.getElementById("account-referral-btn");
      if (accountReferralBtn) accountReferralBtn.addEventListener("click", function () {
        fetchWithAuth("/user/referral").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
          if (data && data.referral_link) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(data.referral_link).then(function () { alert("Link copiado!"); });
            } else {
              var inp = document.createElement("input");
              inp.value = data.referral_link;
              document.body.appendChild(inp);
              inp.select();
              document.execCommand("copy");
              document.body.removeChild(inp);
              alert("Link copiado!");
            }
          }
        });
      });
      var accountBrokerBtn = document.getElementById("account-broker-btn");
      if (accountBrokerBtn) accountBrokerBtn.addEventListener("click", function () {
        _lastModalTrigger = document.activeElement;
        var bm = document.getElementById("broker-modal");
        if (bm) bm.setAttribute("aria-hidden", "false");
        var resultEl = document.getElementById("broker-result");
        if (resultEl) resultEl.textContent = "";
        createIcons();
      });
      var accountAlertsBtn = document.getElementById("account-alerts-btn");
      if (accountAlertsBtn) accountAlertsBtn.addEventListener("click", function () {
        openAlertsModal();
      });
    }

    var sessionsModal = document.getElementById("sessions-modal");
    if (sessionsModal) {
      sessionsModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(sessionsModal, _lastModalTrigger); });
      sessionsModal.querySelector(".sessions-modal-close").addEventListener("click", function () { focusBeforeHide(sessionsModal, _lastModalTrigger); });
    }
    var deleteAccountModal = document.getElementById("delete-account-modal");
    if (deleteAccountModal) {
      deleteAccountModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(deleteAccountModal, _lastModalTrigger); });
      deleteAccountModal.querySelectorAll(".delete-account-modal-close").forEach(function (el) { el.addEventListener("click", function () { focusBeforeHide(deleteAccountModal, _lastModalTrigger); }); });
      var deleteSubmit = document.getElementById("delete-account-submit");
      if (deleteSubmit) deleteSubmit.addEventListener("click", function () {
        var confirmVal = (document.getElementById("delete-account-confirm") && document.getElementById("delete-account-confirm").value) || "";
        if (confirmVal.trim().toUpperCase() !== "EXCLUIR") {
          var errEl = document.getElementById("delete-account-err");
          if (errEl) { errEl.textContent = "Digite EXCLUIR para confirmar."; errEl.style.display = "block"; }
          return;
        }
        fetchWithAuth("/user/request-deletion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_text: confirmVal.trim() }) }).then(function (r) {
          if (r.ok) {
            document.getElementById("delete-account-step1").style.display = "none";
            document.getElementById("delete-account-step2").style.display = "block";
            clearSession();
            setTimeout(function () { window.location.href = "/"; }, 2000);
          } else {
            var errEl = document.getElementById("delete-account-err");
            if (errEl) { errEl.textContent = "Erro ao solicitar exclusão."; errEl.style.display = "block"; }
          }
        });
      });
    }
    var goalsModal = document.getElementById("goals-modal");
    if (goalsModal) {
      goalsModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(goalsModal, _lastModalTrigger); });
      goalsModal.querySelector(".goals-modal-close").addEventListener("click", function () { focusBeforeHide(goalsModal, _lastModalTrigger); });
    }
    var widgetGoalsVerTodas = document.getElementById("widget-goals-ver-todas");
    if (widgetGoalsVerTodas) {
      widgetGoalsVerTodas.addEventListener("click", function () {
        var accountGoalsBtn = document.getElementById("account-goals-btn");
        if (accountGoalsBtn) accountGoalsBtn.click();
      });
    }
    var brokerModal = document.getElementById("broker-modal");
    if (brokerModal) {
      brokerModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(brokerModal, _lastModalTrigger); });
      brokerModal.querySelector(".broker-modal-close").addEventListener("click", function () { focusBeforeHide(brokerModal, _lastModalTrigger); });
      var brokerFetchBtn = document.getElementById("broker-fetch");
      if (brokerFetchBtn) brokerFetchBtn.addEventListener("click", function () {
        var broker = (document.getElementById("broker-select") && document.getElementById("broker-select").value) || "coinbase";
        var apiKey = (document.getElementById("broker-api-key") && document.getElementById("broker-api-key").value) || "";
        var apiSecret = (document.getElementById("broker-api-secret") && document.getElementById("broker-api-secret").value) || "";
        var resultEl = document.getElementById("broker-result");
        if (resultEl) resultEl.textContent = "Buscando…";
        fetchWithAuth("/broker/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker: broker, api_key: apiKey, api_secret: apiSecret }) }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); }).then(function (x) {
          if (resultEl) {
            if (x.ok && x.data && x.data.holdings) resultEl.textContent = "Encontradas " + (x.data.holdings.length || 0) + " posições.";
            else resultEl.textContent = (x.data && x.data.detail) || "Erro ao buscar.";
          }
        });
      });
      var brokerApplyBtn = document.getElementById("broker-apply");
      if (brokerApplyBtn) brokerApplyBtn.addEventListener("click", function () {
        var broker = (document.getElementById("broker-select") && document.getElementById("broker-select").value) || "coinbase";
        var apiKey = (document.getElementById("broker-api-key") && document.getElementById("broker-api-key").value) || "";
        var apiSecret = (document.getElementById("broker-api-secret") && document.getElementById("broker-api-secret").value) || "";
        fetchWithAuth("/broker/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker: broker, api_key: apiKey, api_secret: apiSecret }) }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); }).then(function (x) {
          if (!x.ok || !x.data || !x.data.holdings) {
            var resultEl = document.getElementById("broker-result");
            if (resultEl) resultEl.textContent = "Busque posições antes de aplicar.";
            return;
          }
          fetchWithAuth("/broker/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: x.data.holdings }) }).then(function (r) {
            var resultEl = document.getElementById("broker-result");
            if (resultEl) resultEl.textContent = r.ok ? "Posições aplicadas ao portfólio." : "Erro ao aplicar.";
          });
        });
      });
    }

    var transactionsPanel = document.getElementById("transactions-panel");
    var mobileNavTransactions = document.getElementById("mobile-nav-transactions");
    if (mobileNavTransactions && transactionsPanel) {
      mobileNavTransactions.addEventListener("click", function () {
        openTransactionsPanel();
      });
      transactionsPanel.querySelector(".mobile-panel-backdrop").addEventListener("click", function () {
        focusBeforeHide(transactionsPanel, _lastModalTrigger);
      });
      transactionsPanel.querySelector(".mobile-panel-close").addEventListener("click", function () {
        focusBeforeHide(transactionsPanel, _lastModalTrigger);
      });
      transactionsPanel.querySelector("[data-open-transaction]").addEventListener("click", function () {
        focusBeforeHide(transactionsPanel, _lastModalTrigger);
        document.getElementById("transaction-modal").setAttribute("aria-hidden", "false");
        document.getElementById("tx-date").value = new Date().toISOString().slice(0, 10);
        createIcons();
      });
    }

    var alertsModal = document.getElementById("alerts-modal");
    if (alertsModal) {
      alertsModal.querySelector(".modal-backdrop").addEventListener("click", function () { focusBeforeHide(alertsModal, _lastModalTrigger); });
      alertsModal.querySelector(".alerts-modal-close").addEventListener("click", function () { focusBeforeHide(alertsModal, _lastModalTrigger); });
      var alertCreateBtn = document.getElementById("alert-create");
      if (alertCreateBtn) alertCreateBtn.addEventListener("click", function () {
        var symbol = (document.getElementById("alert-symbol") && document.getElementById("alert-symbol").value) || "";
        var alertType = (document.getElementById("alert-type") && document.getElementById("alert-type").value) || "price_above";
        var targetVal = parseFloat((document.getElementById("alert-target") && document.getElementById("alert-target").value)) || 0;
        var resultEl = document.getElementById("alerts-result");
        if (!symbol.trim()) { if (resultEl) resultEl.textContent = "Informe o símbolo do ativo."; return; }
        if (targetVal <= 0) { if (resultEl) resultEl.textContent = "Informe um valor alvo maior que zero."; return; }
        if (resultEl) resultEl.textContent = "Criando…";
        fetchWithAuth("/alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: symbol.trim(), alert_type: alertType, target_value: targetVal, recurring: false }),
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); }).then(function (x) {
          if (resultEl) resultEl.textContent = x.ok ? "Alerta criado." : (x.data.detail || "Erro ao criar.");
          if (x.ok) {
            if (document.getElementById("alert-target")) document.getElementById("alert-target").value = "";
            openAlertsModal(document.getElementById("alert-symbol") ? document.getElementById("alert-symbol").value : "");
          }
        });
      });
    }

    setInterval(refreshPrices, 60000);
    createIcons();
  });
})();
