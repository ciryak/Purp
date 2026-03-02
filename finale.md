# Cursor Prompt — Purp Extension: Correções para Publicação na Chrome Web Store

## Contexto

Extensão Chrome chamada **Purp** (AI Portfolio Tracker). Stack: Manifest V3, vanilla JS, Chart.js, Sentry.
Backend em Railway (`https://purp-production.up.railway.app`). Site público: `https://getpurpai.com`.
Os arquivos a editar estão em `extension/`.

---

## Problemas a Corrigir (em ordem de prioridade)

---

### 1. `extension/manifest.json` — CSP bloqueia Google Fonts (ERRO CRÍTICO)

O `popup.html` carrega fontes de `fonts.googleapis.com` e `fonts.gstatic.com`, mas a
`content_security_policy` do manifest não permite essas origens. Isso faz o popup
carregar sem a fonte correta em ambiente empacotado.

**Ação:** Adicionar `font-src` e `style-src` à CSP, e adicionar `fonts.googleapis.com` e
`fonts.gstatic.com` em `connect-src`. O manifest deve ficar assim:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://*.sentry.io https://purp-production.up.railway.app https://fonts.googleapis.com; img-src 'self' https: data:"
}
```

---

### 2. `extension/popup.js` — Sentry DSN hardcoded como placeholder (ERRO CRÍTICO)

Na linha com `Sentry.init`, o valor `dsn: "SENTRY_DSN"` é uma string literal inválida.
Com um DSN inválido, o Sentry lança exceção silenciosa que pode interferir no boot do popup.

**Ação:** Substituir o bloco Sentry.init para ser seguro mesmo sem DSN configurado:

```js
// Sentry — só inicializa se o DSN real estiver definido
const SENTRY_DSN = ""; // Cole aqui seu DSN real: https://sentry.io → Project → DSN
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 0.2,
  });
}
```

Se você tiver o DSN real do seu projeto Sentry, cole-o na string `SENTRY_DSN`.

---

### 3. `extension/popup.html` — Modal de Net Worth ausente no HTML (ERRO FUNCIONAL)

O `popup.js` referencia os seguintes IDs que **não existem** em `popup.html`:
- `modal-net-worth`
- `nw-category`, `nw-label`, `nw-value`
- `btn-nw-cancel`, `btn-nw-save`

Sem esse modal, clicar em "+ Add Asset/Debt" no Net Worth card silencia o erro e não abre nada.

**Ação:** Adicionar o seguinte HTML antes do `</body>`, junto com os outros modais:

```html
<!-- ═══ NET WORTH MODAL ═══ -->
<div id="modal-net-worth" class="modal-overlay">
  <div class="modal-box">
    <div class="modal-title">Add Net Worth Entry</div>
    <div class="field-group">
      <label class="field-label">Category</label>
      <select id="nw-category" class="select-ctrl" style="width:100%;padding:9px 12px;font-size:12px;">
        <option value="cash">Cash</option>
        <option value="real_estate">Real Estate</option>
        <option value="other_assets">Other Asset</option>
        <option value="debts">Debt / Liability</option>
      </select>
    </div>
    <div class="field-group">
      <label class="field-label">Label</label>
      <input type="text" id="nw-label" placeholder="e.g. Savings account, Car loan…">
    </div>
    <div class="field-group">
      <label class="field-label">Value (USD) — use negative for debts</label>
      <input type="number" id="nw-value" placeholder="5000" step="any">
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn-ghost" id="btn-nw-cancel">Cancel</button>
      <button class="btn-primary" id="btn-nw-save">Save Entry</button>
    </div>
  </div>
</div>
```

---

### 4. `extension/popup.html` — Links de Privacy/Terms apontam para Railway (BLOQUEIO CWS)

No menu lateral (`nav-menu`), os links de rodapé apontam para:
```
https://purp-production.up.railway.app/static/privacy-policy.html
https://purp-production.up.railway.app/static/terms-of-service.html
```

A Chrome Web Store exige que os links de Privacy Policy sejam URLs públicas e estáveis.
URLs do Railway podem mudar ou ficar offline; além disso, a CWS vai inspecionar esse link
durante a revisão.

**Ação:** Substituir as duas âncoras de rodapé no `nav-menu`:

```html
<a class="nav-footer-link" href="https://getpurpai.com/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
<a class="nav-footer-link" href="https://getpurpai.com/terms-of-service" target="_blank" rel="noopener noreferrer">Terms of Use</a>
<a class="nav-footer-link" href="https://getpurpai.com" target="_blank" rel="noopener noreferrer">getpurpai.com</a>
```

---

### 5. `extension/manifest.json` — Versão e descrição para publicação (REQUISITO CWS)

A versão atual `"1.2"` é válida, mas a descrição pode ser otimizada para o listing da CWS
(limite: 132 caracteres).

**Ação:** Atualizar `description` e confirmar que `version` está correto:

```json
"version": "1.2.0",
"description": "Track stocks & crypto with AI insights. Portfolio score, tax tools, price alerts and market watch — all in one place.",
```

Também adicionar `"homepage_url"` para aparecer na listing da CWS:

```json
"homepage_url": "https://getpurpai.com",
```

---

### 6. `extension/manifest.json` — `host_permissions` incompleto (AVISO CWS)

O manifest só lista Railway e Sentry. Se o domínio `getpurpai.com` for usado futuramente
para API ou assets, a extensão quebrará.

**Ação:** Adicionar `getpurpai.com` nas host_permissions como medida preventiva:

```json
"host_permissions": [
  "https://purp-production.up.railway.app/*",
  "https://*.sentry.io/*",
  "https://getpurpai.com/*"
]
```

---

### 7. `extension/popup.js` — `asset-spark` canvas sem fallback de limpeza

Quando o Market Watch recarrega (timer de 60s), novos Charts são criados em cima de
canvas existentes sem destruir as instâncias anteriores, gerando memory leak e aviso
`Canvas is already in use` no console.

**Ação:** Na função `renderSpark`, verificar e destruir instância anterior antes de criar:

```js
function renderSpark(canvasId, data, color) {
  if (typeof Chart === 'undefined') return;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  // Destruir instância anterior se existir
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx || !data?.length) return;
  new Chart(ctx, {
    type: 'line',
    data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: false }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } }, animation: false },
  });
}
```

---

### 8. `extension/Verify-screen.JS` — Nome do arquivo com `.JS` maiúsculo (BUG EM LINUX)

O arquivo se chama `Verify-screen.JS` (JS maiúsculo) mas é referenciado no `popup.html`
como `Verify-screen.JS`. Em sistemas de arquivos **case-sensitive** (Linux — que é o que
a Chrome Web Store usa para validar o `.zip`), isso pode causar falha de carregamento.

**Ação:** Renomear o arquivo para `verify-screen.js` (tudo minúsculo) e atualizar a
referência em `popup.html`:

```html
<!-- antes -->
<script src="Verify-screen.JS"></script>

<!-- depois -->
<script src="verify-screen.js"></script>
```

Renomear o arquivo no sistema de arquivos também:
```bash
mv extension/Verify-screen.JS extension/verify-screen.js
```

---

### 9. Checklist final antes de empacotar o `.zip`

Após aplicar todas as correções acima, executar este checklist:

```
[ ] Remover console.log() de debug que não devem ir para produção
[ ] Confirmar que icons/icon16.png, icon48.png e icon128.png existem
[ ] Confirmar que chart.js está incluído no pacote (não carregado de CDN externo)
[ ] Confirmar que bundle.min.js (Sentry) está incluído no pacote
[ ] Testar o popup desempacotado em chrome://extensions/ com Developer Mode
[ ] Testar fluxo completo: Login → Verify Email → Dashboard → Market Watch → Sell → Logout
[ ] Empacotar como .zip excluindo: .git/, node_modules/, *.map, .DS_Store
[ ] Submeter Privacy Policy URL na CWS: https://getpurpai.com/privacy-policy
[ ] Preencher campo "Single purpose" na CWS: "Track investment portfolio with AI analysis"
[ ] Screenshots da CWS: 1280x800 ou 640x400 (mínimo 1, máximo 5)
```

---

## Resumo dos Arquivos a Modificar

| Arquivo | Mudanças |
|---|---|
| `extension/manifest.json` | CSP (fonts), homepage_url, versão, host_permissions |
| `extension/popup.html` | Modal net-worth, links Privacy/Terms, referência verify-screen.js |
| `extension/popup.js` | Sentry DSN guard, renderSpark com destroy |
| `extension/Verify-screen.JS` | Renomear para `verify-screen.js` |

**Estimativa:** ~30 min para aplicar todas as correções e testar.