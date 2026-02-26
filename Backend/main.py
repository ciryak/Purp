"""
Purp — FastAPI backend v7.
New in v7:
  - Email verification on register (6-digit code, 15 min expiry)
  - POST /auth/verify-email
  - POST /auth/resend-verification
  - Login blocked until account is verified
"""
import io
import os
import csv
import re
import random
import string
import threading
import concurrent.futures
from datetime import date, datetime, timedelta, timezone
import sentry_sdk
import resend
from fastapi import FastAPI, HTTPException, Depends, Header, Request, BackgroundTasks, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from PIL import Image, ImageDraw, ImageFont
from sqlmodel import Session, select, create_engine, SQLModel
from pydantic import BaseModel, EmailStr
import bcrypt
import stripe
from jose import JWTError, jwt
from fastapi.staticfiles import StaticFiles

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from models import Asset, User, Transaction, PriceAlert, WatchlistItem, ProcessedEvent, Dividend, EmailVerification, NetWorthEntry
from services import (
    get_asset_data,
    get_ai_analysis,
    get_historical_data,
    search_symbols,
    get_portfolio_ai_analysis,
    get_ai_status,
    check_and_trigger_alerts,
    parse_broker_csv,
    calculate_tax_loss_harvesting,
    calculate_cost_basis,
    generate_form_8949,
    get_dividend_data,
    generate_weekly_digest,
)

sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN", ""),
    traces_sample_rate=0.1,
    environment=os.getenv("ENVIRONMENT", "production"),
)

# ── Config ─────────────────────────────────────────────────────────────────────
SECRET_KEY   = os.getenv("SECRET_KEY", "")
ALGORITHM    = os.getenv("ALGORITHM", "HS256")
TOKEN_EXPIRE = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 10080))

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

_raw_db_url  = os.getenv("DATABASE_URL", "sqlite:///database.db")
DATABASE_URL = _raw_db_url.replace("postgres://", "postgresql://")
_is_postgres = DATABASE_URL.startswith("postgresql://")

RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
FROM_EMAIL     = os.getenv("FROM_EMAIL", "Purp <noreply@getpurpai.com>")

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY
    print("✅ Resend configured")
else:
    print("⚠️  RESEND_API_KEY not set — emails disabled")

VERIFICATION_EXPIRE_MINUTES = 15
CRON_SECRET = os.getenv("CRON_SECRET", "")
SYMBOL_PATTERN = re.compile(r"^[A-Z0-9.\-\^]+$")
MAX_SYMBOL_LENGTH = 20
MAX_FULL_NAME_LENGTH = 60


def sanitize_full_name(full_name: str) -> str:
    cleaned = full_name.strip()
    if len(cleaned) < 3:
        raise HTTPException(400, "Full name must be at least 3 characters")
    if len(cleaned) > MAX_FULL_NAME_LENGTH:
        raise HTTPException(400, f"Full name must be at most {MAX_FULL_NAME_LENGTH} characters")
    return cleaned


def sanitize_symbol(symbol: str) -> str:
    cleaned = symbol.strip().upper()
    if not cleaned:
        raise HTTPException(400, "symbol is required")
    if len(cleaned) > MAX_SYMBOL_LENGTH:
        raise HTTPException(400, f"symbol must be at most {MAX_SYMBOL_LENGTH} characters")
    if not SYMBOL_PATTERN.fullmatch(cleaned):
        raise HTTPException(400, "symbol contains invalid characters")
    return cleaned


def sanitize_search_query(query: str) -> str:
    cleaned = query.strip()
    if len(cleaned) > 50:
        raise HTTPException(400, "Search query must be at most 50 characters")
    return cleaned


def _build_engine():
    if _is_postgres:
        connect_args = {}
        if "sslmode=" not in DATABASE_URL:
            connect_args = {"sslmode": "require"}
        return create_engine(
            DATABASE_URL,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            connect_args=connect_args,
        )
    return create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


engine = _build_engine()

# ── Plan limits ────────────────────────────────────────────────────────────────
FREE_ASSET_LIMIT      = 4
FREE_WATCHLIST_LIMIT  = 10
FREE_ALERT_LIMIT      = 2
FREE_HISTORY_DAYS     = 30
INVESTOR_HISTORY_DAYS = 730
CSV_MAX_BYTES         = 5 * 1024 * 1024

PRICE_ID_INVESTOR = os.getenv("STRIPE_PRICE_ID_INVESTOR", "")
PRICE_ID_TAX_PRO  = os.getenv("STRIPE_PRICE_ID_TAX_PRO",  "")


def _build_price_plan_map() -> dict[str, str]:
    m: dict[str, str] = {}
    if PRICE_ID_INVESTOR:
        m[PRICE_ID_INVESTOR] = "investor"
    if PRICE_ID_TAX_PRO:
        m[PRICE_ID_TAX_PRO] = "tax_pro"
    return m


PRICE_PLAN_MAP: dict[str, str] = {}


# ── Permission helpers ─────────────────────────────────────────────────────────

def has_plan(user: User, *plans: str) -> bool:
    return user.plan in plans


def require_investor(user: User) -> None:
    if not has_plan(user, "investor", "tax_pro"):
        raise HTTPException(
            402,
            "This feature requires the Investor plan ($19/mo) or higher. "
            "Upgrade to unlock AI analysis, unlimited assets, and more."
        )


def require_tax_pro(user: User) -> None:
    if not has_plan(user, "tax_pro"):
        raise HTTPException(
            402,
            "This feature requires the Tax Pro plan ($29/mo). "
            "Upgrade to unlock Tax Loss Harvesting and Form 8949 export."
        )


# ── Email helpers ──────────────────────────────────────────────────────────────

def _send_email(to_email: str, subject: str, html: str) -> None:
    if not RESEND_API_KEY:
        print("⚠️  Email skipped — RESEND_API_KEY not configured")
        return
    try:
        resp = resend.Emails.send({
            "from":    FROM_EMAIL,
            "to":      [to_email],
            "subject": subject,
            "html":    html,
        })
        print(f"✅ Email sent → {to_email} | id={resp.get('id')}")
    except Exception as e:
        print(f"❌ Resend error ({to_email}): {e}")


def _send_verification_email(to_email: str, username: str, code: str) -> None:
    digits = list(code)
    boxes = "".join(
        f'<td style="padding:0 4px;"><div style="width:44px;height:52px;background:rgba(124,58,237,0.12);'
        f'border:2px solid rgba(124,58,237,0.4);border-radius:10px;display:flex;align-items:center;'
        f'justify-content:center;font-size:26px;font-weight:900;color:#fff;font-family:monospace;'
        f'text-align:center;line-height:52px;">{d}</div></td>'
        for d in digits
    )
    html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0a0914;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:48px 16px;">
    <table width="520" cellpadding="0" cellspacing="0"
           style="background:#110f20;border-radius:20px;border:1px solid rgba(124,58,237,.3);overflow:hidden;">
      <tr><td style="background:linear-gradient(135deg,#7c3aed,#a78bfa);padding:36px;text-align:center;">
        <div style="font-size:40px;margin-bottom:10px;">🔐</div>
        <h1 style="margin:0;color:#fff;font-size:22px;font-weight:800;">Verify your Purp account</h1>
        <p style="color:rgba(255,255,255,.75);margin:8px 0 0;font-size:13px;">Enter this code in the app to activate your account</p>
      </td></tr>
      <tr><td style="padding:32px 36px;text-align:center;">
        <p style="color:#f1f0f5;font-size:14px;margin:0 0 24px;">
          Hey <strong style="color:#a78bfa;">{username}</strong> 👋 — use the code below to complete your registration.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
          <tr>{boxes}</tr>
        </table>
        <p style="color:rgba(241,240,245,.4);font-size:12px;margin:0 0 8px;">
          ⏱ This code expires in <strong style="color:rgba(241,240,245,.7);">15 minutes</strong>.
        </p>
        <p style="color:rgba(241,240,245,.3);font-size:11px;margin:0;">
          If you didn't create a Purp account, you can safely ignore this email.
        </p>
      </td></tr>
      <tr><td style="padding:0 36px 24px;text-align:center;">
        <p style="color:rgba(241,240,245,.2);font-size:10px;margin:0;">Purp · AI Portfolio Tracker</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>"""
    _send_email(to_email, "Your Purp verification code", html)


def _send_welcome_email(to_email: str, username: str) -> None:
    html = f"""<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0914;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 16px;">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#110f20;border-radius:20px;border:1px solid rgba(124,58,237,.25);overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,#7c3aed,#a78bfa);padding:40px;text-align:center;">
    <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Welcome to Purp 🚀</h1>
    <p style="color:rgba(255,255,255,.8);margin:8px 0 0;font-size:13px;">Your AI-powered portfolio tracker</p>
  </td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="color:#f1f0f5;font-size:15px;margin:0 0 14px;">Hey <strong style="color:#a78bfa;">{username}</strong> 👋</p>
    <p style="color:rgba(241,240,245,.7);font-size:13px;line-height:1.7;margin:0 0 22px;">
      Your account is ready. Track up to <strong style="color:#fff;">4 assets for free</strong> across crypto and stocks.
    </p>
    <p style="color:rgba(241,240,245,.35);font-size:11px;margin:0;text-align:center;">Questions? Reply to this email · Purp team</p>
  </td></tr>
</table></td></tr></table></body></html>"""
    _send_email(to_email, "Welcome to Purp 🚀", html)


def _send_alert_email(
    to_email: str, username: str, symbol: str,
    alert_type: str, target: float, current: float
) -> None:
    emoji_map = {
        "price_above": "📈", "price_below": "📉",
        "percent_change_up": "🚀", "percent_change_down": "⚠️",
    }
    type_text = {
        "price_above":        f"rose above ${target:,.2f}",
        "price_below":        f"dropped below ${target:,.2f}",
        "percent_change_up":  f"jumped {target}% or more",
        "percent_change_down":f"fell {target}% or more",
    }
    emoji = emoji_map.get(alert_type, "🔔")
    html  = f"""<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0914;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 16px;">
<table width="520" cellpadding="0" cellspacing="0"
       style="background:#110f20;border-radius:20px;border:1px solid rgba(239,68,68,.35);overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,#ef4444,#f87171);padding:40px;text-align:center;">
    <div style="font-size:48px;margin-bottom:14px;">{emoji}</div>
    <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Price Alert Triggered!</h1>
  </td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="color:#f1f0f5;font-size:15px;margin:0 0 14px;">Hey <strong style="color:#a78bfa;">{username}</strong>,</p>
    <p style="color:rgba(241,240,245,.7);font-size:13px;line-height:1.7;margin:0 0 22px;">
      Your alert for <strong style="color:#fff;">{symbol}</strong> has been triggered.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);
                      border-radius:12px;padding:18px;text-align:center;">
        <p style="margin:0 0 8px;color:rgba(241,240,245,.5);font-size:11px;text-transform:uppercase;">Condition</p>
        <p style="margin:0;color:#fff;font-size:16px;font-weight:700;">{type_text.get(alert_type, "changed")}</p>
        <p style="margin:12px 0 0;color:rgba(241,240,245,.5);font-size:11px;text-transform:uppercase;">Current Price</p>
        <p style="margin:0;color:#a78bfa;font-size:24px;font-weight:900;">${current:,.2f}</p>
      </td></tr>
    </table>
  </td></tr>
</table></td></tr></table></body></html>"""
    _send_email(to_email, f"🔔 Price Alert: {symbol} {type_text.get(alert_type,'changed')}", html)


def send_verification_email_async(to_email: str, username: str, code: str) -> None:
    threading.Thread(target=_send_verification_email, args=(to_email, username, code), daemon=True).start()


def send_welcome_email_async(to_email: str, username: str) -> None:
    threading.Thread(target=_send_welcome_email, args=(to_email, username), daemon=True).start()


def send_alert_email_async(
    to_email: str, username: str, symbol: str,
    alert_type: str, target: float, current: float,
) -> None:
    threading.Thread(
        target=_send_alert_email,
        args=(to_email, username, symbol, alert_type, target, current),
        daemon=True,
    ).start()


def _send_weekly_digest_email(to_email: str, username: str, digest_data: dict) -> None:
    perf = digest_data.get("performance", {})
    change_pct = float(perf.get("change_pct", 0) or 0)
    change_value = float(perf.get("change_value", 0) or 0)
    color = "#22c55e" if change_pct >= 0 else "#ef4444"
    sign = "+" if change_pct >= 0 else ""

    best = digest_data.get("best_performer") or {}
    worst = digest_data.get("worst_performer") or {}
    dividends = digest_data.get("dividends", {})
    tax_ops = digest_data.get("tax_opportunities") or []
    alerts_triggered = int(digest_data.get("alerts_triggered", 0) or 0)
    tx_count = int(digest_data.get("transactions_count", 0) or 0)

    dividends_html = ""
    if float(dividends.get("total", 0) or 0) > 0:
        items_html = "".join(
            f"<li style='margin:6px 0;'>🪙 <strong>{item.get('symbol','')}</strong>: ${float(item.get('amount',0) or 0):,.2f}</li>"
            for item in dividends.get("items", [])
        )
        dividends_html = f"""
        <tr><td style="padding:0 36px 18px;">
          <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:14px;padding:18px;">
            <h3 style="margin:0 0 8px;color:#86efac;font-size:15px;">Dividends Received</h3>
            <p style="margin:0 0 10px;color:#f1f0f5;font-size:13px;">Total this week: <strong>${float(dividends.get('total',0) or 0):,.2f}</strong></p>
            <ul style="margin:0;padding-left:18px;color:rgba(241,240,245,.8);font-size:12px;">{items_html}</ul>
          </div>
        </td></tr>
        """

    tax_html = ""
    if digest_data.get("is_tax_pro") and tax_ops:
        top_ops = "".join(
            f"<li style='margin:6px 0;'><strong>{op.get('symbol','')}</strong> — est. tax saved ${float(op.get('estimated_tax_saved',0) or 0):,.2f}</li>"
            for op in tax_ops[:3]
        )
        tax_html = f"""
        <tr><td style="padding:0 36px 18px;">
          <div style="background:rgba(236,72,153,.08);border:1px solid rgba(236,72,153,.3);border-radius:14px;padding:18px;">
            <h3 style="margin:0 0 10px;color:#f9a8d4;font-size:15px;">Tax Opportunities</h3>
            <ul style="margin:0;padding-left:18px;color:rgba(241,240,245,.8);font-size:12px;">{top_ops}</ul>
          </div>
        </td></tr>
        """

    html = f"""<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0914;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#110f20;border-radius:20px;border:1px solid rgba(124,58,237,.28);overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,#7c3aed,#a78bfa);padding:34px 36px;text-align:center;">
    <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Your Week in Review — Purp</h1>
    <p style="margin:10px 0 0;color:rgba(255,255,255,.82);font-size:13px;">Hey <strong>{username}</strong>, here is your weekly portfolio snapshot.</p>
  </td></tr>

  <tr><td style="padding:24px 36px 14px;">
    <div style="background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.35);border-radius:14px;padding:18px;text-align:center;">
      <p style="margin:0;color:rgba(241,240,245,.55);font-size:11px;text-transform:uppercase;letter-spacing:.7px;">Weekly Performance</p>
      <p style="margin:8px 0 2px;color:{color};font-size:31px;font-weight:900;">{sign}{change_pct:.2f}%</p>
      <p style="margin:0;color:rgba(241,240,245,.75);font-size:13px;">{sign}${change_value:,.2f} this week</p>
    </div>
  </td></tr>

  <tr><td style="padding:8px 36px 18px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="50%" style="padding-right:8px;">
        <div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.26);border-radius:12px;padding:14px;">
          <p style="margin:0;color:rgba(241,240,245,.45);font-size:11px;text-transform:uppercase;">Best Performer</p>
          <p style="margin:8px 0 0;color:#fff;font-size:16px;font-weight:700;">{best.get('symbol','—')}</p>
          <p style="margin:4px 0 0;color:#86efac;font-size:12px;">{best.get('change_pct',0):+.2f}%</p>
        </div>
      </td>
      <td width="50%" style="padding-left:8px;">
        <div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.26);border-radius:12px;padding:14px;">
          <p style="margin:0;color:rgba(241,240,245,.45);font-size:11px;text-transform:uppercase;">Worst Performer</p>
          <p style="margin:8px 0 0;color:#fff;font-size:16px;font-weight:700;">{worst.get('symbol','—')}</p>
          <p style="margin:4px 0 0;color:#fca5a5;font-size:12px;">{worst.get('change_pct',0):+.2f}%</p>
        </div>
      </td>
    </tr></table>
  </td></tr>

  {dividends_html}
  {tax_html}

  <tr><td style="padding:0 36px 26px;">
    <div style="border-top:1px solid rgba(124,58,237,.28);padding-top:16px;">
      <p style="margin:0;color:rgba(241,240,245,.75);font-size:12px;">Alerts triggered: <strong>{alerts_triggered}</strong> · Transactions: <strong>{tx_count}</strong></p>
      <p style="margin:14px 0 0;font-size:12px;"><a href="https://www.getpurpai.com" style="color:#a78bfa;text-decoration:none;">Open Purp App</a> · <a href="https://www.getpurpai.com/settings" style="color:#a78bfa;text-decoration:none;">Manage notifications</a></p>
    </div>
  </td></tr>
</table></td></tr></table></body></html>"""

    _send_email(to_email, "Your Week in Review — Purp", html)


def send_weekly_digest_email_async(to_email: str, username: str, digest_data: dict) -> None:
    threading.Thread(
        target=_send_weekly_digest_email,
        args=(to_email, username, digest_data),
        daemon=True,
    ).start()


# ── Verification code helpers ──────────────────────────────────────────────────

def _generate_code() -> str:
    return "".join(random.choices(string.digits, k=6))


def _create_verification_code(session: Session, user_id: int) -> str:
    """Invalidate old codes and create a fresh one. Returns the code."""
    old = session.exec(
        select(EmailVerification).where(
            EmailVerification.user_id == user_id,
            EmailVerification.used == False,
        )
    ).all()
    for v in old:
        v.used = True
        session.add(v)

    code    = _generate_code()
    expires = (datetime.utcnow() + timedelta(minutes=VERIFICATION_EXPIRE_MINUTES)).isoformat()
    ev = EmailVerification(
        user_id=user_id, code=code,
        expires_at=expires, used=False,
        created_at=datetime.utcnow().isoformat(),
    )
    session.add(ev)
    session.commit()
    return code


# ── DB ─────────────────────────────────────────────────────────────────────────
def create_db() -> None:
    global PRICE_PLAN_MAP
    print(f"🗄️  DB: {DATABASE_URL[:50]}…")
    
    # 1. Cria as tabelas baseadas nos modelos (se não existirem)
    try:
        SQLModel.metadata.create_all(engine)
        print("✅ Tables OK")
    except Exception as e:
        print(f"❌ FATAL table creation failed: {e}")
        raise

    # 2. Cria o índice único de email (se não existir)
    try:
        with engine.connect() as conn:
            if _is_postgres:
                conn.exec_driver_sql(
                    'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_email_unique ON "user"(email)'
                )
            else:
                conn.exec_driver_sql(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ix_user_email_unique ON user(email)"
                )
            conn.commit()
    except Exception as e:
        print(f"⚠️  Email index: {e}")

    # 3. Migração da coluna notification_digest (CORRIGIDO)
    try:
        with engine.connect() as conn:
            if _is_postgres:
                # No Postgres, usamos IF NOT EXISTS para evitar o erro de 'already exists'
                conn.exec_driver_sql('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS notification_digest BOOLEAN DEFAULT TRUE')
            else:
                # No SQLite, tentamos adicionar normalmente (o try/except captura se já existir)
                conn.exec_driver_sql('ALTER TABLE user ADD COLUMN notification_digest BOOLEAN DEFAULT 1')
            conn.commit()
            print("✅ Checked notification_digest column")
    except Exception as e:
        # Se cair aqui, é porque a coluna já existe (no caso do SQLite) ou houve erro de conexão
        # Usamos uma mensagem mais informativa e menos "assustadora"
        if "already exists" in str(e).lower():
            print("ℹ️  notification_digest column already present.")
        else:
            print(f"ℹ️  notification_digest migration note: {e}")
    try:
        with Session(engine) as s:
            u = s.get(User, 1)
            if u and u.plan == "free":
                u.plan = "investor"
                u.is_premium = True
                # Owner is always verified
                if not u.is_verified:
                    u.is_verified = True
                s.add(u); s.commit()
    except Exception as e:
        print(f"⚠️  Owner plan check: {e}")

    PRICE_PLAN_MAP = _build_price_plan_map()
    print(f"💳 Price→plan map: {PRICE_PLAN_MAP}")

# ── Sentry ─────────────────────────────────────────────────────────────────────

sentry_sdk.init(
    dsn=os.getenv("SENTRY_DSN"),
    integrations=[FastApiIntegration(), StarletteIntegration()],
    traces_sample_rate=1.0,
    profiles_sample_rate=1.0,
    debug=False,
)

# ── App ────────────────────────────────────────────────────────────────────────

app = FastAPI(title="Purp API", version="7.0", on_startup=[create_db])
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please wait a moment and try again."},
    )


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response

app.mount("/static", StaticFiles(directory="static"), name="static")

EXTENSION_STATIC_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "extension"))
if os.path.isdir(EXTENSION_STATIC_DIR):
    app.mount("/extension-assets", StaticFiles(directory=EXTENSION_STATIC_DIR), name="extension-assets")

@app.get("/")
async def read_index():
    return FileResponse("static/index.html")

@app.get("/home")
async def home_dashboard():
    return FileResponse("static/home.html")

HOME_SECTION_FILES = {
    "market": "static/home/market.html",
    "add-asset": "static/home/add-asset.html",
    "alerts": "static/home/alerts.html",
    "import": "static/home/import.html",
    "transactions": "static/home/transactions.html",
}

@app.get("/home/{section}")
async def home_section(section: str):
    section_file = HOME_SECTION_FILES.get(section)
    if not section_file:
        raise HTTPException(404, "Section not found")
    return FileResponse(section_file)


def get_session():
    with Session(engine) as s:
        yield s


def create_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str | None = Header(None, alias="X-Auth-Token"),
    authorization: str | None = Header(None, alias="Authorization"),
) -> int:
    resolved_token = token
    if not resolved_token and authorization:
        auth_value = authorization.strip()
        if auth_value.lower().startswith("bearer "):
            resolved_token = auth_value[7:].strip()

    if not resolved_token:
        raise HTTPException(401, "Not authenticated — please log in")
    try:
        payload = jwt.decode(resolved_token, SECRET_KEY, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except (JWTError, ValueError, KeyError, TypeError):
        raise HTTPException(401, "Invalid or expired session — please log in again")


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def _history_days_for_user(user: User) -> int:
    return INVESTOR_HISTORY_DAYS if has_plan(user, "investor", "tax_pro") else FREE_HISTORY_DAYS


# ── Schemas ────────────────────────────────────────────────────────────────────

class RegisterInput(BaseModel):
    full_name: str
    password: str
    email: EmailStr


class LoginInput(BaseModel):
    email: EmailStr
    password: str


class VerifyEmailInput(BaseModel):
    code: str


class ForgotPasswordInput(BaseModel):
    email: EmailStr


class ResendVerificationInput(BaseModel):
    email: EmailStr


class AssetInput(BaseModel):
    symbol: str
    amount: float
    purchase_price: float
    purchase_date: str | None = None


class SellInput(BaseModel):
    amount: float


class WatchlistAddInput(BaseModel):
    symbol: str


class AlertCreateInput(BaseModel):
    symbol: str | None = None
    alert_type: str
    target_value: float
    recurring: bool = False
    rsi_period: int | None = 14
    rebalance_threshold_pct: float | None = None
    target_allocation_pct: float | None = None


class CheckoutInput(BaseModel):
    plan: str = "investor"


class PreferencesInput(BaseModel):
    notification_email: bool
    notification_digest: bool
    notification_browser: bool


class NetWorthEntryInput(BaseModel):
    category: str
    label: str
    value: float


class RebalanceInput(BaseModel):
    targets: dict[str, float]


# ═══════════════════════════════════════════════════════════════════════════════
# AUTH
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/auth/register")
@limiter.limit("5/minute")
def register(request: Request, data: RegisterInput, session: Session = Depends(get_session)):
    full_name = sanitize_full_name(data.full_name)
    if len(data.password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")
    try:
        email_norm = str(data.email).strip().lower()
        if session.exec(select(User).where(User.email == email_norm)).first():
            raise HTTPException(400, "Email already registered")
        
        user = User(
            username=full_name, 
            password_hash=hash_pw(data.password),
            email=email_norm, 
            plan="free", 
            is_premium=False,
            is_verified=False,
            created_at=str(date.today()),
        )
        session.add(user)
        session.commit()
        session.refresh(user)
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(503, f"Database error during registration: {e}")

    if user.id is None:
        raise HTTPException(500, "Failed to create user — please try again")

    # Gera e envia o código
    code = _create_verification_code(session, user.id)
    send_verification_email_async(email_norm, full_name, code)

    token = create_token(user.id)
    
    return {
        "token": token,
        "user": _user_payload(user),
        "requires_verification": True,
        "email": email_norm  # Adicionado para facilitar o front
    }

@app.post("/auth/login")
@limiter.limit("10/minute")
def login(request: Request, data: LoginInput, session: Session = Depends(get_session)):
    email_norm = str(data.email).strip().lower()

    if not email_norm:
        raise HTTPException(400, "E-mail is required")

    # 1. Procura o utilizador por e-mail
    user = session.exec(select(User).where(User.email == email_norm)).first()

    # 2. Valida credenciais
    if not user or not verify_pw(data.password, user.password_hash):
        raise HTTPException(401, "E-mail ou senha incorretos")

    # 3. Gera o token (necessário para autorizar a verificação posterior)
    token = create_token(user.id)

    # 4. VERIFICAÇÃO DE STATUS (O Pulo do Gato)
    if not user.is_verified:
        # Se não estiver verificado, envia um novo código por e-mail automaticamente (Opcional)
        # code = _create_verification_code(session, user.id)
        # send_verification_email_async(user.email, user.username, code)
        
        return {
            "token": token,
            "user": _user_payload(user),
            "requires_verification": True  # Avisa o front para mudar de tela
        }

    # 5. Login normal para utilizadores verificados
    return {
        "token": token,
        "user": _user_payload(user),
        "requires_verification": False
    }

@app.post("/auth/forgot-password")
@limiter.limit("3/minute")
def forgot_password(request: Request, data: ForgotPasswordInput):
    _ = str(data.email).strip().lower()
    return {"ok": True, "message": "If this email exists, a reset link will be sent."}


@app.post("/auth/verify-email")
def verify_email(
    data: VerifyEmailInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(400, "User not found or code expired")

    # Se já estiver verificado, garante que devolvemos um token válido mesmo assim
    if user.is_verified:
        access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        new_token = create_access_token(
            data={"sub": str(user.id)}, expires_delta=access_token_expires
        )
        return {"ok": True, "token": new_token, "user": _user_payload(user)}

    code = data.code.strip()
    if len(code) != 6 or not code.isdigit():
        raise HTTPException(400, "Invalid code format — must be 6 digits")

    # Find the latest unused, non-expired code for this user
    ev = session.exec(
        select(EmailVerification).where(
            EmailVerification.user_id == user_id,
            EmailVerification.used == False,
        ).order_by(EmailVerification.id.desc())
    ).first()

    if not ev:
        raise HTTPException(400, "No active verification code found. Please request a new one.")

    # Check expiry
    try:
        expires = datetime.fromisoformat(ev.expires_at)
        if datetime.utcnow() > expires:
            ev.used = True; session.add(ev); session.commit()
            raise HTTPException(400, "Code has expired. Please request a new one.")
    except ValueError:
        pass  # malformed date — proceed

    if ev.code != code:
        raise HTTPException(400, "Incorrect code. Please try again.")

    # Mark code used and user verified
    ev.used = True; session.add(ev)
    user.is_verified = True; session.add(user)
    session.commit()

    # Send welcome email now that they're verified
    send_welcome_email_async(user.email, user.username)
    new_token = create_access_token(
        data={"sub": str(user.id)}, expires_delta=access_token_expires
    )

    return {"ok": True, "token": new_token, "user": _user_payload(user)}

@app.post("/auth/resend-verification")
@limiter.limit("2/minute")
def resend_verification(
    request: Request,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if user.is_verified:
        raise HTTPException(400, "Account is already verified")

    # Rate-limit: check if a code was sent in the last 60 seconds
    recent = session.exec(
        select(EmailVerification).where(
            EmailVerification.user_id == user_id,
            EmailVerification.used == False,
        ).order_by(EmailVerification.id.desc())
    ).first()

    if recent:
        try:
            created = datetime.fromisoformat(recent.created_at)
            elapsed = (datetime.utcnow() - created).total_seconds()
            if elapsed < 60:
                wait = int(60 - elapsed)
                raise HTTPException(429, f"Please wait {wait} seconds before requesting a new code.")
        except ValueError:
            pass

    code = _create_verification_code(session, user.id)
    send_verification_email_async(user.email, user.username, code)
    return {"ok": True, "message": "Verification code sent"}


@app.get("/auth/me")
def auth_me(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return {**_user_payload(user), "email": user.email, "is_verified": user.is_verified, "notification_digest": user.notification_digest}


@app.post("/auth/logout")
def logout():
    return {"ok": True}


@app.patch("/user/preferences")
def update_user_preferences(
    data: PreferencesInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    user.notification_email = data.notification_email
    user.notification_digest = data.notification_digest
    user.notification_browser = data.notification_browser
    session.add(user)
    session.commit()

    return {
        "ok": True,
        "notification_email": user.notification_email,
        "notification_digest": user.notification_digest,
        "notification_browser": user.notification_browser,
    }


def _user_payload(user: User) -> dict:
    return {
        "id":                   user.id,
        "full_name":            user.username,
        "plan":                 user.plan,
        "is_premium":           has_plan(user, "investor", "tax_pro"),
        "is_verified":          user.is_verified,
        "notification_email":   user.notification_email,
        "notification_digest":  user.notification_digest,
        "notification_browser": user.notification_browser,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# WATCHLIST
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/watchlist")
def get_watchlist(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user or not user.is_verified:
        raise HTTPException(403, "Account not verified")
    items = session.exec(
        select(WatchlistItem).where(WatchlistItem.user_id == user_id).order_by(WatchlistItem.order_index)
    ).all()
    if not items:
        return {"items": []}

    def fetch(item: WatchlistItem):
        data = get_asset_data(item.symbol)
        if not data:
            return None
        return {
            "id": item.id, "symbol": data["symbol"], "real_symbol": data["real_symbol"],
            "name": data.get("name", data["symbol"]), "current_price": data["current_price"],
            "percent_change": data["percent_change"], "type": data["type"],
            "icon": data.get("icon", ""), "added_at": item.added_at,
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(fetch, items))
    return {"items": [r for r in results if r]}


@app.post("/watchlist")
def add_to_watchlist(
    data: WatchlistAddInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user or not user.is_verified:
        raise HTTPException(403, "Account not verified")
    symbol = sanitize_symbol(data.symbol)
    existing = session.exec(
        select(WatchlistItem).where(WatchlistItem.user_id == user_id, WatchlistItem.symbol == symbol)
    ).first()
    if existing:
        raise HTTPException(400, f"{symbol} already in your watchlist")

    if not has_plan(user, "investor", "tax_pro"):
        count = len(session.exec(select(WatchlistItem).where(WatchlistItem.user_id == user_id)).all())
        if count >= FREE_WATCHLIST_LIMIT:
            raise HTTPException(402, f"Free plan limited to {FREE_WATCHLIST_LIMIT} watchlist items.")

    asset_data = get_asset_data(symbol)
    if not asset_data:
        raise HTTPException(404, f"Asset '{symbol}' not found")

    item = WatchlistItem(
        user_id=user_id, symbol=asset_data["real_symbol"], type=asset_data["type"],
        added_at=str(date.today()), order_index=0,
    )
    session.add(item); session.commit(); session.refresh(item)
    return {"id": item.id, "symbol": item.symbol, "type": item.type}


@app.delete("/watchlist/{item_id}")
def remove_from_watchlist(
    item_id: int,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    item = session.get(WatchlistItem, item_id)
    if not item or item.user_id != user_id:
        raise HTTPException(404, "Item not found")
    session.delete(item); session.commit()
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════════════════════
# PRICE ALERTS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/alerts")
def get_alerts(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    alerts = session.exec(
        select(PriceAlert).where(PriceAlert.user_id == user_id).order_by(PriceAlert.created_at.desc())
    ).all()
    return {"alerts": [
        {"id": a.id, "symbol": a.symbol, "alert_type": a.alert_type,
         "target_value": a.target_value, "triggered": a.triggered,
         "triggered_at": a.triggered_at, "active": a.active,
         "recurring": a.recurring, "created_at": a.created_at,
         "rsi_period": a.rsi_period,
         "rebalance_threshold_pct": a.rebalance_threshold_pct,
         "target_allocation_pct": a.target_allocation_pct}
        for a in alerts
    ]}


@app.post("/alerts")
def create_alert(
    data: AlertCreateInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if not user.is_verified:
        raise HTTPException(403, "Account not verified")
    if not has_plan(user, "investor", "tax_pro"):
        count = len(session.exec(
            select(PriceAlert).where(PriceAlert.user_id == user_id, PriceAlert.active == True)
        ).all())
        if count >= FREE_ALERT_LIMIT:
            raise HTTPException(402, f"Free plan limited to {FREE_ALERT_LIMIT} price alerts.")
    valid_types = [
        "price_above", "price_below", "percent_change_up", "percent_change_down",
        "rsi_oversold", "rsi_overbought", "rebalance_drift", "volume_spike", "portfolio_down",
    ]
    if data.alert_type not in valid_types:
        raise HTTPException(400, f"Invalid alert_type. Must be one of: {', '.join(valid_types)}")
    if data.target_value <= 0:
        raise HTTPException(400, "target_value must be positive")

    symbol_to_store = None
    if data.alert_type != "portfolio_down":
        if not data.symbol:
            raise HTTPException(400, "symbol is required for this alert_type")
        sanitized_symbol = sanitize_symbol(data.symbol)
        asset_data = get_asset_data(sanitized_symbol)
        if not asset_data:
            raise HTTPException(404, f"Asset '{sanitized_symbol}' not found")
        symbol_to_store = asset_data["real_symbol"]

    if data.alert_type in ("rsi_oversold", "rsi_overbought") and (data.rsi_period is None or data.rsi_period <= 0):
        raise HTTPException(400, "rsi_period must be greater than zero")

    if data.alert_type == "rebalance_drift":
        if data.target_allocation_pct is None:
            raise HTTPException(400, "target_allocation_pct is required for rebalance_drift")
        if data.rebalance_threshold_pct is None:
            data.rebalance_threshold_pct = data.target_value

    alert = PriceAlert(
        user_id=user_id,
        symbol=symbol_to_store,
        alert_type=data.alert_type,
        target_value=data.target_value,
        recurring=data.recurring,
        created_at=str(datetime.now()),
        rsi_period=data.rsi_period,
        rebalance_threshold_pct=data.rebalance_threshold_pct,
        target_allocation_pct=data.target_allocation_pct,
    )
    session.add(alert); session.commit(); session.refresh(alert)
    return {"id": alert.id, "symbol": alert.symbol, "alert_type": alert.alert_type,
            "target_value": alert.target_value, "recurring": alert.recurring,
            "rsi_period": alert.rsi_period,
            "rebalance_threshold_pct": alert.rebalance_threshold_pct,
            "target_allocation_pct": alert.target_allocation_pct}


@app.delete("/alerts/{alert_id}")
def delete_alert(alert_id: int, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    alert = session.get(PriceAlert, alert_id)
    if not alert or alert.user_id != user_id:
        raise HTTPException(404, "Alert not found")
    session.delete(alert); session.commit()
    return {"ok": True}


@app.post("/alerts/{alert_id}/toggle")
def toggle_alert(alert_id: int, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    alert = session.get(PriceAlert, alert_id)
    if not alert or alert.user_id != user_id:
        raise HTTPException(404, "Alert not found")
    alert.active = not alert.active
    session.add(alert); session.commit()
    return {"active": alert.active}


@app.post("/alerts/check")
@limiter.limit("4/hour")
def check_alerts_endpoint(request: Request, background_tasks: BackgroundTasks):
    if request.headers.get("X-Cron-Secret") != CRON_SECRET:
        raise HTTPException(403, "Forbidden")
    background_tasks.add_task(_run_alert_check)
    return {"status": "checking alerts in background"}


def _run_alert_check():
    with Session(engine) as session:
        check_and_trigger_alerts(session, send_alert_email_async)


@app.post("/digest/send-weekly")
def send_weekly_digest(session: Session = Depends(get_session)):
    users = session.exec(
        select(User).where(
            User.notification_email == True,
            User.notification_digest == True,
            User.email.is_not(None),
        )
    ).all()

    sent = 0
    skipped = 0
    for user in users:
        assets = session.exec(select(Asset).where(Asset.user_id == user.id)).all()
        if not assets:
            skipped += 1
            continue
        digest_data = generate_weekly_digest(user.id, session)
        send_weekly_digest_email_async(user.email, user.username, digest_data)
        sent += 1

    return {"sent": sent, "skipped": skipped}


# ═══════════════════════════════════════════════════════════════════════════════
# ASSETS
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/assets/")
def create_asset(
    data: AssetInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user or not user.is_verified:
        raise HTTPException(403, "Account not verified")
    sym = sanitize_symbol(data.symbol)
    if not sym:
        raise HTTPException(400, "Symbol is required")
    if data.amount <= 0:
        raise HTTPException(400, "Amount must be greater than 0")
    if data.purchase_price <= 0:
        raise HTTPException(400, "Purchase price must be greater than 0")
    m = get_asset_data(sym)
    if not m:
        raise HTTPException(404, f"Asset '{sym}' not found.")
    real_sym = m["real_symbol"]
    p_date   = data.purchase_date if data.purchase_date and len(data.purchase_date) >= 10 else str(date.today())
    existing = session.exec(select(Asset).where(Asset.symbol == real_sym, Asset.user_id == user_id)).first()
    if existing:
        total_cost = existing.amount * existing.purchase_price + data.amount * data.purchase_price
        total_qty  = existing.amount + data.amount
        existing.amount         = total_qty
        existing.purchase_price = total_cost / total_qty
        session.add(existing)
        session.add(Transaction(
            user_id=user_id, symbol=real_sym, type="buy",
            amount=data.amount, price=data.purchase_price,
            total_usd=data.amount * data.purchase_price, date=p_date, created_at=str(date.today()),
        ))
        session.commit(); session.refresh(existing)
        return existing
    if not has_plan(user, "investor", "tax_pro"):
        count = len(session.exec(select(Asset).where(Asset.user_id == user_id)).all())
        if count >= FREE_ASSET_LIMIT:
            raise HTTPException(402, f"Free plan limit reached ({FREE_ASSET_LIMIT} assets).")
    asset = Asset(
        symbol=real_sym, amount=data.amount, type=m["type"],
        purchase_price=data.purchase_price, purchase_date=p_date, user_id=user_id,
    )
    session.add(asset); session.commit()
    session.add(Transaction(
        user_id=user_id, symbol=real_sym, type="buy",
        amount=data.amount, price=data.purchase_price,
        total_usd=data.amount * data.purchase_price, date=p_date, created_at=str(date.today()),
    ))
    session.commit(); session.refresh(asset)
    return asset


@app.delete("/assets/{asset_id}")
def delete_asset(asset_id: int, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    asset = session.get(Asset, asset_id)
    if asset and asset.user_id == user_id:
        session.delete(asset); session.commit()
    return {"ok": True}


@app.post("/assets/{asset_id}/sell")
def sell_asset(
    asset_id: int,
    data: SellInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    asset = session.get(Asset, asset_id)
    if not asset:
        raise HTTPException(404, "Asset not found")
    if asset.user_id != user_id:
        raise HTTPException(403, "Access denied")
    if data.amount <= 0:
        raise HTTPException(400, "Sell amount must be positive")
    if data.amount > asset.amount + 1e-9:
        raise HTTPException(400, f"Cannot sell more than you hold ({asset.amount})")
    if asset.type.lower() == "stock" and not data.amount.is_integer():
        raise HTTPException(400, f"For stocks, sell quantity must be a whole number.")

    m             = get_asset_data(asset.symbol)
    current_price = m["current_price"] if m else asset.purchase_price
    sell_total    = data.amount * current_price
    pnl           = sell_total - data.amount * asset.purchase_price
    new_amt       = round(asset.amount - data.amount, 8)

    if new_amt <= 1e-9:
        session.delete(asset); status = "sold_all"
    else:
        asset.amount = new_amt; session.add(asset); status = "partial"

    session.add(Transaction(
        user_id=user_id, symbol=asset.symbol, type="sell",
        amount=data.amount, price=current_price, total_usd=sell_total,
        realized_pnl=pnl, date=str(date.today()), created_at=str(date.today()),
    ))
    session.commit()
    return {"status": status, "remaining": max(new_amt, 0), "pnl": pnl}


# ═══════════════════════════════════════════════════════════════════════════════
# CSV IMPORT
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/import/csv")
async def import_csv(
    file: UploadFile = File(...),
    broker: str = Query(...),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if not user.is_verified:
        raise HTTPException(403, "Account not verified")
    require_investor(user)

    filename = (file.filename or "").lower()
    if not filename.endswith(".csv"):
        raise HTTPException(400, "Only .csv files are accepted.")
    raw_bytes = await file.read()
    if len(raw_bytes) > CSV_MAX_BYTES:
        raise HTTPException(413, "File too large. Maximum allowed size is 5 MB.")
    if not raw_bytes:
        raise HTTPException(400, "Uploaded file is empty.")
    try:
        content = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            content = raw_bytes.decode("latin-1")
        except Exception:
            raise HTTPException(400, "Could not decode file.")

    try:
        transactions = parse_broker_csv(content, broker)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not transactions:
        raise HTTPException(400, f"No valid transactions found in the {broker} CSV.")

    imported = 0; skipped = 0; errors: list[str] = []

    for i, tx in enumerate(transactions):
        try:
            sym = sanitize_symbol(tx["symbol"])
        except HTTPException as e:
            errors.append(f"Row {i+1}: {e.detail} — skipped.")
            continue
        amount = float(tx["amount"])
        price  = float(tx["price"])
        tx_date= tx["date"]
        tx_type= tx["type"]

        if amount <= 0:
            skipped += 1; continue

        if tx_type == "buy":
            if price <= 0:
                mkt = get_asset_data(sym)
                price = mkt["current_price"] if mkt else 0.0
            if price <= 0:
                errors.append(f"Row {i+1} [{sym}]: could not determine price — skipped.")
                skipped += 1; continue
            try:
                m = get_asset_data(sym)
                if not m:
                    errors.append(f"Row {i+1} [{sym}]: symbol not found — skipped.")
                    skipped += 1; continue
                real_sym = m["real_symbol"]
                existing = session.exec(select(Asset).where(Asset.symbol == real_sym, Asset.user_id == user_id)).first()
                if existing:
                    total_cost = existing.amount * existing.purchase_price + amount * price
                    total_qty  = existing.amount + amount
                    existing.amount = total_qty; existing.purchase_price = total_cost / total_qty
                    session.add(existing)
                else:
                    session.add(Asset(symbol=real_sym, amount=amount, type=m["type"],
                                      purchase_price=price, purchase_date=tx_date, user_id=user_id))
                session.add(Transaction(user_id=user_id, symbol=real_sym, type="buy",
                    amount=amount, price=price, total_usd=amount * price,
                    date=tx_date, created_at=str(date.today())))
                session.commit(); imported += 1
            except Exception as e:
                session.rollback(); errors.append(f"Row {i+1} [{sym}]: {e}"); skipped += 1

        elif tx_type == "sell":
            try:
                m        = get_asset_data(sym)
                real_sym = m["real_symbol"] if m else sym
                if price <= 0:
                    price = m["current_price"] if m else 0.0
                asset  = session.exec(select(Asset).where(Asset.symbol == real_sym, Asset.user_id == user_id)).first()
                realized_pnl: float | None = None
                if asset:
                    realized_pnl = (price - asset.purchase_price) * amount
                    new_qty = round(asset.amount - amount, 8)
                    if new_qty <= 1e-9: session.delete(asset)
                    else: asset.amount = new_qty; session.add(asset)
                session.add(Transaction(user_id=user_id, symbol=real_sym, type="sell",
                    amount=amount, price=price, total_usd=amount * price,
                    realized_pnl=realized_pnl, date=tx_date, created_at=str(date.today())))
                session.commit(); imported += 1
            except Exception as e:
                session.rollback(); errors.append(f"Row {i+1} [{sym}]: {e}"); skipped += 1

    return {"imported": imported, "skipped": skipped, "errors": errors[:20],
            "total_parsed": len(transactions), "broker": broker}


def _safe_font(size: int):
    try:
        return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except Exception:
        return ImageFont.load_default()


def _portfolio_period_performance(session: Session, user_id: int, period: str) -> tuple[float, float]:
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return 0.0, 0.0
    start_total = 0.0
    end_total = 0.0
    for a in assets:
        hist = get_historical_data(a.symbol, period)
        prices = [float(p) for p in (hist.get("prices") or []) if p is not None]
        if len(prices) < 2:
            continue
        start_total += prices[0] * a.amount
        end_total += prices[-1] * a.amount
    if start_total <= 0:
        return 0.0, 0.0
    return ((end_total - start_total) / start_total) * 100, end_total


# ═══════════════════════════════════════════════════════════════════════════════
# PORTFOLIO
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/portfolio/balance")
def portfolio_balance(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"total_balance_usd": 0.0, "assets": []}

    def fetch(a: Asset):
        d = get_asset_data(a.symbol)
        return (a, d) if d else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch, assets))

    details, total = [], 0.0
    for r in results:
        if not r: continue
        a, m = r
        val    = m["current_price"] * a.amount
        profit = val - a.purchase_price * a.amount
        total += val
        days   = 0
        if a.purchase_date:
            try:
                days = (date.today() - datetime.strptime(a.purchase_date, "%Y-%m-%d").date()).days
            except Exception:
                pass
        details.append({
            "id": a.id, "symbol": m["symbol"], "real_symbol": a.symbol,
            "amount": a.amount, "current_price": m["current_price"],
            "purchase_price": a.purchase_price, "position_value": val,
            "profit": profit, "percent_change": m["percent_change"],
            "history": m["history"], "icon": m.get("icon", ""),
            "days_held": days, "type": m.get("type", "stock"),
        })
    return {"total_balance_usd": total, "assets": details}


@app.get("/portfolio/history")
def portfolio_history(
    period: str = "1mo",
    benchmark: str = "^GSPC",
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not has_plan(user, "investor", "tax_pro"):
        period_day_map = {"1d": 1, "5d": 5, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730}
        if period_day_map.get(period, 30) > FREE_HISTORY_DAYS:
            raise HTTPException(402, f"Free plan history is limited to {FREE_HISTORY_DAYS} days.")
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"dates": [], "portfolio": [], "benchmark": []}
    series, final_dates = None, []
    for a in assets:
        h = get_historical_data(a.symbol, period)
        if not h["prices"]: continue
        scaled = [p * a.amount for p in h["prices"]]
        if series is None:
            series, final_dates = scaled, h["dates"]
        else:
            n = min(len(series), len(scaled))
            series = [series[i] + scaled[i] for i in range(n)]
            final_dates = final_dates[:n]
    bench = get_historical_data(benchmark, period)
    return {
        "dates":     final_dates if series else [],
        "portfolio": series or [],
        "benchmark": bench["prices"][:len(final_dates)] if series else [],
    }


@app.get("/portfolio/summary")
def portfolio_summary(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    txs    = session.exec(select(Transaction).where(Transaction.user_id == user_id)).all()
    total_invested = sum(a.amount * a.purchase_price for a in assets)
    realized_pnl   = sum(t.realized_pnl for t in txs if t.realized_pnl is not None)
    return {
        "asset_count": len(assets), "total_invested": total_invested,
        "realized_pnl": realized_pnl, "transaction_count": len(txs),
    }


@app.get("/net-worth")
def get_net_worth(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()

    portfolio_value = 0.0
    manual_by_category: dict[str, list[dict]] = {
        "cash": [], "real_estate": [], "vehicle": [], "other_assets": [], "debt": []
    }

    for a in assets:
        md = get_asset_data(a.symbol)
        if not md:
            continue
        portfolio_value += float(md.get("current_price", 0) or 0) * float(a.amount or 0)

    entries = session.exec(select(NetWorthEntry).where(NetWorthEntry.user_id == user_id)).all()
    manual_assets_total = 0.0
    total_debts = 0.0
    for e in entries:
        cat = (e.category or "other_assets").lower()
        if cat not in manual_by_category:
            cat = "other_assets"
        payload = {
            "id": e.id,
            "category": cat,
            "label": e.label,
            "value": e.value,
            "updated_at": e.updated_at,
        }
        manual_by_category[cat].append(payload)
        if e.value >= 0:
            manual_assets_total += float(e.value)
        else:
            total_debts += float(e.value)

    total_assets = portfolio_value + manual_assets_total
    net_worth = total_assets + total_debts

    # monthly history based on portfolio 1y history + current manual snapshot
    history = []
    p_hist = portfolio_history(period="1y", benchmark="^GSPC", user_id=user_id, session=session)
    dates = p_hist.get("dates") or []
    values = p_hist.get("portfolio") or []
    by_month: dict[str, float] = {}
    for d, v in zip(dates, values):
        mkey = str(d)
        if len(mkey) >= 5:
            by_month[mkey] = float(v or 0)
    for k in sorted(by_month.keys())[-12:]:
        history.append({"month": k, "net_worth": round(by_month[k] + manual_assets_total + total_debts, 2)})

    return {
        "portfolio_value": round(portfolio_value, 2),
        "manual_assets": [item for c in ("cash", "real_estate", "vehicle", "other_assets") for item in manual_by_category[c]],
        "debts": manual_by_category["debt"],
        "total_assets": round(total_assets, 2),
        "total_debts": round(total_debts, 2),
        "net_worth": round(net_worth, 2),
        "breakdown": {
            "investments": round(portfolio_value, 2),
            "cash": round(sum(i["value"] for i in manual_by_category["cash"]), 2),
            "real_estate": round(sum(i["value"] for i in manual_by_category["real_estate"]), 2),
            "other": round(sum(i["value"] for i in manual_by_category["vehicle"] + manual_by_category["other_assets"]), 2),
            "debts": round(total_debts, 2),
        },
        "history": history,
    }


@app.post("/net-worth/entry")
def create_net_worth_entry(
    data: NetWorthEntryInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    category = data.category.strip().lower()
    allowed = {"real_estate", "cash", "vehicle", "other_assets", "debt"}
    if category not in allowed:
        raise HTTPException(400, f"Invalid category. Use: {', '.join(sorted(allowed))}")

    value = float(data.value)
    if category == "debt" and value > 0:
        value = -value

    entry = NetWorthEntry(
        user_id=user_id,
        category=category,
        label=data.label.strip(),
        value=value,
        updated_at=datetime.utcnow().isoformat(),
    )
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return entry


@app.put("/net-worth/entry/{entry_id}")
def update_net_worth_entry(
    entry_id: int,
    data: NetWorthEntryInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    entry = session.get(NetWorthEntry, entry_id)
    if not entry or entry.user_id != user_id:
        raise HTTPException(404, "Entry not found")

    category = data.category.strip().lower()
    allowed = {"real_estate", "cash", "vehicle", "other_assets", "debt"}
    if category not in allowed:
        raise HTTPException(400, f"Invalid category. Use: {', '.join(sorted(allowed))}")

    value = float(data.value)
    if category == "debt" and value > 0:
        value = -value

    entry.category = category
    entry.label = data.label.strip()
    entry.value = value
    entry.updated_at = datetime.utcnow().isoformat()
    session.add(entry)
    session.commit()
    session.refresh(entry)
    return entry


@app.delete("/net-worth/entry/{entry_id}")
def delete_net_worth_entry(
    entry_id: int,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    entry = session.get(NetWorthEntry, entry_id)
    if not entry or entry.user_id != user_id:
        raise HTTPException(404, "Entry not found")
    session.delete(entry)
    session.commit()
    return {"ok": True}


@app.post("/portfolio/rebalance")
def portfolio_rebalance(
    data: RebalanceInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    targets = {sanitize_symbol(k): float(v) for k, v in (data.targets or {}).items() if k and float(v) >= 0}
    if not targets:
        raise HTTPException(400, "targets is required")
    total_target = sum(targets.values())
    if abs(total_target - 100.0) > 0.01:
        raise HTTPException(400, "Target allocation must sum to 100")

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    holdings: dict[str, dict] = {}
    total_value = 0.0

    for a in assets:
        md = get_asset_data(a.symbol)
        if not md:
            continue
        symbol = (md.get("symbol") or a.symbol).upper()
        price = float(md.get("current_price") or 0)
        value = price * float(a.amount or 0)
        total_value += value
        holdings[symbol] = {
            "amount": float(a.amount or 0),
            "price": price,
            "value": value,
            "purchase_price": float(a.purchase_price or 0),
        }

    symbols = sorted(set(list(targets.keys()) + list(holdings.keys())))
    actions = []
    estimated_tax_impact = 0.0

    for sym in symbols:
        target_pct = float(targets.get(sym, 0.0))
        holding = holdings.get(sym)

        current_value = float(holding["value"]) if holding else 0.0
        current_pct = (current_value / total_value * 100) if total_value > 0 else 0.0
        drift = current_pct - target_pct
        if abs(drift) <= 2.0:
            continue

        target_value = (target_pct / 100.0) * total_value
        delta_usd = target_value - current_value
        action = "buy" if delta_usd > 0 else "sell"
        price = float(holding["price"]) if holding else 0.0
        if price <= 0:
            ad = get_asset_data(sym)
            price = float((ad or {}).get("current_price") or 0)
        amount = abs(delta_usd) / price if price > 0 else 0.0

        actions.append({
            "symbol": sym,
            "action": action,
            "amount": round(amount, 8),
            "usd_value": round(abs(delta_usd), 2),
            "reason": f"{current_pct:.1f}% → {target_pct:.1f}%",
            "needs_rebalancing": True,
            "current_allocation": round(current_pct, 2),
            "target_allocation": round(target_pct, 2),
        })

        if action == "sell" and user.plan == "tax_pro" and holding:
            estimated_gain = max(0.0, (price - float(holding.get("purchase_price") or 0)) * amount)
            estimated_tax_impact += estimated_gain * 0.20

    return {
        "actions": actions,
        "total_transactions": len(actions),
        "estimated_tax_impact": round(estimated_tax_impact, 2),
    }


@app.get("/portfolio/score")
def portfolio_score(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    txs = session.exec(select(Transaction).where(Transaction.user_id == user_id)).all()

    enriched_assets = []
    for a in assets:
        md = get_asset_data(a.symbol)
        if not md:
            continue
        days = 0
        if a.purchase_date:
            try:
                days = (date.today() - datetime.strptime(a.purchase_date[:10], "%Y-%m-%d").date()).days
            except Exception:
                pass
        current_price = float(md.get("current_price") or 0)
        enriched_assets.append({
            "symbol": a.symbol,
            "real_symbol": md.get("real_symbol", a.symbol),
            "type": md.get("type", a.type),
            "amount": a.amount,
            "purchase_price": a.purchase_price,
            "purchase_date": a.purchase_date,
            "current_price": current_price,
            "position_value": current_price * float(a.amount or 0),
            "days_held": days,
            "is_tax_pro": user.plan == "tax_pro",
        })

    score = calculate_portfolio_score(enriched_assets, txs)
    if user.plan != "tax_pro":
        score["tax_efficiency"] = None
    return score


@app.get("/portfolio/share-card")
def portfolio_share_card(
    period: str = Query(default="1mo"),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    valid_periods = {"1mo": "this month", "3mo": "this quarter", "6mo": "last 6 months", "1y": "this year"}
    if period not in valid_periods:
        raise HTTPException(400, "Invalid period")

    period_perf, _ = _portfolio_period_performance(session, user_id, period)
    year_perf, _ = _portfolio_period_performance(session, user_id, "1y")

    bench_hist = get_historical_data("^GSPC", period)
    b_prices = [float(v) for v in (bench_hist.get("prices") or []) if v is not None]
    bench_perf = 0.0
    if len(b_prices) >= 2 and b_prices[0] > 0:
        bench_perf = ((b_prices[-1] - b_prices[0]) / b_prices[0]) * 100

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    txs = session.exec(select(Transaction).where(Transaction.user_id == user_id)).all()
    enriched_assets = []
    for a in assets:
        md = get_asset_data(a.symbol)
        if not md:
            continue
        enriched_assets.append({
            "symbol": a.symbol,
            "real_symbol": md.get("real_symbol", a.symbol),
            "type": md.get("type", a.type),
            "amount": a.amount,
            "purchase_price": a.purchase_price,
            "current_price": md.get("current_price", 0),
            "position_value": float(md.get("current_price", 0) or 0) * float(a.amount or 0),
            "days_held": 365 if (a.purchase_date and a.purchase_date <= str(date.today() - timedelta(days=365))) else 0,
            "is_tax_pro": user.plan == "tax_pro",
        })
    score = calculate_portfolio_score(enriched_assets, txs)

    beat_delta = period_perf - bench_perf
    beat_text = f"Beat S&P 500 by {abs(beat_delta):.1f}%" if beat_delta >= 0 else f"Behind S&P 500 by {abs(beat_delta):.1f}%"

    w, h = 1200, 630
    image = Image.new("RGB", (w, h), "#0a0914")
    draw = ImageDraw.Draw(image)

    title_f = _safe_font(56)
    big_f = _safe_font(78)
    body_f = _safe_font(34)
    small_f = _safe_font(26)

    draw.rounded_rectangle((40, 40, w - 40, h - 40), radius=28, outline="#7c3aed", width=3, fill="#110f20")
    draw.text((78, 78), "Purp", font=title_f, fill="#a78bfa")

    perf_sign = "+" if period_perf >= 0 else ""
    perf_color = "#10b981" if period_perf >= 0 else "#ef4444"
    draw.text((78, 200), f"{perf_sign}{period_perf:.1f}%", font=big_f, fill=perf_color)
    draw.text((78, 295), f"{valid_periods[period]}", font=body_f, fill="#f1f0f5")

    if abs(year_perf) > 0:
        year_sign = "+" if year_perf >= 0 else ""
        draw.text((78, 360), f"Annual: {year_sign}{year_perf:.1f}%", font=small_f, fill="#c4b5fd")

    draw.text((78, 412), beat_text, font=body_f, fill="#f1f0f5")
    draw.text((78, 468), f"Portfolio Grade: {score.get('grade', '—')}", font=body_f, fill="#fbbf24")
    draw.text((78, 548), "Tracked with purp.com", font=small_f, fill="#8b5cf6")

    output = io.BytesIO()
    image.save(output, format="PNG")
    output.seek(0)
    return StreamingResponse(output, media_type="image/png")


# ═══════════════════════════════════════════════════════════════════════════════
# TAX
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/portfolio/tax-loss-harvesting")
def portfolio_tax_loss_harvesting(
    tax_bracket: float = Query(default=0.22, ge=0.0, le=0.37),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"opportunities": [], "total_potential_savings": 0.0, "tax_bracket": tax_bracket}

    def fetch(a: Asset):
        d = get_asset_data(a.symbol)
        if not d: return None
        return {"symbol": a.symbol, "amount": a.amount, "purchase_price": a.purchase_price,
                "current_price": d["current_price"], "purchase_date": a.purchase_date or str(date.today())}

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        enriched = [r for r in ex.map(fetch, assets) if r]

    opportunities = calculate_tax_loss_harvesting(enriched, tax_bracket=tax_bracket)
    return {
        "opportunities": opportunities,
        "total_potential_savings": round(sum(o["estimated_tax_saved"] for o in opportunities), 2),
        "tax_bracket": tax_bracket,
        "opportunity_count": len(opportunities),
    }


@app.get("/portfolio/cost-basis")
def portfolio_cost_basis(
    method: str = Query(default="FIFO"),
    symbol: str | None = Query(default=None),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)
    q = select(Transaction).where(Transaction.user_id == user_id)
    if symbol:
        q = q.where(Transaction.symbol == sanitize_symbol(symbol))
    txs = session.exec(q.order_by(Transaction.date)).all()
    tx_list = [
        {"type": t.type, "amount": t.amount, "price": t.price, "date": t.date, "symbol": t.symbol}
        for t in txs
    ]
    result = calculate_cost_basis(tx_list, method=method)
    result["symbol_filter"] = symbol or "ALL"
    return result


@app.get("/tax/loss-harvesting")
def tax_loss_harvesting(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"opportunities": []}

    def fetch(a: Asset):
        d = get_asset_data(a.symbol)
        return (a, d) if d else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch, assets))

    opportunities = []
    for r in results:
        if not r: continue
        a, m = r
        current_value  = m["current_price"] * a.amount
        cost_basis     = a.purchase_price * a.amount
        unrealised_pnl = current_value - cost_basis
        if unrealised_pnl < 0:
            opportunities.append({
                "id": a.id, "symbol": m["symbol"], "amount": a.amount,
                "current_price": m["current_price"], "purchase_price": a.purchase_price,
                "unrealised_loss": unrealised_pnl, "cost_basis": cost_basis,
            })
    opportunities.sort(key=lambda x: x["unrealised_loss"])
    return {"opportunities": opportunities}


@app.get("/tax/form-8949")
def form_8949_csv(
    year:   int = Query(default=None),
    method: str = Query(default="FIFO"),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)
    tax_year = year or date.today().year
    txs = session.exec(
        select(Transaction).where(Transaction.user_id == user_id).order_by(Transaction.date)
    ).all()
    tx_list = [
        {"type": t.type, "symbol": t.symbol, "amount": t.amount,
         "price": t.price, "date": t.date or ""}
        for t in txs
    ]
    form = generate_form_8949(tx_list, tax_year=tax_year, method=method)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([f"IRS Form 8949 — Tax Year {tax_year}"])
    writer.writerow([f"Cost Basis Method: {form['method']}"])
    writer.writerow([f"Generated by Purp — {datetime.now().strftime('%Y-%m-%d %H:%M')}"])
    writer.writerow([])
    writer.writerow(["Part I — Short-Term Capital Gains and Losses (assets held 1 year or less)"])
    writer.writerow(["Description of property","Date acquired","Date sold or disposed","Proceeds","Cost or other basis","Gain or (loss)"])
    for row in form["part_I"]:
        writer.writerow([row["description"],row["date_acquired"],row["date_sold"],f"{row['proceeds']:.2f}",f"{row['cost_basis']:.2f}",f"{row['gain_loss']:.2f}"])
    writer.writerow(["","","Part I Totals:","","",f"{form['summary']['net_short_term']:.2f}"])
    writer.writerow([])
    writer.writerow(["Part II — Long-Term Capital Gains and Losses (assets held more than 1 year)"])
    writer.writerow(["Description of property","Date acquired","Date sold or disposed","Proceeds","Cost or other basis","Gain or (loss)"])
    for row in form["part_II"]:
        writer.writerow([row["description"],row["date_acquired"],row["date_sold"],f"{row['proceeds']:.2f}",f"{row['cost_basis']:.2f}",f"{row['gain_loss']:.2f}"])
    writer.writerow(["","","Part II Totals:","","",f"{form['summary']['net_long_term']:.2f}"])
    writer.writerow([])
    s = form["summary"]
    writer.writerow(["SUMMARY"])
    writer.writerow(["Total Proceeds",f"${s['total_proceeds']:,.2f}"])
    writer.writerow(["Total Cost Basis",f"${s['total_cost_basis']:,.2f}"])
    writer.writerow(["Net Short-Term",f"${s['net_short_term']:,.2f}"])
    writer.writerow(["Net Long-Term",f"${s['net_long_term']:,.2f}"])
    writer.writerow(["Total Net Gain/(Loss)",f"${s['total_net_gain_loss']:,.2f}"])
    csv_content = output.getvalue(); output.close()
    return StreamingResponse(
        io.BytesIO(csv_content.encode("utf-8-sig")),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="form-8949-{tax_year}.csv"', "Cache-Control": "no-store"},
    )


@app.get("/tax/summary")
def tax_summary(
    year: int = Query(default=None),
    method: str = Query(default="FIFO"),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)
    tax_year = year or date.today().year
    txs = session.exec(
        select(Transaction).where(Transaction.user_id == user_id).order_by(Transaction.date)
    ).all()
    tx_list = [
        {"type": t.type, "symbol": t.symbol, "amount": t.amount,
         "price": t.price, "date": t.date or ""}
        for t in txs
    ]
    form = generate_form_8949(tx_list, tax_year=tax_year, method=method)
    s    = form["summary"]
    def est_tax(bracket: float) -> float:
        lt_rate = 0.0 if bracket <= 0.12 else (0.15 if bracket <= 0.35 else 0.20)
        st = max(s["net_short_term"], 0) * bracket
        lt = max(s["net_long_term"],  0) * lt_rate
        return round(st + lt, 2)
    return {
        "tax_year": tax_year, "method": form["method"],
        "net_short_term": s["net_short_term"], "net_long_term": s["net_long_term"],
        "total_net_gain_loss": s["total_net_gain_loss"],
        "total_proceeds": s["total_proceeds"], "total_cost_basis": s["total_cost_basis"],
        "estimated_tax_22pct": est_tax(0.22), "estimated_tax_24pct": est_tax(0.24),
        "estimated_tax_32pct": est_tax(0.32),
        "short_term_count": len(form["part_I"]), "long_term_count": len(form["part_II"]),
    }


@app.get("/tax/form-8949-json")
def form_8949_json(
    year: int = Query(default=None),
    method: str = Query(default="FIFO"),
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)
    tax_year = year or date.today().year
    txs = session.exec(
        select(Transaction).where(Transaction.user_id == user_id).order_by(Transaction.date)
    ).all()
    tx_list = [
        {"type": t.type, "symbol": t.symbol, "amount": t.amount,
         "price": t.price, "date": t.date or ""}
        for t in txs
    ]
    return generate_form_8949(tx_list, tax_year=tax_year, method=method)


# ═══════════════════════════════════════════════════════════════════════════════
# DIVIDENDS
# ═══════════════════════════════════════════════════════════════════════════════

class RecordDividendInput(BaseModel):
    symbol: str
    amount_per_share: float
    ex_date: str
    pay_date: str


@app.get("/portfolio/dividends")
def portfolio_dividends(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    assets = session.exec(
        select(Asset).where(Asset.user_id == user_id, Asset.type == "stock")
    ).all()
    if not assets:
        return {"total_annual_income": 0.0, "total_monthly_income": 0.0, "upcoming_payments": [], "assets": []}

    def fetch_div(a: Asset):
        data = get_dividend_data(a.symbol)
        return (a, data)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch_div, assets))

    asset_rows = []; total_annual = 0.0; upcoming_payments = []
    today = date.today(); cutoff_60 = today + timedelta(days=60)

    for a, div in results:
        annual_rate   = div.get("annual_dividend_rate") or 0.0
        div_yield     = div.get("dividend_yield") or 0.0
        annual_income = round(annual_rate * a.amount, 2)
        yield_on_cost = round((annual_rate / a.purchase_price * 100), 4) if a.purchase_price > 0 and annual_rate > 0 else 0.0
        total_annual += annual_income
        ex_date = div.get("ex_dividend_date"); pay_date = div.get("pay_date")
        if ex_date:
            try:
                ex_dt = datetime.strptime(ex_date[:10], "%Y-%m-%d").date()
                if today <= ex_dt <= cutoff_60:
                    upcoming_payments.append({
                        "symbol": a.symbol, "shares": a.amount, "ex_date": ex_date,
                        "pay_date": pay_date,
                        "amount_per_share": div.get("quarterly_dividend") or round(annual_rate / 4, 4),
                        "projected_total": round((div.get("quarterly_dividend") or annual_rate / 4) * a.amount, 2),
                    })
            except Exception:
                pass
        asset_rows.append({
            "symbol": a.symbol, "shares": a.amount, "purchase_price": a.purchase_price,
            "yield_current": div_yield, "yield_on_cost": yield_on_cost,
            "annual_income": annual_income, "monthly_income": round(annual_income / 12, 2),
            "quarterly_dividend": div.get("quarterly_dividend") or 0.0,
            "annual_rate": annual_rate, "next_ex_date": ex_date, "next_pay_date": pay_date,
            "last_12m_dividends": div.get("last_12m_dividends") or [],
            "pays_dividend": annual_rate > 0,
        })

    asset_rows.sort(key=lambda x: (-x["pays_dividend"], -x["annual_income"]))
    upcoming_payments.sort(key=lambda x: x["ex_date"])
    return {
        "total_annual_income": round(total_annual, 2),
        "total_monthly_income": round(total_annual / 12, 2),
        "upcoming_payments": upcoming_payments, "assets": asset_rows,
    }


@app.post("/dividends/record")
def record_dividend(
    data: RecordDividendInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    sym = sanitize_symbol(data.symbol)
    if data.amount_per_share <= 0:
        raise HTTPException(400, "amount_per_share must be positive")
    asset = session.exec(select(Asset).where(Asset.user_id == user_id, Asset.symbol == sym)).first()
    if not asset:
        raise HTTPException(404, f"You don't hold any shares of {sym} in your portfolio")
    total_received = round(data.amount_per_share * asset.amount, 4)
    div = Dividend(
        user_id=user_id, symbol=sym, amount_per_share=data.amount_per_share,
        total_received=total_received, ex_date=data.ex_date, pay_date=data.pay_date,
        recorded_at=str(datetime.now().date()),
    )
    session.add(div); session.commit(); session.refresh(div)
    return {
        "id": div.id, "symbol": div.symbol, "amount_per_share": div.amount_per_share,
        "total_received": div.total_received, "shares_at_record": asset.amount,
        "ex_date": div.ex_date, "pay_date": div.pay_date, "recorded_at": div.recorded_at,
    }


@app.get("/dividends/history")
def dividend_history(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    divs = session.exec(
        select(Dividend).where(Dividend.user_id == user_id).order_by(Dividend.pay_date.desc())
    ).all()
    total_received = round(sum(d.total_received for d in divs), 2)
    return {
        "total_received": total_received, "count": len(divs),
        "dividends": [
            {"id": d.id, "symbol": d.symbol, "amount_per_share": d.amount_per_share,
             "total_received": d.total_received, "ex_date": d.ex_date,
             "pay_date": d.pay_date, "recorded_at": d.recorded_at}
            for d in divs
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════════
# SEARCH & HISTORY
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/search")
def search(q: str):
    if not q or len(q.strip()) < 1:
        return []
    return search_symbols(sanitize_search_query(q))


@app.get("/history/{symbol}")
def history(symbol: str, period: str = "1mo"):
    return get_historical_data(sanitize_symbol(symbol), period)


# ═══════════════════════════════════════════════════════════════════════════════
# AI ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/analysis/portfolio")
def ai_portfolio(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_investor(user)
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"analysis": "Your portfolio is empty. Add some assets to get started.", "change_pct": 0.0}

    def fetch(a):
        d = get_asset_data(a.symbol)
        return (a, d) if d else None

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch, assets))

    enriched, total_val = [], 0.0
    for r in results:
        if not r: continue
        a, m = r
        val = m["current_price"] * a.amount
        total_val += val
        enriched.append({"symbol": m["symbol"], "type": m["type"], "value": val, "change_pct": m["percent_change"]})

    if not enriched or total_val <= 0:
        return {"analysis": "Could not compute portfolio performance.", "change_pct": 0.0}

    weighted, ai_assets = 0.0, []
    for item in enriched:
        w = item["value"] / total_val
        weighted += w * item["change_pct"]
        ai_assets.append({"symbol": item["symbol"], "type": item["type"],
                           "allocation_pct": w * 100, "change_pct": item["change_pct"]})
    try:
        text = get_portfolio_ai_analysis(weighted, ai_assets)
    except Exception as e:
        text = f"Analysis temporarily unavailable. ({e})"
    return {"analysis": text, "change_pct": weighted}


@app.get("/analysis/status")
def ai_status():
    return get_ai_status()


@app.get("/analysis/{symbol}")
def ai_asset(
    symbol: str, change: float = 0.0,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_investor(user)
    return {"analysis": get_ai_analysis(sanitize_symbol(symbol), change)}


# ═══════════════════════════════════════════════════════════════════════════════
# TRANSACTIONS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/transactions")
def list_transactions(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    txs = session.exec(
        select(Transaction).where(Transaction.user_id == user_id)
        .order_by(Transaction.id.desc()).limit(100)
    ).all()
    return [
        {"id": t.id, "symbol": t.symbol, "type": t.type, "amount": t.amount,
         "price": t.price, "total_usd": t.total_usd, "realized_pnl": t.realized_pnl, "date": t.date}
        for t in txs
    ]


# ═══════════════════════════════════════════════════════════════════════════════
# STRIPE
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/stripe/create-checkout")
def create_checkout(
    data: CheckoutInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    if has_plan(user, "tax_pro") and data.plan == "tax_pro":
        raise HTTPException(400, "You already have the Tax Pro plan.")
    if has_plan(user, "investor") and data.plan == "investor":
        raise HTTPException(400, "You already have the Investor plan.")

    if data.plan == "tax_pro":
        price_id, plan_label = PRICE_ID_TAX_PRO, "Tax Pro"
    else:
        price_id, plan_label = PRICE_ID_INVESTOR, "Investor"

    if not price_id:
        raise HTTPException(500, f"Stripe not configured (missing STRIPE_PRICE_ID_{data.plan.upper()})")

    success_url = os.getenv("STRIPE_SUCCESS_URL", "https://purp-production.up.railway.app/success")
    cancel_url  = os.getenv("STRIPE_CANCEL_URL",  "https://purp-production.up.railway.app/cancelled")

    try:
        customer_kwargs: dict = {}
        if user.stripe_customer_id:
            customer_kwargs["customer"] = user.stripe_customer_id
        else:
            customer_kwargs["customer_email"] = user.email

        session_obj = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            success_url=f"{success_url}?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=cancel_url,
            metadata={"user_id": str(user_id), "plan": data.plan},
            **customer_kwargs,
        )
        if session_obj.get("customer") and not user.stripe_customer_id:
            user.stripe_customer_id = session_obj["customer"]
            session.add(user); session.commit()
        return {"checkout_url": session_obj.url, "plan": data.plan, "plan_label": plan_label}
    except stripe.StripeError as e:
        msg = getattr(e, "user_message", None) or str(e)
        raise HTTPException(500, f"Payment error: {msg}")


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request, session: Session = Depends(get_session)):
    payload    = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    secret     = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except stripe.SignatureVerificationError:
        raise HTTPException(400, "Invalid webhook signature")
    except Exception:
        raise HTTPException(400, "Webhook processing error")

    event_id = event.get("id")
    if event_id:
        existing = session.get(ProcessedEvent, event_id)
        if existing:
            return {"ok": True}
        session.add(ProcessedEvent(event_id=event_id, processed_at=str(datetime.now())))
        session.commit()

    event_type = event["type"]

    if event_type == "checkout.session.completed":
        obj     = event["data"]["object"]
        meta    = obj.get("metadata", {})
        user_id = int(meta.get("user_id", 0))
        plan    = meta.get("plan", "investor")
        if user_id:
            u = session.get(User, user_id)
            if u:
                u.plan = plan; u.is_premium = True
                if obj.get("subscription"):
                    u.stripe_subscription_id = obj["subscription"]
                if obj.get("customer") and not u.stripe_customer_id:
                    u.stripe_customer_id = obj["customer"]
                session.add(u); session.commit()

    elif event_type in ["customer.subscription.deleted", "customer.subscription.paused"]:
        subscription = event["data"]["object"]
        user_id = None
        meta = subscription.get("metadata", {})
        if meta and "user_id" in meta:
            user_id = int(meta["user_id"])
        if not user_id:
            customer_id = subscription.get("customer")
            if customer_id:
                try:
                    customer = stripe.Customer.retrieve(customer_id)
                    email    = customer.get("email", "").lower().strip()
                    if email:
                        u = session.exec(select(User).where(User.email == email)).first()
                        if u: user_id = u.id
                except Exception as e:
                    print(f"⚠️  Stripe customer retrieve: {e}")
        if user_id:
            u = session.get(User, user_id)
            if u and has_plan(u, "investor", "tax_pro"):
                u.plan = "free"; u.is_premium = False; u.stripe_subscription_id = None
                session.add(u); session.commit()

    elif event_type == "customer.subscription.updated":
        subscription = event["data"]["object"]
        try:
            items = subscription.get("items", {}).get("data", [])
            if items:
                new_price_id = items[0]["price"]["id"]
                new_plan     = PRICE_PLAN_MAP.get(new_price_id)
                if new_plan:
                    customer_id = subscription.get("customer")
                    u = None
                    if customer_id:
                        u = session.exec(select(User).where(User.stripe_customer_id == customer_id)).first()
                    if u:
                        u.plan = new_plan; u.is_premium = True
                        session.add(u); session.commit()
        except Exception as e:
            print(f"⚠️  subscription.updated handler: {e}")

    return {"ok": True}


@app.get("/success")
def payment_success():
    return {"message": "Payment successful! Your plan has been upgraded."}


@app.get("/cancelled")
def payment_cancelled():
    return {"message": "Payment cancelled. Your plan was not changed."}


# ═══════════════════════════════════════════════════════════════════════════════
# HEALTH & DEBUG
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.post("/debug/test-email")
def test_email(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    _send_email(user.email, "Purp email test ✅", "<h1>It works!</h1><p>Email system is configured correctly.</p>")
    return {"sent_to": user.email}


@app.get("/debug")
def debug_db():
    from sqlalchemy import text as sa_text
    result = {
        "db_url_prefix": DATABASE_URL[:40], "is_postgres": _is_postgres,
        "price_plan_map": PRICE_PLAN_MAP, "tables": [], "user_count": None, "error": None,
    }
    try:
        with engine.connect() as conn:
            if _is_postgres:
                rows = conn.execute(sa_text("SELECT tablename FROM pg_tables WHERE schemaname='public'")).fetchall()
            else:
                rows = conn.execute(sa_text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()
            result["tables"] = [r[0] for r in rows]
    except Exception as e:
        result["error"] = str(e); return result
    try:
        with Session(engine) as s:
            result["user_count"] = len(s.exec(select(User)).all())
    except Exception as e:
        result["error"] = str(e)
    return result
