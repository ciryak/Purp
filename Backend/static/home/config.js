/* Purp — Environment-aware configuration.
   API_BASE is resolved from:
   1. <meta name="api-base" content="..."> tag (set server-side per env)
   2. Fallback: same origin (works when app is served from the API itself)
*/
const API_BASE = (() => {
  const meta = document.querySelector('meta[name="api-base"]');
  if (meta && meta.content) return meta.content.replace(/\/+$/, '');
  return window.location.origin;
})();

const FREE_ASSET_LIMIT = 4;
const REFRESH_MS       = 60_000;
