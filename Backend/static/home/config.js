/* Purp — Environment-aware configuration.
   API_BASE is resolved from:
   1. <meta name="api-base" content="..."> tag (set server-side per env)
   2. Fallback: same origin (works when app is served from the API itself)

   Debug (production): add ?debug=SESSION_ID to URL to enable logging.
   Optional: &debug_ingest=URL (default: local ingest). Ingest server must run on same machine.
*/
const API_BASE = (() => {
  const meta = document.querySelector('meta[name="api-base"]');
  if (meta && meta.content) return meta.content.replace(/\/+$/, '');
  return window.location.origin;
})();

const FREE_ASSET_LIMIT = 4;
const REFRESH_MS       = 60_000;

// Debug ingest for production: ?debug=dd6d25 or &debug_ingest=http://127.0.0.1:7351/ingest/...
const _params = typeof URLSearchParams !== 'undefined' ? new URLSearchParams(window.location.search) : null;
const DEBUG_SESSION_ID = _params?.get('debug') || null;
const DEBUG_INGEST_URL = _params?.get('debug_ingest') || (DEBUG_SESSION_ID ? 'http://127.0.0.1:7351/ingest/64ae4719-d813-458e-9378-1f1b6cba8148' : null);

function debugLog(message, data, hypothesisId, location, runId) {
  if (!DEBUG_INGEST_URL || !DEBUG_SESSION_ID) return;
  const payload = {
    sessionId: DEBUG_SESSION_ID,
    location: location || 'config.js:debugLog',
    message: message,
    data: data || {},
    timestamp: Date.now()
  };
  if (hypothesisId) payload.hypothesisId = hypothesisId;
  if (runId) payload.runId = runId;
  fetch(DEBUG_INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': DEBUG_SESSION_ID },
    body: JSON.stringify(payload)
  }).catch(function() {});
}
if (typeof window !== 'undefined') window.debugLog = debugLog;
