(function () {
  "use strict";

  var STORAGE_KEY = "purp-portfolio-storage";
  var SEARCH_HISTORY_KEY = "purp-search-history";
  var THEME_KEY = "purp-theme";
  var AUTH_TOKEN_KEY = "auth_token";
  var AUTH_USER_KEY = "purp_user";

  var COIN_IDS = {
    BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin",
    XRP: "ripple", ADA: "cardano", DOGE: "dogecoin", AVAX: "avalanche-2",
    DOT: "polkadot", LINK: "chainlink",
  };
  var CRYPTO_TICKERS = new Set(["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK"]);

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
  };

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
      var ids = cryptos.map(function (t) { return COIN_IDS[t] || t.toLowerCase(); }).join(",");
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd&include_24hr_change=true")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          cryptos.forEach(function (t) {
            var id = COIN_IDS[t] || t.toLowerCase();
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
        .then(function (r) { return r.json(); })
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
    var built = buildPositions(state.prices);
    state.positions = built.positions;
    state.totalValue = built.totalValue;

    var positions = state.positions;
    var totalValue = state.totalValue;
    var displayTotal = state.valuesHidden ? "••••" : "$" + totalValue.toFixed(2);
    var dayChangePct = 0;
    if (positions.length > 0) {
      var dayChange = positions.reduce(function (s, p) {
        var ch = (state.changes[p.ticker] || 0) / 100;
        return s + p.currentValue * ch;
      }, 0);
      dayChangePct = totalValue > 0 ? (dayChange / totalValue) * 100 : 0;
    }

    var portfolioEmpty = document.getElementById("portfolio-empty");
    var portfolioContent = document.getElementById("portfolio-content");
    var portfolioTotalValue = document.getElementById("portfolio-total-value");
    var portfolioPositions = document.getElementById("portfolio-positions");

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
          var val = state.valuesHidden ? "••••" : "$" + p.currentValue.toFixed(2);
          var pnlClass = p.pnlPercent >= 0 ? "positive" : "negative";
          var pnlStr = (p.pnlPercent >= 0 ? "+" : "") + p.pnlPercent.toFixed(2) + "%";
          return "<li><span class=\"pos-ticker\">" + p.ticker + "</span><span class=\"pos-value\">" + val + "</span> <span class=\"pos-pnl " + pnlClass + "\">" + pnlStr + "</span></li>";
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
          return "<li data-ticker=\"" + t + "\"><span class=\"wl-ticker\">" + t + "</span><span class=\"wl-price\">$" + price.toFixed(2) + "</span> <span class=\"wl-chg " + chClass + "\">" + chStr + "</span></li>";
        }).join("");
      }
    }

    var scoreValue = document.getElementById("score-value");
    var scoreClassEl = document.getElementById("score-class");
    var score = 50;
    if (positions.length > 0) {
      score = Math.min(100, 40 + Math.min(positions.length * 10, 30) + (state.totalValue > 10000 ? 10 : 0));
    }
    var classification = score >= 80 ? "Excellent" : score >= 60 ? "Good" : score >= 40 ? "Fair" : "Poor";
    if (scoreValue) scoreValue.textContent = score;
    if (scoreClassEl) scoreClassEl.textContent = classification;
    var gauge = document.getElementById("score-gauge");
    if (gauge) gauge.style.setProperty("--score", String(score));

    var moversList = document.getElementById("movers-list");
    if (moversList) {
      var movers = [
        { ticker: "BTC", changePercent: state.changes["BTC"] || 2.5 },
        { ticker: "ETH", changePercent: state.changes["ETH"] || 1.8 },
        { ticker: "NVDA", changePercent: state.changes["NVDA"] || 3.2 },
        { ticker: "AAPL", changePercent: state.changes["AAPL"] || -0.5 },
        { ticker: "TSLA", changePercent: state.changes["TSLA"] || 4.1 },
      ];
      moversList.innerHTML = movers.map(function (m) {
        var c = m.changePercent >= 0 ? "up" : "dn";
        var str = (m.changePercent >= 0 ? "+" : "") + m.changePercent.toFixed(2) + "%";
        return "<li><span class=\"mover-ticker\">" + m.ticker + "</span><span class=\"mover-chg " + c + "\">" + str + "</span></li>";
      }).join("");
    }
  }

  function refreshPrices() {
    var tickers = allTickers();
    if (tickers.length === 0) tickers = ["BTC", "ETH", "AAPL"];
    fetchPrices(tickers, function () {
      render();
      fetchNews();
    });
  }

  function fetchNews() {
    var tickers = allTickers();
    var base = getApiBase();
    fetch(base + "/api/proxy/news")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = (data && data.Data) ? data.Data : [];
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

  state.positions = buildPositions(state.prices).positions;
  state.totalValue = buildPositions(state.prices).totalValue;

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

  document.addEventListener("DOMContentLoaded", function () {
    applyTheme(getTheme());

    var user = getAuthUser();
    var name = (user && (user.full_name || user.first_name)) ? (user.full_name || (user.first_name + " " + (user.last_name || "")).trim()) : (user && user.email) || "User";
    var letter = (name || "U").charAt(0).toUpperCase();
    var headerLetter = document.getElementById("header-user-letter");
    if (headerLetter) headerLetter.textContent = letter;
    var menuName = document.getElementById("user-menu-name");
    if (menuName) menuName.textContent = name;
    var menuEmail = document.getElementById("user-menu-email");
    if (menuEmail) menuEmail.textContent = (user && user.email) || "";

    refreshPrices();

    document.querySelectorAll("[data-open-transaction]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("transaction-modal").setAttribute("aria-hidden", "false");
        document.getElementById("tx-date").value = new Date().toISOString().slice(0, 10);
        createIcons();
      });
    });
    document.querySelectorAll("[data-open-asset]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.getElementById("asset-panel").setAttribute("aria-hidden", "false");
        document.getElementById("asset-panel-title").textContent = "AI Insights";
        var body = document.getElementById("asset-panel-body");
        if (body) body.innerHTML = "<p class=\"text-muted\">Em breve.</p>";
        createIcons();
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
      txModal.setAttribute("aria-hidden", "true");
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
    var searchTimeout;
    if (txTicker) txTicker.addEventListener("input", function () {
      var q = txTicker.value.trim().toUpperCase();
      if (q.length < 1) { tickerDropdown.innerHTML = ""; tickerDropdown.style.display = "none"; return; }
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(function () {
        var recent = [];
        try { recent = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]").slice(0, 5); } catch (e) {}
        var list = recent.filter(function (s) { return s.indexOf(q) !== -1; });
        if (list.length === 0) list = [q];
        tickerDropdown.innerHTML = list.map(function (s) {
          return "<button type=\"button\" data-ticker=\"" + s + "\">" + s + "</button>";
        }).join("");
        tickerDropdown.style.display = "block";
        tickerDropdown.querySelectorAll("button").forEach(function (b) {
          b.addEventListener("click", function () {
            txTicker.value = b.getAttribute("data-ticker");
            var p = state.prices[b.getAttribute("data-ticker")];
            if (p != null) txPrice.value = p;
            tickerDropdown.style.display = "none";
          });
        });
      }, 200);
    });
    if (txTicker) txTicker.addEventListener("blur", function () {
      setTimeout(function () { if (tickerDropdown) tickerDropdown.style.display = "none"; }, 150);
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
        assetPanel.setAttribute("aria-hidden", "true");
      });
      var closeBtn = assetPanel.querySelector(".asset-panel-close");
      if (closeBtn) closeBtn.addEventListener("click", function () { assetPanel.setAttribute("aria-hidden", "true"); });
    }

    document.getElementById("btn-settings").addEventListener("click", function () {
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "false");
      var btnVal = document.getElementById("settings-values-btn");
      if (btnVal) btnVal.textContent = state.valuesHidden ? "On" : "Off";
      createIcons();
    });
    document.getElementById("settings-drawer").querySelector(".settings-backdrop").addEventListener("click", function () {
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
    });
    document.getElementById("settings-drawer").querySelector(".settings-close").addEventListener("click", function () {
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
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
    document.getElementById("settings-import-csv").addEventListener("click", function () {
      document.getElementById("settings-drawer").setAttribute("aria-hidden", "true");
      document.getElementById("import-modal").setAttribute("aria-hidden", "false");
      document.getElementById("import-file").value = "";
      document.getElementById("import-result").textContent = "";
    });

    document.getElementById("import-modal").querySelector(".modal-backdrop").addEventListener("click", function () {
      document.getElementById("import-modal").setAttribute("aria-hidden", "true");
    });
    document.getElementById("import-modal").querySelector(".import-close").addEventListener("click", function () {
      document.getElementById("import-modal").setAttribute("aria-hidden", "true");
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
        document.getElementById("import-modal").setAttribute("aria-hidden", "true");
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
    if (searchInput) searchInput.addEventListener("input", function () {
      var q = this.value.trim();
      var dropdown = document.getElementById("header-search-dropdown");
      if (q.length < 1) {
        var recent = [];
        try { recent = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]").slice(0, 5); } catch (e) {}
        if (recent.length === 0) { dropdown.innerHTML = ""; dropdown.setAttribute("aria-hidden", "true"); return; }
        dropdown.innerHTML = "<div class=\"recent-label\">Recentes</div>" + recent.map(function (s) {
          return "<button type=\"button\" data-ticker=\"" + s + "\">" + s + "</button>";
        }).join("");
        dropdown.setAttribute("aria-hidden", "false");
        dropdown.querySelectorAll("button").forEach(function (b) {
          b.addEventListener("click", function () {
            var ticker = b.getAttribute("data-ticker");
            searchInput.value = "";
            dropdown.setAttribute("aria-hidden", "true");
            document.getElementById("asset-panel-title").textContent = ticker;
            document.getElementById("asset-panel-body").innerHTML = "<p>Preço: $" + (state.prices[ticker] || 0).toFixed(2) + "</p><p>Variação 24h: " + (state.changes[ticker] != null ? (state.changes[ticker] >= 0 ? "+" : "") + state.changes[ticker].toFixed(2) + "%" : "—") + "</p>";
            document.getElementById("asset-panel").setAttribute("aria-hidden", "false");
            createIcons();
          });
        });
        return;
      }
      dropdown.innerHTML = "<button type=\"button\" data-ticker=\"" + q.toUpperCase() + "\">" + q.toUpperCase() + "</button>";
      dropdown.setAttribute("aria-hidden", "false");
      dropdown.querySelector("button").addEventListener("click", function () {
        var ticker = this.getAttribute("data-ticker");
        try {
          var prev = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
          prev = [ticker].concat(prev.filter(function (x) { return x !== ticker; })).slice(0, 5);
          localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(prev));
        } catch (e) {}
        if (state.tickers.indexOf(ticker) === -1) {
          state.tickers.push(ticker);
          persist();
          refreshPrices();
        }
        searchInput.value = "";
        dropdown.setAttribute("aria-hidden", "true");
        document.getElementById("asset-panel-title").textContent = ticker;
        document.getElementById("asset-panel-body").innerHTML = "<p>Preço: $" + (state.prices[ticker] || 0).toFixed(2) + "</p>";
        document.getElementById("asset-panel").setAttribute("aria-hidden", "false");
        createIcons();
      });
    });
    if (searchInput) searchInput.addEventListener("blur", function () {
      setTimeout(function () { document.getElementById("header-search-dropdown").setAttribute("aria-hidden", "true"); }, 200);
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
      document.getElementById("share-modal").setAttribute("aria-hidden", "true");
    });
    document.querySelector(".share-modal-close").addEventListener("click", function () {
      document.getElementById("share-modal").setAttribute("aria-hidden", "true");
    });
    document.getElementById("share-download-png").addEventListener("click", function () {
      shareDownloadPng();
    });

    var wlList = document.getElementById("watchlist-list");
    if (wlList) wlList.addEventListener("click", function (e) {
      var li = e.target.closest("li[data-ticker]");
      if (!li) return;
      var ticker = li.getAttribute("data-ticker");
      document.getElementById("asset-panel-title").textContent = ticker;
      document.getElementById("asset-panel-body").innerHTML = "<p>Preço: $" + (state.prices[ticker] || 0).toFixed(2) + "</p><p>Variação: " + (state.changes[ticker] != null ? (state.changes[ticker] >= 0 ? "+" : "") + state.changes[ticker].toFixed(2) + "%" : "—") + "</p>";
      document.getElementById("asset-panel").setAttribute("aria-hidden", "false");
      createIcons();
    });

    setInterval(refreshPrices, 60000);
    createIcons();
  });
})();
