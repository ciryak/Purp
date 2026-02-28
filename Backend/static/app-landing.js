(function () {
  "use strict";

  var AUTH_CONFIG = {
    get API_BASE() {
      if (typeof window === "undefined") return "https://purp-production.up.railway.app";
      var o = window.location.origin;
      if (o.startsWith("http://localhost") || o.startsWith("http://127.0.0.1")) return "";
      return "https://purp-production.up.railway.app";
    },
    ENDPOINTS: {
      register: "/auth/register",
      login: "/auth/login",
      me: "/auth/me",
      resend: "/auth/resend-verification",
      forgot: "/auth/forgot-password",
      reset: "/auth/reset-password",
      verify: "/auth/verify-email",
    },
    STORAGE_TOKEN: "auth_token",
    STORAGE_USER: "purp_user",
    MIN_NAME: 2,
    STRIPE: {
      INVESTOR: "https://buy.stripe.com/7sYfZj2ozh2z0Je4tf8og02",
      TAX_PRO: "https://buy.stripe.com/00wfZjfblh2z63ye3P8og03",
    },
    PASSWORD_REQUIREMENTS: [
      { id: "len", label: "Mínimo 8 caracteres", test: function (p) { return p.length >= 8; } },
      { id: "upper", label: "Uma letra maiúscula", test: function (p) { return /[A-Z]/.test(p); } },
      { id: "lower", label: "Uma letra minúscula", test: function (p) { return /[a-z]/.test(p); } },
      { id: "number", label: "Um número", test: function (p) { return /\d/.test(p); } },
      { id: "special", label: "Um caractere especial (!@#$%^&* etc.)", test: function (p) { return /[!@#$%^&*()_+\-=[\]{}|;':",./<>?`~]/.test(p); } },
    ],
    CRYPTO_LIST: [
      { id: "bitcoin", sym: "BTC", icon: "₿", color: "#f7931a", bg: "rgba(247,147,26,0.18)" },
      { id: "ethereum", sym: "ETH", icon: "Ξ", color: "#627eea", bg: "rgba(98,126,234,0.18)" },
      { id: "solana", sym: "SOL", icon: "◎", color: "#9945ff", bg: "rgba(153,69,255,0.18)" },
      { id: "binancecoin", sym: "BNB", icon: "B", color: "#f3ba2f", bg: "rgba(243,186,47,0.18)" },
      { id: "ripple", sym: "XRP", icon: "✕", color: "#00aae4", bg: "rgba(0,170,228,0.18)" },
      { id: "cardano", sym: "ADA", icon: "₳", color: "#3cc8c8", bg: "rgba(60,200,200,0.18)" },
      { id: "dogecoin", sym: "DOGE", icon: "Ð", color: "#c2a633", bg: "rgba(194,166,51,0.18)" },
      { id: "avalanche-2", sym: "AVAX", icon: "A", color: "#e84142", bg: "rgba(232,65,66,0.18)" },
      { id: "chainlink", sym: "LINK", icon: "⬡", color: "#2a5ada", bg: "rgba(42,90,218,0.18)" },
      { id: "polkadot", sym: "DOT", icon: "●", color: "#e6007a", bg: "rgba(230,0,122,0.18)" },
    ],
    STOCK_LIST: [
      { sym: "AAPL", color: "#a8b0be", bg: "rgba(168,176,190,0.15)" },
      { sym: "TSLA", color: "#e31937", bg: "rgba(227,25,55,0.15)" },
      { sym: "NVDA", color: "#76b900", bg: "rgba(118,185,0,0.15)" },
      { sym: "MSFT", color: "#00a4ef", bg: "rgba(0,164,239,0.15)" },
      { sym: "AMZN", color: "#ff9900", bg: "rgba(255,153,0,0.15)" },
      { sym: "GOOGL", color: "#4285f4", bg: "rgba(66,133,244,0.15)" },
      { sym: "META", color: "#0082fb", bg: "rgba(0,130,251,0.15)" },
      { sym: "JPM", color: "#005eb8", bg: "rgba(0,94,184,0.18)" },
      { sym: "V", color: "#7673c0", bg: "rgba(118,115,192,0.18)" },
    ],
    FALLBACK_PRICES: { BTC: 96400, ETH: 2650, SOL: 178, BNB: 605, XRP: 2.58, ADA: 0.82, DOGE: 0.21, AVAX: 29, LINK: 16, DOT: 7.2, AAPL: 228, TSLA: 365, NVDA: 131, MSFT: 420, AMZN: 225, GOOGL: 182, META: 710, JPM: 280, V: 362 },
  };

  function apiUrl(key) {
    return AUTH_CONFIG.API_BASE + AUTH_CONFIG.ENDPOINTS[key];
  }
  function authHeaders(token) {
    return {
      "Content-Type": "application/json",
      "X-Auth-Token": (token || ""),
    };
  }
  function isValidEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }
  function getPasswordStrength(pw) {
    var met = AUTH_CONFIG.PASSWORD_REQUIREMENTS.map(function (r) {
      return { id: r.id, label: r.label, met: r.test(pw || "") };
    });
    return { met: met, score: met.filter(function (m) { return m.met; }).length };
  }

  function getStoredUser() {
    try {
      var raw = localStorage.getItem(AUTH_CONFIG.STORAGE_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function saveSession(token, user) {
    localStorage.setItem(AUTH_CONFIG.STORAGE_TOKEN, token);
    localStorage.setItem(AUTH_CONFIG.STORAGE_USER, JSON.stringify(user));
  }
  function isLoggedIn() {
    return !!localStorage.getItem(AUTH_CONFIG.STORAGE_TOKEN);
  }
  function displayName() {
    var u = getStoredUser();
    if (u && (u.full_name || u.first_name)) return (u.full_name || (u.first_name + " " + (u.last_name || "")).trim()) || u.email || "User";
    return "User";
  }

  function createIcons() {
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  }

  // ---------- Ticker ----------
  function fmtPrice(p) {
    if (!p || isNaN(p)) return "—";
    if (p >= 10000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (p >= 100) return "$" + p.toFixed(2);
    if (p >= 1) return "$" + p.toFixed(3);
    return "$" + p.toFixed(5);
  }
  function fmtPct(pct) {
    if (isNaN(pct)) return "0.00%";
    return (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
  }
  function tickerFetch() {
    var data = {};
    var cryptoIds = AUTH_CONFIG.CRYPTO_LIST.map(function (c) { return c.id; }).join(",");
    return fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + cryptoIds + "&vs_currencies=usd&include_24hr_change=true")
      .then(function (res) { return res.json(); })
      .then(function (json) {
        AUTH_CONFIG.CRYPTO_LIST.forEach(function (c) {
          var d = json[c.id];
          if (d) data[c.sym] = { price: d.usd, changePercent: d.usd_24h_change != null ? d.usd_24h_change : 0 };
        });
      })
      .catch(function () {})
      .then(function () {
        return Promise.all(AUTH_CONFIG.STOCK_LIST.map(function (s) {
          var base = AUTH_CONFIG.API_BASE || "";
          return fetch(base + "/api/proxy/yahoo-chart?symbol=" + encodeURIComponent(s.sym))
            .then(function (res) { return res.json(); })
            .then(function (json) {
              var meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
              if (meta) {
                var price = meta.regularMarketPrice;
                var prev = meta.chartPreviousClose || meta.previousClose;
                data[s.sym] = { price: price, changePercent: prev ? ((price - prev) / prev) * 100 : 0 };
              }
            })
            .catch(function () {});
        }));
      })
      .then(function () {
        var all = AUTH_CONFIG.CRYPTO_LIST.concat(AUTH_CONFIG.STOCK_LIST);
        return all.map(function (item) {
          var d = data[item.sym];
          var fb = AUTH_CONFIG.FALLBACK_PRICES[item.sym] || 0;
          return {
            sym: item.sym,
            icon: item.icon != null ? item.icon : item.sym.slice(0, 3),
            color: item.color,
            bg: item.bg,
            price: d && d.price != null ? d.price : fb,
            changePercent: d && d.changePercent != null ? d.changePercent : (Math.random() * 6 - 3),
          };
        });
      });
  }
  function tickerRender(items) {
    var track = document.getElementById("ticker-track");
    var shimmer = document.getElementById("ticker-shimmer");
    if (!track) return;
    if (!items || items.length === 0) return;
    shimmer.style.display = "none";
    var tripled = items.concat(items).concat(items);
    track.innerHTML = tripled.map(function (item, i) {
      var dir = item.changePercent > 0.04 ? "up" : item.changePercent < -0.04 ? "down" : "flat";
      var arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "—";
      return (
        '<div class="ticker-item">' +
          '<div class="ticker-icon" style="background:' + item.bg + ";color:" + item.color + '">' + (item.icon || item.sym) + "</div>" +
          '<span class="ticker-symbol">' + item.sym + "</span>" +
          '<span class="ticker-price">' + fmtPrice(item.price) + "</span>" +
          '<span class="ticker-change ' + dir + '">' + arrow + " " + fmtPct(item.changePercent) + "</span>" +
        "</div>"
      );
    }).join("");
    var thirdWidth = track.scrollWidth / 3;
    var pos = 0;
    var speed = 0.5;
    var dragging = false;
    var startX = 0, startPos = 0;
    function animate() {
      if (!dragging) {
        pos -= speed;
        if (Math.abs(pos) >= thirdWidth) pos += thirdWidth;
        track.style.transform = "translateX(" + pos + "px)";
      }
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
    var outer = track.parentElement;
    if (outer) {
      outer.addEventListener("mousedown", function (e) {
        dragging = true;
        startX = e.clientX;
        startPos = pos;
      });
      window.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        pos = startPos + (e.clientX - startX);
        track.style.transform = "translateX(" + pos + "px)";
      });
      window.addEventListener("mouseup", function () { dragging = false; });
    }
  }
  tickerFetch().then(function (items) {
    tickerRender(items);
  });

  // ---------- Auth modal ----------
  var authModal = document.getElementById("auth-modal");
  var authContent = document.getElementById("auth-modal-content");
  var authMode = "signin";
  var verifyModal = document.getElementById("verify-modal");
  var verifyMaskedEl = document.getElementById("verify-masked-email");
  var verifyInputs = document.getElementById("verify-inputs");
  var verifyError = document.getElementById("verify-error");
  var verifyResend = document.getElementById("verify-resend");
  var verifyCooldownEl = document.getElementById("verify-cooldown");
  var verifyEmail = "";
  var verifyResendCooldown = 0;
  var resetToken = null;

  function openAuth(mode) {
    authMode = mode || "signin";
    if (window.location.search) {
      var params = new URLSearchParams(window.location.search);
      if (params.get("reset")) resetToken = params.get("reset");
      if (params.get("token")) resetToken = params.get("token");
      if (resetToken) authMode = "reset";
    }
    renderAuthForm();
    if (authModal) {
      authModal.classList.add("open");
      authModal.setAttribute("aria-hidden", "false");
    }
    createIcons();
  }
  function closeAuth() {
    if (authModal) {
      authModal.classList.remove("open");
      authModal.setAttribute("aria-hidden", "true");
    }
  }
  function openVerify(email) {
    verifyEmail = email;
    var masked = email ? email.replace(/(.{2})(.*)(@.*)/, function (_, a, b, c) { return a + "*".repeat(Math.max(b.length, 2)) + c; }) : "";
    if (verifyMaskedEl) verifyMaskedEl.textContent = masked;
    if (verifyInputs) {
      verifyInputs.querySelectorAll("input").forEach(function (inp) { inp.value = ""; });
      verifyInputs.querySelectorAll("input")[0].focus();
    }
    if (verifyError) { verifyError.style.display = "none"; verifyError.textContent = ""; }
    if (verifyModal) {
      verifyModal.classList.add("open");
      verifyModal.setAttribute("aria-hidden", "false");
    }
  }
  function closeVerify() {
    if (verifyModal) {
      verifyModal.classList.remove("open");
      verifyModal.setAttribute("aria-hidden", "true");
    }
  }

  function renderAuthForm() {
    if (!authContent) return;
    var mode = authMode;
    var html = "";
    var errEl = '<div id="auth-err" class="error-msg" style="display:none"><span>⚠</span><span id="auth-err-txt"></span></div>';

    if (mode === "signin") {
      html =
        '<div class="modal-header"><img src="icons/icon16.png" alt="" width="32" height="32" class="modal-mark-img" /><h2 class="modal-title">Welcome back</h2><p class="modal-sub">Sign in to your Purp account</p></div>' +
        '<div class="modal-form">' + errEl +
        '<div class="form-field"><label class="form-label" for="signin-email">Email</label><input class="form-input" type="email" id="signin-email" placeholder="you@email.com" autocomplete="email" /></div>' +
        '<div class="form-field"><label class="form-label" for="signin-password">Password</label><div class="input-with-toggle"><input class="form-input" type="password" id="signin-password" placeholder="••••••••" autocomplete="current-password" style="width:100%" /><button type="button" class="input-toggle-btn" id="signin-toggle-pw"><i data-lucide="eye" width="18" height="18"></i></button></div><p class="form-hint"><button type="button" class="link-forgot" id="auth-mode-forgot">Esqueci minha senha</button></p></div>' +
        '<button class="btn-modal-submit" id="auth-submit">Sign in to Purp</button>' +
        '</div><p class="modal-switch">No account? <button type="button" class="modal-link" id="auth-mode-register">Create one free</button></p>';
    } else if (mode === "register") {
      html =
        '<div class="modal-header"><img src="icons/icon16.png" alt="" width="32" height="32" class="modal-mark-img" /><h2 class="modal-title">Create account</h2><p class="modal-sub">Free forever. No credit card needed.</p></div>' +
        '<div class="modal-form">' + errEl +
        '<div class="name-fields-row"><div class="form-field"><label class="form-label" for="reg-first">First Name</label><input class="form-input" type="text" id="reg-first" placeholder="First name" autocomplete="given-name" /></div><div class="form-field"><label class="form-label" for="reg-last">Last Name</label><input class="form-input" type="text" id="reg-last" placeholder="Last name" autocomplete="family-name" /></div></div>' +
        '<div class="form-field"><label class="form-label" for="reg-email">Email</label><input class="form-input" type="email" id="reg-email" placeholder="you@email.com" autocomplete="email" /></div>' +
        '<div class="form-field"><label class="form-label" for="reg-password">Password</label><div class="input-with-toggle"><input class="form-input" type="password" id="reg-password" placeholder="Min. 8 chars, upper, lower, number & symbol" autocomplete="new-password" style="width:100%" /><button type="button" class="input-toggle-btn" id="reg-toggle-pw"><i data-lucide="eye" width="18" height="18"></i></button></div><div id="pw-strength-wrap"></div></div>' +
        '<button class="btn-modal-submit" id="auth-submit">Create free account</button>' +
        '</div><p class="modal-switch">Already have an account? <button type="button" class="modal-link" id="auth-mode-signin">Sign in</button></p>';
    } else if (mode === "forgot") {
      html =
        '<div class="modal-header"><img src="icons/icon16.png" alt="" width="32" height="32" class="modal-mark-img" /><h2 class="modal-title">Esqueci minha senha</h2><p class="modal-sub">Informe seu email e enviaremos um link para redefinir</p></div>' +
        '<div class="modal-form">' + errEl +
        '<div class="form-field"><label class="form-label" for="forgot-email">Email</label><input class="form-input" type="email" id="forgot-email" placeholder="you@email.com" autocomplete="email" /></div>' +
        '<button class="btn-modal-submit" id="auth-submit">Enviar link de redefinição</button>' +
        '</div><p class="modal-switch"><button type="button" class="modal-link" id="auth-mode-signin">Voltar ao login</button></p>';
    } else if (mode === "reset") {
      html =
        '<div class="modal-header"><img src="icons/icon16.png" alt="" width="32" height="32" class="modal-mark-img" /><h2 class="modal-title">Nova senha</h2><p class="modal-sub">Escolha uma senha forte. O link expira em 1 hora.</p></div>' +
        '<div class="modal-form">' + errEl +
        '<div class="form-field"><label class="form-label" for="reset-pw">Nova senha</label><div class="input-with-toggle"><input class="form-input" type="password" id="reset-pw" placeholder="Min. 8 chars, upper, lower, number & symbol" autocomplete="new-password" style="width:100%" /><button type="button" class="input-toggle-btn" id="reset-toggle-pw"><i data-lucide="eye" width="18" height="18"></i></button></div><div id="reset-pw-strength"></div></div>' +
        '<div class="form-field"><label class="form-label" for="reset-confirm">Confirmar senha</label><input class="form-input" type="password" id="reset-confirm" placeholder="Repita a nova senha" autocomplete="new-password" /></div>' +
        '<button class="btn-modal-submit" id="auth-submit">Redefinir senha</button>' +
        '</div><p class="modal-switch"><button type="button" class="modal-link" id="auth-mode-signin">Voltar ao login</button></p>';
    }
    authContent.innerHTML = html;
    createIcons();

    function showErr(msg) {
      var el = document.getElementById("auth-err");
      var txt = document.getElementById("auth-err-txt");
      if (el && txt) { el.style.display = "flex"; txt.textContent = msg || ""; }
    }
    function hideErr() {
      var el = document.getElementById("auth-err");
      if (el) el.style.display = "none";
    }

    document.getElementById("auth-mode-register") && document.getElementById("auth-mode-register").addEventListener("click", function () { authMode = "register"; hideErr(); renderAuthForm(); });
    document.getElementById("auth-mode-signin") && document.getElementById("auth-mode-signin").addEventListener("click", function () { authMode = "signin"; resetToken = null; hideErr(); renderAuthForm(); });
    document.getElementById("auth-mode-forgot") && document.getElementById("auth-mode-forgot").addEventListener("click", function () { authMode = "forgot"; hideErr(); renderAuthForm(); });

    var signinToggle = document.getElementById("signin-toggle-pw");
    if (signinToggle) {
      signinToggle.addEventListener("click", function () {
        var inp = document.getElementById("signin-password");
        if (!inp) return;
        var isPass = inp.type === "password";
        inp.type = isPass ? "text" : "password";
        signinToggle.innerHTML = isPass ? '<i data-lucide="eye-off" width="18" height="18"></i>' : '<i data-lucide="eye" width="18" height="18"></i>';
        createIcons();
      });
    }
    var regToggle = document.getElementById("reg-toggle-pw");
    if (regToggle) {
      regToggle.addEventListener("click", function () {
        var inp = document.getElementById("reg-password");
        if (!inp) return;
        var isPass = inp.type === "password";
        inp.type = isPass ? "text" : "password";
        regToggle.innerHTML = isPass ? '<i data-lucide="eye-off" width="18" height="18"></i>' : '<i data-lucide="eye" width="18" height="18"></i>';
        createIcons();
      });
    }
    var regPw = document.getElementById("reg-password");
    if (regPw) {
      regPw.addEventListener("input", function () {
        var wrap = document.getElementById("pw-strength-wrap");
        if (!wrap) return;
        var s = getPasswordStrength(regPw.value);
        wrap.innerHTML = '<div class="password-strength-wrap"><div class="password-strength-bar"><div class="password-strength-bar-fill w' + s.score + '"></div></div><ul class="password-requirements">' +
          s.met.map(function (r) { return '<li class="password-requirement ' + (r.met ? "met" : "") + '"><span class="icon">' + (r.met ? "✓" : "○") + "</span><span>" + r.label + "</span></li>"; }).join("") + "</ul></div>";
      });
    }
    var resetToggle = document.getElementById("reset-toggle-pw");
    if (resetToggle) {
      resetToggle.addEventListener("click", function () {
        var inp = document.getElementById("reset-pw");
        if (!inp) return;
        var isPass = inp.type === "password";
        inp.type = isPass ? "text" : "password";
        resetToggle.innerHTML = isPass ? '<i data-lucide="eye-off" width="18" height="18"></i>' : '<i data-lucide="eye" width="18" height="18"></i>';
        createIcons();
      });
    }
    var resetPwEl = document.getElementById("reset-pw");
    if (resetPwEl) {
      resetPwEl.addEventListener("input", function () {
        var wrap = document.getElementById("reset-pw-strength");
        if (!wrap) return;
        var s = getPasswordStrength(resetPwEl.value);
        wrap.innerHTML = '<div class="password-strength-wrap"><div class="password-strength-bar"><div class="password-strength-bar-fill w' + s.score + '"></div></div><ul class="password-requirements">' +
          s.met.map(function (r) { return '<li class="password-requirement ' + (r.met ? "met" : "") + '"><span class="icon">' + (r.met ? "✓" : "○") + "</span><span>" + r.label + "</span></li>"; }).join("") + "</ul></div>";
      });
    }

    document.getElementById("auth-submit") && document.getElementById("auth-submit").addEventListener("click", function () {
      var btn = document.getElementById("auth-submit");
      if (btn) btn.disabled = true;
      if (mode === "signin") {
        var email = (document.getElementById("signin-email") && document.getElementById("signin-email").value) || "";
        var password = (document.getElementById("signin-password") && document.getElementById("signin-password").value) || "";
        if (!isValidEmail(email)) { showErr("Email inválido"); if (btn) btn.disabled = false; return; }
        if (!password) { showErr("Senha obrigatória"); if (btn) btn.disabled = false; return; }
        fetch(apiUrl("login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email, password: password }) })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (r.ok) {
              closeAuth();
              saveSession(r.data.token, r.data.user);
              window.location.href = "/home";
            } else {
              if (r.data.detail && (r.data.detail.indexOf("not verified") !== -1 || r.data.detail.indexOf("verificado") !== -1)) {
                closeAuth();
                openVerify(email);
              } else showErr(r.data.detail || "Falha no login");
            }
          })
          .catch(function () { showErr("Erro de conexão"); })
          .then(function () { if (btn) btn.disabled = false; });
      } else if (mode === "register") {
        var first = (document.getElementById("reg-first") && document.getElementById("reg-first").value) || "";
        var last = (document.getElementById("reg-last") && document.getElementById("reg-last").value) || "";
        var email = (document.getElementById("reg-email") && document.getElementById("reg-email").value) || "";
        var password = (document.getElementById("reg-password") && document.getElementById("reg-password").value) || "";
        if (first.length < AUTH_CONFIG.MIN_NAME) { showErr("Nome deve ter pelo menos 2 caracteres"); if (btn) btn.disabled = false; return; }
        if (last.length < AUTH_CONFIG.MIN_NAME) { showErr("Sobrenome deve ter pelo menos 2 caracteres"); if (btn) btn.disabled = false; return; }
        if (!isValidEmail(email)) { showErr("Email inválido"); if (btn) btn.disabled = false; return; }
        if (getPasswordStrength(password).score < 5) { showErr("Senha não atende todos os requisitos"); if (btn) btn.disabled = false; return; }
        fetch(apiUrl("register"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ first_name: first, last_name: last, full_name: (first + " " + last).trim(), email: email, password: password }),
        })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (r.ok) {
              if (r.data.requires_verification || (r.data.message && r.data.message.indexOf("verif") !== -1)) {
                closeAuth();
                openVerify(email);
              } else {
                closeAuth();
                saveSession(r.data.token, r.data.user);
                window.location.href = "/home";
              }
            } else showErr(r.data.detail || "Falha no registro");
          })
          .catch(function () { showErr("Erro de conexão"); })
          .then(function () { if (btn) btn.disabled = false; });
      } else if (mode === "forgot") {
        var forgotEmail = (document.getElementById("forgot-email") && document.getElementById("forgot-email").value) || "";
        if (!isValidEmail(forgotEmail)) { showErr("Email inválido"); if (btn) btn.disabled = false; return; }
        fetch(apiUrl("forgot"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: forgotEmail }) })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (r.ok) { authMode = "signin"; renderAuthForm(); } else showErr(r.data.detail || "Erro ao enviar link");
          })
          .catch(function () { showErr("Erro de conexão"); })
          .then(function () { if (btn) btn.disabled = false; });
      } else if (mode === "reset") {
        var newPw = (document.getElementById("reset-pw") && document.getElementById("reset-pw").value) || "";
        var confirm = (document.getElementById("reset-confirm") && document.getElementById("reset-confirm").value) || "";
        if (getPasswordStrength(newPw).score < 5) { showErr("Senha não atende todos os requisitos"); if (btn) btn.disabled = false; return; }
        if (newPw !== confirm) { showErr("As senhas não coincidem"); if (btn) btn.disabled = false; return; }
        fetch(apiUrl("reset"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: resetToken, new_password: newPw }) })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (r.ok) { authMode = "signin"; resetToken = null; renderAuthForm(); } else showErr(r.data.detail || "Erro ao redefinir");
          })
          .catch(function () { showErr("Erro de conexão"); })
          .then(function () { if (btn) btn.disabled = false; });
      }
    });
  }

  authModal && authModal.querySelector(".modal-close") && authModal.querySelector(".modal-close").addEventListener("click", closeAuth);
  authModal && authModal.addEventListener("click", function (e) { if (e.target === authModal) closeAuth(); });

  // Verify modal
  var verifyDigits = verifyInputs ? verifyInputs.querySelectorAll(".verify-digit") : [];
  var verifyCode = [ "", "", "", "", "", "" ];
  if (verifyInputs) {
    verifyInputs.addEventListener("input", function (e) {
      var inp = e.target;
      if (!inp.classList.contains("verify-digit")) return;
      var idx = parseInt(inp.getAttribute("data-idx"), 10);
      var v = inp.value.replace(/\D/g, "").slice(-1);
      verifyCode[idx] = v;
      inp.value = v;
      if (v && idx < 5) verifyDigits[idx + 1].focus();
      if (verifyCode.every(Boolean)) {
        fetch(apiUrl("verify"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: verifyEmail, code: verifyCode.join("") }) })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (r.ok) {
              closeVerify();
              openAuth("signin");
            } else {
              if (verifyError) { verifyError.textContent = r.data.detail || "Código inválido"; verifyError.style.display = "flex"; }
              verifyCode = [ "", "", "", "", "", "" ];
              verifyDigits.forEach(function (d, i) { d.value = ""; if (i === 0) d.focus(); });
            }
          })
          .catch(function () { if (verifyError) { verifyError.textContent = "Erro de conexão"; verifyError.style.display = "flex"; } });
      }
    });
    verifyInputs.addEventListener("keydown", function (e) {
      var inp = e.target;
      if (!inp.classList.contains("verify-digit") || e.key !== "Backspace" || inp.value) return;
      var idx = parseInt(inp.getAttribute("data-idx"), 10);
      if (idx > 0) { verifyCode[idx] = ""; verifyDigits[idx - 1].focus(); }
    });
    verifyInputs.addEventListener("paste", function (e) {
      e.preventDefault();
      var text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      for (var i = 0; i < text.length; i++) verifyCode[i] = text[i];
      verifyDigits.forEach(function (d, i) { d.value = verifyCode[i] || ""; });
      if (text.length === 6) {
        fetch(apiUrl("verify"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: verifyEmail, code: text }) })
          .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
          .then(function (r) {
            if (r.ok) { closeVerify(); openAuth("signin"); }
            else { if (verifyError) { verifyError.textContent = r.data.detail || "Código inválido"; verifyError.style.display = "flex"; } verifyCode = [ "", "", "", "", "", "" ]; verifyDigits.forEach(function (d, i) { d.value = ""; }); }
          });
      } else if (verifyDigits[text.length]) verifyDigits[text.length].focus();
    });
  }
  verifyResend && verifyResend.addEventListener("click", function () {
    if (verifyResendCooldown > 0) return;
    verifyResendCooldown = 60;
    if (verifyCooldownEl) { verifyCooldownEl.style.display = "inline"; verifyCooldownEl.textContent = "Resend in 60s"; }
    var interval = setInterval(function () {
      verifyResendCooldown--;
      if (verifyCooldownEl) verifyCooldownEl.textContent = "Resend in " + verifyResendCooldown + "s";
      if (verifyResendCooldown <= 0) {
        clearInterval(interval);
        if (verifyCooldownEl) { verifyCooldownEl.style.display = "none"; verifyCooldownEl.textContent = ""; }
      }
    }, 1000);
    fetch(apiUrl("resend"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: verifyEmail }) }).catch(function () {});
  });
  verifyModal && verifyModal.querySelector(".verify-close") && verifyModal.querySelector(".verify-close").addEventListener("click", closeVerify);
  verifyModal && verifyModal.addEventListener("click", function (e) { if (e.target === verifyModal) closeVerify(); });

  // ---------- Nav ----------
  var nav = document.getElementById("nav");
  var hamburger = document.getElementById("hamburger");
  var drawerOverlay = document.getElementById("drawer-overlay");
  var mobileDrawer = document.getElementById("mobile-drawer");
  var navAuthBtns = document.getElementById("nav-auth-btns");
  var navUserBtn = document.getElementById("nav-user-btn");
  var navAvatarLetter = document.getElementById("nav-avatar-letter");
  var navUserName = document.getElementById("nav-user-name");
  var mobileDrawerCta = document.querySelector(".mobile-drawer-cta");
  var mobileNavDashboard = document.querySelector(".mobile-nav-dashboard");

  function setNavUser() {
    var loggedIn = isLoggedIn();
    if (navAuthBtns) navAuthBtns.style.display = loggedIn ? "none" : "";
    if (navUserBtn) navUserBtn.style.display = loggedIn ? "" : "none";
    if (navAvatarLetter) navAvatarLetter.textContent = (displayName() || "U").charAt(0).toUpperCase();
    if (navUserName) navUserName.textContent = displayName();
    if (mobileDrawerCta) mobileDrawerCta.style.display = loggedIn ? "none" : "";
    if (mobileNavDashboard) mobileNavDashboard.style.display = loggedIn ? "" : "none";
    var mobileSignin = document.querySelector(".mobile-nav-btn");
    if (mobileSignin) mobileSignin.style.display = loggedIn ? "none" : "";
  }
  setNavUser();

  window.addEventListener("scroll", function () {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 20);
  }, { passive: true });

  function closeDrawer() {
    if (hamburger) hamburger.classList.remove("open");
    if (hamburger) hamburger.setAttribute("aria-expanded", "false");
    if (drawerOverlay) drawerOverlay.classList.remove("active");
    if (mobileDrawer) mobileDrawer.classList.remove("open");
  }
  hamburger && hamburger.addEventListener("click", function () {
    var open = !hamburger.classList.contains("open");
    hamburger.classList.toggle("open", open);
    hamburger.setAttribute("aria-expanded", open ? "true" : "false");
    drawerOverlay.classList.toggle("active", open);
    mobileDrawer.classList.toggle("open", open);
  });
  drawerOverlay && drawerOverlay.addEventListener("click", closeDrawer);
  mobileDrawer && mobileDrawer.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", closeDrawer); });

  document.querySelectorAll("[data-auth]").forEach(function (el) {
    el.addEventListener("click", function () {
      var mode = el.getAttribute("data-auth");
      if (mode === "register" || mode === "signin") openAuth(mode);
      closeDrawer();
    });
  });
  document.querySelectorAll("[data-scroll]").forEach(function (el) {
    el.addEventListener("click", function () {
      var id = el.getAttribute("data-scroll");
      var target = document.getElementById(id);
      if (target) target.scrollIntoView({ behavior: "smooth" });
    });
  });
  navUserBtn && navUserBtn.addEventListener("click", function () { window.location.href = "/home"; });
  mobileNavDashboard && mobileNavDashboard.addEventListener("click", function () { closeDrawer(); window.location.href = "/home"; });

  document.querySelectorAll("[data-stripe]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (!isLoggedIn()) { e.preventDefault(); openAuth("register"); }
    });
  });

  // ---------- Stats ----------
  var statsSection = document.getElementById("stats");
  if (statsSection) {
    var statNums = statsSection.querySelectorAll(".stat-num");
    var statTargets = Array.prototype.map.call(statNums, function (n) {
      return { el: n, target: parseFloat(n.getAttribute("data-target")) || 0, format: n.getAttribute("data-format") || "int" };
    });
    var statsAnimated = false;
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting || statsAnimated) return;
        statsAnimated = true;
        statsSection.querySelectorAll(".reveal").forEach(function (r) { r.classList.add("visible"); });
        var start = performance.now();
        var duration = 2000;
        function step(now) {
          var progress = Math.min((now - start) / duration, 1);
          var eased = 1 - Math.pow(1 - progress, 3);
          statTargets.forEach(function (s, i) {
            var v = s.target * eased;
            if (s.format === "money") s.el.textContent = "$" + v.toFixed(1) + "M+";
            else if (s.format === "int") s.el.textContent = Math.round(v).toLocaleString("en-US") + "+";
            else if (s.format === "decimal") s.el.textContent = v.toFixed(1);
            else s.el.textContent = Math.round(v);
          });
          if (progress < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
      });
    }, { threshold: 0.3 });
    obs.observe(statsSection);
  }

  // ---------- Reveal ----------
  document.querySelectorAll(".reveal, .feature-card, .plan-card, .step-card, .review-card").forEach(function (el) {
    var o = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { if (entry.isIntersecting) entry.target.classList.add("visible"); });
    }, { threshold: 0.1 });
    o.observe(el);
  });

  // ---------- FAQ ----------
  document.querySelectorAll(".faq-item").forEach(function (item) {
    var btn = item.querySelector(".faq-q");
    if (btn) btn.addEventListener("click", function () { item.classList.toggle("open"); });
  });

  // ---------- Tax calc ----------
  var taxPortfolio = document.getElementById("tax-portfolio");
  var taxGains = document.getElementById("tax-gains");
  var taxBracket = document.getElementById("tax-bracket");
  var taxPortfolioOut = document.getElementById("tax-portfolio-out");
  var taxGainsOut = document.getElementById("tax-gains-out");
  var taxSaved = document.getElementById("tax-saved");
  var taxPayback = document.getElementById("tax-payback");
  function updateTax() {
    var portfolio = parseInt(taxPortfolio && taxPortfolio.value || 50000, 10);
    var gains = parseInt(taxGains && taxGains.value || 20000, 10);
    var bracket = parseFloat(taxBracket && taxBracket.value || 0.22, 10);
    if (taxPortfolioOut) taxPortfolioOut.textContent = "$" + portfolio.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (taxGainsOut) taxGainsOut.textContent = "$" + gains.toLocaleString("en-US", { maximumFractionDigits: 0 });
    var harvestablePercent = Math.min(0.3, (portfolio / 500000) * 0.35);
    var harvestable = gains * harvestablePercent;
    var saved = harvestable * bracket;
    var payback = saved > 0 ? Math.max(1, Math.ceil(29.99 / (saved / 12))) : 0;
    if (taxSaved) taxSaved.textContent = "$" + Math.round(saved).toLocaleString("en-US") + "/year";
    if (taxPayback) taxPayback.textContent = "Purp Tax Pro pays for itself in " + payback + " month" + (payback !== 1 ? "s" : "");
  }
  if (taxPortfolio) taxPortfolio.addEventListener("input", updateTax);
  if (taxGains) taxGains.addEventListener("input", updateTax);
  if (taxBracket) taxBracket.addEventListener("change", updateTax);
  updateTax();

  // ---------- Init Lucide ----------
  createIcons();
})();
