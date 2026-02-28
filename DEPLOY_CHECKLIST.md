# Deploy & Rollback Checklist

## Pre-deploy

- [ ] All CI checks passing on the branch
- [ ] `ENVIRONMENT`, `SECRET_KEY`, `CRON_SECRET`, `DATABASE_URL`, `STRIPE_*`, `ALLOWED_ORIGINS` configured in deploy environment
- [ ] Database backup taken (Railway snapshots or `pg_dump`)

## Deploy

1. Push to `main` (Railway auto-deploys) or trigger manual deploy.
2. Alembic migrations run automatically on startup (`create_db` calls `alembic upgrade head`).
3. Watch deploy logs for:
   - `✅ Alembic migrations applied`
   - `💳 Price→plan map: ...`
   - No `FATAL` messages

## Post-deploy

- [ ] Hit `/health` — expect `{"status":"ok","api_ok":true,...}`
- [ ] Verify login flow works (register + verify + login)
- [ ] Confirm cron job (`/alerts/check`) executes via GitHub Actions log
- [ ] Check Sentry for new errors

## Rollback

1. **Application**: Redeploy previous commit via Railway dashboard or `git revert`.
2. **Database**: If the new migration is destructive, restore from pre-deploy backup.
   - For non-destructive migrations, previous code version can still run against the new schema.
3. **Verify**: Re-run post-deploy checks above.
