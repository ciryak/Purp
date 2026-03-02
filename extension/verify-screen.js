// ════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION SCREEN — Purp Extension
// ════════════════════════════════════════════════════════════════

/**
 * Constrói o HTML da tela de verificação
 */
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
  el.style.cssText = 'position:fixed;inset:0;background:#0a0914;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;z-index:9999;font-family:sans-serif;';
  el.innerHTML = `
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-60%);width:280px;height:280px;background:radial-gradient(circle,rgba(124,58,237,.16) 0%,transparent 70%);pointer-events:none;"></div>
    <div style="width:60px;height:60px;background:linear-gradient(135deg,#7c3aed,#a78bfa);border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:26px;margin-bottom:18px;box-shadow:0 8px 28px rgba(124,58,237,.4);">🔐</div>
    <h2 style="color:#f1f0f5;font-size:17px;font-weight:800;margin:0 0 6px;text-align:center;">Verify your email</h2>
    <p style="color:rgba(241,240,245,.4);font-size:11px;margin:0 0 22px;text-align:center;line-height:1.55;">
      We sent a 6-digit code to<br>
      <span style="color:#a78bfa;font-weight:700;">${masked}</span>
    </p>
    <div id="vfy-inputs" style="display:flex;gap:7px;margin-bottom:16px;">
      ${[0, 1, 2, 3, 4, 5].map(i => `<input id="vd${i}" type="text" inputmode="numeric" maxlength="1" style="width:38px;height:46px;background:rgba(124,58,237,.1);border:2px solid rgba(124,58,237,.28);border-radius:9px;color:#fff;font-size:20px;font-weight:900;text-align:center;outline:none;font-family:monospace;caret-color:transparent;transition:border-color .15s,background .15s;">`).join('')}
    </div>
    <div id="vfy-error" style="color:#f87171;font-size:11px;min-height:15px;margin:0 0 10px;text-align:center;display:none;"></div>
    <button id="vfy-btn" style="width:100%;max-width:232px;padding:11px;background:linear-gradient(135deg,#7c3aed,#a78bfa);border:none;border-radius:11px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(124,58,237,.35);margin-bottom:12px;">
      Verify account
    </button>
    <div style="text-align:center;">
      <span style="color:rgba(241,240,245,.3);font-size:11px;">Didn't receive it? </span>
      <button id="vfy-resend-btn" style="background:none;border:none;color:#a78bfa;font-size:11px;font-weight:700;cursor:pointer;padding:0;">Resend code</button>
      <span id="vfy-countdown" style="color:rgba(241,240,245,.25);font-size:11px;display:none;"></span>
    </div>
    <button id="vfy-back" style="background:none;border:none;color:rgba(241,240,245,.2);font-size:10px;cursor:pointer;margin-top:14px;padding:0;">← Use a different account</button>`;
  return el;
}

let _vfyToken = null;
let _vfyTimer = null;

/**
 * Exibe a tela de verificação e gerencia a lógica de entrada/envio
 */
function showVerifyScreen(token, email, onSuccess) {
  _vfyToken = token;
  const existing = document.getElementById('verify-screen');
  if (existing) existing.remove();

  const screen = buildVerifyScreen(email);
  document.body.appendChild(screen);

  // Focus no primeiro dígito
  setTimeout(() => document.getElementById('vd0')?.focus(), 100);

  function getCode() {
    return [0, 1, 2, 3, 4, 5].map(i => document.getElementById(`vd${i}`)?.value || '').join('');
  }

  function showVfyError(msg) {
    const el = document.getElementById('vfy-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function clearVfyError() {
    const el = document.getElementById('vfy-error');
    if (el) el.style.display = 'none';
  }

  function shakeInputs() {
    const c = document.getElementById('vfy-inputs');
    if (!c) return;
    c.style.animation = 'vfyShake .32s ease';
    c.addEventListener('animationend', () => { c.style.animation = ''; }, { once: true });

    [0, 1, 2, 3, 4, 5].forEach(i => {
      const el = document.getElementById(`vd${i}`);
      if (el) {
        el.style.borderColor = '#f87171';
        el.style.background = 'rgba(248,113,113,.1)';
      }
    });
    setTimeout(() => {
      [0, 1, 2, 3, 4, 5].forEach(i => {
        const el = document.getElementById(`vd${i}`);
        if (el) {
          el.style.borderColor = 'rgba(124,58,237,.28)';
          el.style.background = 'rgba(124,58,237,.1)';
        }
      });
    }, 900);
  }

  // Injeta animação de erro
  if (!document.getElementById('vfy-shake-style')) {
    const s = document.createElement('style');
    s.id = 'vfy-shake-style';
    s.textContent = `@keyframes vfyShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}`;
    document.head.appendChild(s);
  }

  // Handlers de Input (Lógica de digitação automática)
  [0, 1, 2, 3, 4, 5].forEach(i => {
    const el = document.getElementById(`vd${i}`);
    if (!el) return;

    el.addEventListener('focus', () => {
      el.style.borderColor = '#a78bfa';
      el.style.background = 'rgba(124,58,237,.18)';
    });

    el.addEventListener('input', e => {
      const val = e.target.value.replace(/\D/g, '');
      el.value = val ? val[0] : '';
      if (val && i < 5) document.getElementById(`vd${i + 1}`)?.focus();
      clearVfyError();
      if (getCode().length === 6) setTimeout(submitCode, 100);
    });

    el.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !el.value && i > 0) {
        document.getElementById(`vd${i - 1}`)?.focus();
      }
      if (e.key === 'Enter') submitCode();
    });

    el.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      text.split('').forEach((ch, idx) => {
        const d = document.getElementById(`vd${idx}`);
        if (d) d.value = ch;
      });
      if (text.length > 0) document.getElementById(`vd${Math.min(text.length, 5)}`)?.focus();
      if (text.length === 6) setTimeout(submitCode, 100);
    });
  });

  /**
   * Envia o código para o Backend
   */
  async function submitCode() {
    const code = getCode();
    if (code.length !== 6) { showVfyError('Enter all 6 digits'); return; }

    const btn = document.getElementById('vfy-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

    try {
      const res = await fetch(`${API_BASE}/auth/verify-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${_vfyToken}`
        },
        // CORREÇÃO: O seu Backend espera VerifyEmailInput (email e code)
        body: JSON.stringify({ email: email, code: code }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        // Sucesso
        [0, 1, 2, 3, 4, 5].forEach(i => {
          const el = document.getElementById(`vd${i}`);
          if (el) { el.style.borderColor = '#4ade80'; el.style.background = 'rgba(74,222,128,.12)'; }
        });
        if (btn) {
          btn.textContent = '✓ Verified!';
          btn.style.background = 'linear-gradient(135deg,#16a34a,#4ade80)';
        }

        setTimeout(() => {
          const screen = document.getElementById('verify-screen');
          if (screen) screen.remove();
          if (_vfyTimer) clearInterval(_vfyTimer);
          // Passa o token novo junto com o user para o callback
          onSuccess(data.user || {}, data.token || null);
        }, 800);
      } else {
        showVfyError(data.detail || 'Invalid code. Try again.');
        shakeInputs();
        if (btn) { btn.disabled = false; btn.textContent = 'Verify account'; }
      }
    } catch (err) {
      showVfyError('Network error. Check your connection.');
      if (btn) { btn.disabled = false; btn.textContent = 'Verify account'; }
    }
  }

  document.getElementById('vfy-btn')?.addEventListener('click', submitCode);

  /**
   * Reenvio de Código
   */
  document.getElementById('vfy-resend-btn')?.addEventListener('click', async () => {
    const resendBtn = document.getElementById('vfy-resend-btn');
    const countdown = document.getElementById('vfy-countdown');

    try {
      if (resendBtn) resendBtn.style.display = 'none';
      if (countdown) { countdown.style.display = 'inline'; countdown.textContent = 'Sending…'; }

      const res = await fetch(`${API_BASE}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_vfyToken}` },
      });

      if (!res.ok) {
        const err = await res.json();
        if (countdown) countdown.textContent = err.detail || 'Wait a moment.';
        setTimeout(() => {
          if (resendBtn) resendBtn.style.display = 'inline';
          if (countdown) countdown.style.display = 'none';
        }, 3000);
        return;
      }

      // Timer de Reenvio (1 minuto)
      let secs = 60;
      if (_vfyTimer) clearInterval(_vfyTimer);
      _vfyTimer = setInterval(() => {
        secs--;
        if (countdown) countdown.textContent = `Resend in ${secs}s`;
        if (secs <= 0) {
          clearInterval(_vfyTimer);
          if (resendBtn) { resendBtn.style.display = 'inline'; resendBtn.textContent = 'Resend code'; }
          if (countdown) countdown.style.display = 'none';
        }
      }, 1000);

    } catch (err) {
      if (resendBtn) resendBtn.style.display = 'inline';
      if (countdown) countdown.style.display = 'none';
    }
  });

  /**
   * Botão de voltar
   */
  document.getElementById('vfy-back')?.addEventListener('click', () => {
    const screen = document.getElementById('verify-screen');
    if (screen) screen.remove();
    if (_vfyTimer) clearInterval(_vfyTimer);
    
    // Funções globais definidas no seu popup.js
    if (typeof clearSession === 'function') clearSession();
    if (typeof showLoginScreen === 'function') showLoginScreen();
  });
}