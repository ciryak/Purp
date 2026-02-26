const SESSION = {
  token: localStorage.getItem('auth_token') || null,
  user: (() => { try { return JSON.parse(localStorage.getItem('purp_user') || 'null'); } catch { return null; } })(),
};

const API_BASE = '';
const currentPlan = SESSION.user?.plan || 'free';
const isPremium = ['investor', 'tax_pro'].includes(currentPlan);
const isTaxPro = currentPlan === 'tax_pro';

const btn = document.getElementById('btn-hamburger-shell');
const drawer = document.getElementById('shell-drawer');
const overlay = document.getElementById('shell-overlay');
const toggle = (open) => {
  drawer?.classList.toggle('open', open);
  overlay?.classList.toggle('show', open);
};
btn?.addEventListener('click', () => toggle(!drawer.classList.contains('open')));
overlay?.addEventListener('click', () => toggle(false));

function ensureAuth() {
  if (!SESSION.token) {
    window.location.href = '/';
  }
}

function showPlanBadge() {
  const badge = document.getElementById('shell-plan-badge');
  if (!badge) return;
  const pretty = currentPlan === 'tax_pro' ? 'Tax Pro' : currentPlan === 'investor' ? 'Investor' : 'Free';
  badge.textContent = `Plan: ${pretty}`;
}

function mountGateModal() {
  if (document.getElementById('feature-gate-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'feature-gate-modal';
  modal.className = 'gate-modal hidden'; modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;place-items:center;z-index:1000;padding:16px;';
  modal.innerHTML = `
    <div class="gate-card" style="width:min(100%,420px);background:#110f20;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:16px;color:#f5f4ff;">
      <h3 id="gate-title">Upgrade required</h3>
      <p id="gate-msg">This feature requires a paid plan.</p>
      <div class="gate-actions" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="gate-close" class="btn ghost" type="button" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#d9d6e8;">Maybe later</button>
        <button id="gate-upgrade" class="btn primary" type="button" style="padding:10px;border-radius:10px;border:0;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-weight:700;">Upgrade now</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); modal.style.display='none'; });
  document.getElementById('gate-close')?.addEventListener('click', () => { modal.classList.add('hidden'); modal.style.display='none'; });
  document.getElementById('gate-upgrade')?.addEventListener('click', () => {
    const target = modal.dataset.plan || 'investor';
    createCheckout(target);
  });
}

async function createCheckout(plan) {
  if (!SESSION.token) return;
  try {
    const res = await fetch(`${API_BASE}/stripe/create-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': SESSION.token,
        'Authorization': `Bearer ${SESSION.token}`,
      },
      body: JSON.stringify({ plan })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.url) window.location.href = data.url;
    else alert(data.detail || 'Unable to open checkout right now.');
  } catch {
    alert('Connection error while opening checkout.');
  }
}

function gateMessage(plan) {
  if (plan === 'tax_pro') return 'This feature requires the Tax Pro plan.';
  return 'This feature requires Investor or Tax Pro.';
}

function bindFeatureGates() {
  mountGateModal();
  document.querySelectorAll('[data-requires-plan]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const required = el.getAttribute('data-requires-plan');
      const allowed = required === 'tax_pro' ? isTaxPro : isPremium;
      if (allowed) return;
      e.preventDefault();
      const modal = document.getElementById('feature-gate-modal');
      modal.dataset.plan = required === 'tax_pro' ? 'tax_pro' : 'investor';
      document.getElementById('gate-title').textContent = required === 'tax_pro' ? 'Tax Pro required' : 'Premium required';
      document.getElementById('gate-msg').textContent = gateMessage(required);
      modal.classList.remove('hidden'); modal.style.display='grid';
    });
  });
}

function bindPlanButtons() {
  document.querySelectorAll('[data-checkout-plan]').forEach((btn) => {
    btn.addEventListener('click', () => createCheckout(btn.getAttribute('data-checkout-plan')));
  });
}

ensureAuth();
showPlanBadge();
bindFeatureGates();
bindPlanButtons();
