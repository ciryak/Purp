# AGENTS.md

## Cursor Cloud specific instructions

### Overview

**Purp** is an AI-powered investment portfolio tracker (stocks + crypto). The codebase has two main parts:

| Component | Path | Tech |
|-----------|------|------|
| Backend API | `Backend/` | Python FastAPI + SQLModel + Uvicorn |
| Chrome Extension | `extension/` | Vanilla JS (Manifest V3, no build step) |

### Running the backend (dev mode)

```bash
cd Backend && DATABASE_URL="sqlite:///local.db" uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

**Critical**: You must override `DATABASE_URL` to a local SQLite path (e.g. `sqlite:///local.db`) for local development. The injected environment secret points to a Railway PostgreSQL instance that is not reachable from the cloud VM. Without the override the app will crash on startup.

**Critical**: `SECRET_KEY` must be at least 32 random characters. The app calls `sys.exit(1)` on startup if it is missing, empty, or in a blocklist of insecure values. The environment already injects this secret.

### Running tests

```bash
pytest Backend/test_main.py -v
```

Tests use an in-memory SQLite database and mock all external calls — no API keys or network access needed. Note: 5 auth-related tests (`test_register_*`, `test_login_*`) have pre-existing failures due to field-name mismatches between the test payloads and the current `RegisterInput`/`LoginInput` models (`username` vs `full_name`/`email`). The remaining 17 tests pass.

### Linting

```bash
ruff check Backend/
```

There is no project-level ruff config; the codebase has ~103 pre-existing lint warnings (mostly import ordering and unused imports).

### Key API endpoints for manual testing

- `GET /health` — health check
- `POST /auth/register` — body: `{"full_name", "password", "email"}`
- `POST /auth/login` — body: `{"email", "password"}`
- `POST /assets/` — body: `{"symbol", "amount", "purchase_price"}` (needs Bearer token)
- `GET /portfolio/balance` — returns portfolio with live prices (needs Bearer token)
- `GET /docs` — Swagger UI

### Gotchas

- After registering, the user's `is_verified` is `false`. For local dev/testing you can set it directly in SQLite since email delivery (Resend) may not be configured.
- Binance API returns 451 from this environment (geo-blocked). The app logs a warning but continues; price lookups fall back to Yahoo Finance / CoinCap.
- The Chrome extension (`extension/`) is plain JS with no build system — it communicates with the production API at `purp-backend.railway.app` and is not part of the local dev loop.
