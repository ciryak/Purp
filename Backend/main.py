"""
Purp — FastAPI backend v5.
Plan tiers:
  free      $0/mo  — 4 assets, 10 watchlist, 2 alerts, 30-day history
  investor  $19/mo — unlimited assets/watchlist/alerts, AI, CSV import, 2-year history
  tax_pro   $29/mo — everything in investor + Tax Loss Harvesting + Form 8949 export
"""
import os
import smtplib
import threading
import concurrent.futures
from datetime import date, datetime, timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from fastapi import FastAPI, HTTPException, Depends, Header, Request, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select, create_engine, SQLModel
from pydantic import BaseModel, EmailStr
import bcrypt
import stripe
from jose import JWTError, jwt

from models import Asset, User, Transaction, PriceAlert, WatchlistItem, ProcessedEvent
from services import (
    get_asset_data,
    get_ai_analysis,
    get_historical_data,
    search_symbols,
    get_portfolio_ai_analysis,
    get_ai_status,
    check_and_trigger_alerts,
)

# ── Config ─────────────────────────────────────────────────────────────────────
SECRET_KEY   = os.getenv("SECRET_KEY", "change-me-in-production-please")
ALGORITHM    = os.getenv("ALGORITHM", "HS256")
TOKEN_EXPIRE = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 10080))

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

_raw_db_url = os.getenv("DATABASE_URL", "sqlite:///database.db")
DATABASE_URL = _raw_db_url.replace("postgres://", "postgresql://")
_is_postgres = DATABASE_URL.startswith("postgresql://")

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
FREE_ASSET_LIMIT       = 4
FREE_WATCHLIST_LIMIT   = 10
FREE_ALERT_LIMIT       = 2
FREE_HISTORY_DAYS      = 30     # 1 month
INVESTOR_HISTORY_DAYS  = 730    # 2 years

# Price IDs for each paid plan (set these in your .env)
PRICE_ID_INVESTOR = os.getenv("STRIPE_PRICE_ID_INVESTOR", "")
PRICE_ID_TAX_PRO  = os.getenv("STRIPE_PRICE_ID_TAX_PRO",  "")

# Mapping price_id → plan name (populated at startup when IDs are present)
def _build_price_plan_map() -> dict[str, str]:
    m: dict[str, str] = {}
    if PRICE_ID_INVESTOR:
        m[PRICE_ID_INVESTOR] = "investor"
    if PRICE_ID_TAX_PRO:
        m[PRICE_ID_TAX_PRO] = "tax_pro"
    return m

PRICE_PLAN_MAP: dict[str, str] = {}   # filled in create_db / startup

# ── SMTP ───────────────────────────────────────────────────────────────────────
SMTP_HOST  = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT  = int(os.getenv("SMTP_PORT", 587))
SMTP_USER  = os.getenv("SMTP_USER", "")
SMTP_PASS  = os.getenv("SMTP_PASS", "")
FROM_EMAIL = os.getenv("FROM_EMAIL", SMTP_USER)


# ── Permission helpers ─────────────────────────────────────────────────────────

def has_plan(user: User, *plans: str) -> bool:
    """Return True if user's current plan is in the given set."""
    return user.plan in plans


def require_investor(user: User) -> None:
    """Raise 402 if user does not have investor or tax_pro plan."""
    if not has_plan(user, "investor", "tax_pro"):
        raise HTTPException(
            402,
            "This feature requires the Investor plan ($19/mo) or higher. "
            "Upgrade to unlock AI analysis, unlimited assets, and more."
        )


def require_tax_pro(user: User) -> None:
    """Raise 402 if user does not have the tax_pro plan."""
    if not has_plan(user, "tax_pro"):
        raise HTTPException(
            402,
            "This feature requires the Tax Pro plan ($29/mo). "
            "Upgrade to unlock Tax Loss Harvesting and Form 8949 export."
        )


# ── Email helpers ──────────────────────────────────────────────────────────────

def _send_email(to_email: str, subject: str, html: str) -> None:
    if not SMTP_USER or not SMTP_PASS:
        print("⚠️  SMTP not configured — skipping email")
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = f"Purp <{FROM_EMAIL}>"
    msg["To"]      = to_email
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
            s.ehlo(); s.starttls(); s.login(SMTP_USER, SMTP_PASS)
            s.sendmail(FROM_EMAIL, to_email, msg.as_string())
        print(f"✅ Email sent → {to_email}")
    except Exception as e:
        print(f"⚠️  Email failed ({to_email}): {e}")


def _send_welcome_email(to_email: str, username: str) -> None:
    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0914;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:48px 16px;">
    <table width="520" cellpadding="0" cellspacing="0"
           style="background:#110f20;border-radius:20px;border:1px solid rgba(124,58,237,.25);overflow:hidden;">
      <tr>
        <td style="background:linear-gradient(135deg,#7c3aed,#a78bfa);padding:40px;text-align:center;">
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Welcome to Purp 🚀</h1>
          <p style="color:rgba(255,255,255,.8);margin:8px 0 0;font-size:13px;">Your AI-powered portfolio tracker</p>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 36px;">
          <p style="color:#f1f0f5;font-size:15px;margin:0 0 14px;">
            Hey <strong style="color:#a78bfa;">{username}</strong> 👋
          </p>
          <p style="color:rgba(241,240,245,.7);font-size:13px;line-height:1.7;margin:0 0 22px;">
            Your account is ready. You can track up to <strong style="color:#fff;">4 assets for free</strong> —
            crypto, stocks and ETFs — all in one place with real-time prices.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
            <tr><td style="background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.25);
                            border-radius:12px;padding:18px;">
              <p style="margin:0 0 10px;color:#a78bfa;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Free Plan — $0/mo</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ Up to 4 assets</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ Real-time prices</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ 10 watchlist items</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ 2 price alerts</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ 30-day history</p>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
            <tr><td style="background:rgba(124,58,237,.07);border:1px solid rgba(124,58,237,.2);
                            border-radius:12px;padding:18px;">
              <p style="margin:0 0 10px;color:#a78bfa;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">⭐ Investor — $19/mo</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ Unlimited assets, watchlist &amp; alerts</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ AI analysis per asset &amp; portfolio</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ CSV import</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ 2-year price history</p>
            </td></tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr><td style="background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.2);
                            border-radius:12px;padding:18px;">
              <p style="margin:0 0 10px;color:#fbbf24;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">💼 Tax Pro — $29/mo</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ Everything in Investor</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ Tax Loss Harvesting</p>
              <p style="margin:3px 0;color:rgba(241,240,245,.8);font-size:12px;">✓ Form 8949 export</p>
            </td></tr>
          </table>
          <p style="color:rgba(241,240,245,.35);font-size:11px;margin:0;text-align:center;">
            Questions? Just reply to this email &nbsp;·&nbsp; Purp team
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""
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
    html = f"""<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0914;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
  <tr><td align="center" style="padding:48px 16px;">
    <table width="520" cellpadding="0" cellspacing="0"
           style="background:#110f20;border-radius:20px;border:1px solid rgba(239,68,68,.35);overflow:hidden;">
      <tr>
        <td style="background:linear-gradient(135deg,#ef4444,#f87171);padding:40px;text-align:center;">
          <div style="font-size:48px;margin-bottom:14px;">{emoji}</div>
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;">Price Alert Triggered!</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 36px;">
          <p style="color:#f1f0f5;font-size:15px;margin:0 0 14px;">
            Hey <strong style="color:#a78bfa;">{username}</strong>,
          </p>
          <p style="color:rgba(241,240,245,.7);font-size:13px;line-height:1.7;margin:0 0 22px;">
            Your alert for <strong style="color:#fff;">{symbol}</strong> has been triggered.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr><td style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);
                            border-radius:12px;padding:18px;text-align:center;">
              <p style="margin:0 0 8px;color:rgba(241,240,245,.5);font-size:11px;text-transform:uppercase;">Alert Condition</p>
              <p style="margin:0;color:#fff;font-size:16px;font-weight:700;">{type_text.get(alert_type, "changed")}</p>
              <p style="margin:12px 0 0;color:rgba(241,240,245,.5);font-size:11px;text-transform:uppercase;">Current Price</p>
              <p style="margin:0;color:#a78bfa;font-size:24px;font-weight:900;">${current:,.2f}</p>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>"""
    _send_email(to_email, f"🔔 Price Alert: {symbol} {type_text.get(alert_type, 'changed')}", html)


def send_welcome_email_async(to_email: str, username: str) -> None:
    threading.Thread(target=_send_welcome_email, args=(to_email, username), daemon=True).start()

def send_alert_email_async(
    to_email: str, username: str, symbol: str,
    alert_type: str, target: float, current: float
) -> None:
    threading.Thread(
        target=_send_alert_email,
        args=(to_email, username, symbol, alert_type, target, current),
        daemon=True,
    ).start()


# ── DB ─────────────────────────────────────────────────────────────────────────
def create_db() -> None:
    global PRICE_PLAN_MAP
    print(f"🗄️  DB: {DATABASE_URL[:50]}…")
    try:
        SQLModel.metadata.create_all(engine)
        print("✅ Tables OK")
    except Exception as e:
        print(f"❌ FATAL table creation failed: {e}")
        raise

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

    # Ensure user #1 is always investor-tier (owner)
    try:
        with Session(engine) as s:
            u = s.get(User, 1)
            if u and u.plan == "free":
                u.plan = "investor"
                u.is_premium = True
                s.add(u); s.commit()
    except Exception as e:
        print(f"⚠️  Owner plan check: {e}")

    PRICE_PLAN_MAP = _build_price_plan_map()
    print(f"💳 Price→plan map: {PRICE_PLAN_MAP}")


# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Purp API", version="5.0", on_startup=[create_db])
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def get_session():
    with Session(engine) as s:
        yield s


def create_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(token: str | None = Header(None, alias="X-Auth-Token")) -> int:
    if not token:
        raise HTTPException(401, "Not authenticated — please log in")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
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
    """Return the max history look-back in days allowed for the user's plan."""
    if has_plan(user, "investor", "tax_pro"):
        return INVESTOR_HISTORY_DAYS
    return FREE_HISTORY_DAYS


# ── Schemas ────────────────────────────────────────────────────────────────────
class RegisterInput(BaseModel):
    username: str
    password: str
    email: EmailStr

class LoginInput(BaseModel):
    username: str
    password: str

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
    symbol: str
    alert_type: str  # 'price_above' | 'price_below' | 'percent_change_up' | 'percent_change_down'
    target_value: float
    recurring: bool = False

class CheckoutInput(BaseModel):
    plan: str = "investor"   # "investor" | "tax_pro"


# ═══════════════════════════════════════════════════════════════════════════════
# AUTH
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/auth/register")
def register(data: RegisterInput, session: Session = Depends(get_session)):
    uname = data.username.strip()
    if len(uname) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(data.password) < 4:
        raise HTTPException(400, "Password must be at least 4 characters")

    try:
        if session.exec(select(User).where(User.username == uname)).first():
            raise HTTPException(400, "Username already taken")
        email_norm = str(data.email).strip().lower()
        if session.exec(select(User).where(User.email == email_norm)).first():
            raise HTTPException(400, "Email already registered")

        user = User(
            username=uname,
            password_hash=hash_pw(data.password),
            email=email_norm,
            plan="free",
            is_premium=False,
            created_at=str(date.today()),
        )
        session.add(user); session.commit(); session.refresh(user)
    except HTTPException:
        raise
    except Exception as e:
        session.rollback()
        raise HTTPException(503, f"Database error during registration: {e}")

    if user.id is None:
        raise HTTPException(500, "Failed to create user — please try again")

    send_welcome_email_async(email_norm, uname)
    return {
        "token": create_token(user.id),
        "user":  _user_payload(user),
    }


@app.post("/auth/login")
def login(data: LoginInput, session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.username == data.username.strip())).first()
    if not user or not verify_pw(data.password, user.password_hash):
        raise HTTPException(401, "Incorrect username or password")
    return {
        "token": create_token(user.id),
        "user":  _user_payload(user),
    }


@app.get("/auth/me")
def auth_me(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return {**_user_payload(user), "email": user.email}


@app.post("/auth/logout")
def logout():
    return {"ok": True}


def _user_payload(user: User) -> dict:
    return {
        "id":         user.id,
        "username":   user.username,
        "plan":       user.plan,
        "is_premium": has_plan(user, "investor", "tax_pro"),   # back-compat field
    }


# ═══════════════════════════════════════════════════════════════════════════════
# WATCHLIST
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/watchlist")
def get_watchlist(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    items = session.exec(
        select(WatchlistItem)
        .where(WatchlistItem.user_id == user_id)
        .order_by(WatchlistItem.order_index)
    ).all()
    if not items:
        return {"items": []}

    def fetch(item: WatchlistItem):
        data = get_asset_data(item.symbol)
        if not data:
            return None
        return {
            "id":            item.id,
            "symbol":        data["symbol"],
            "real_symbol":   data["real_symbol"],
            "name":          data.get("name", data["symbol"]),
            "current_price": data["current_price"],
            "percent_change":data["percent_change"],
            "type":          data["type"],
            "icon":          data.get("icon", ""),
            "added_at":      item.added_at,
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
    symbol = data.symbol.strip().upper()
    existing = session.exec(
        select(WatchlistItem).where(
            WatchlistItem.user_id == user_id, WatchlistItem.symbol == symbol
        )
    ).first()
    if existing:
        raise HTTPException(400, f"{symbol} already in your watchlist")

    user = session.get(User, user_id)
    if not has_plan(user, "investor", "tax_pro"):
        count = len(session.exec(
            select(WatchlistItem).where(WatchlistItem.user_id == user_id)
        ).all())
        if count >= FREE_WATCHLIST_LIMIT:
            raise HTTPException(
                402,
                f"Free plan limited to {FREE_WATCHLIST_LIMIT} watchlist items. "
                "Upgrade to Investor for unlimited."
            )

    asset_data = get_asset_data(symbol)
    if not asset_data:
        raise HTTPException(404, f"Asset '{symbol}' not found")

    item = WatchlistItem(
        user_id=user_id,
        symbol=asset_data["real_symbol"],
        type=asset_data["type"],
        added_at=str(date.today()),
        order_index=0,
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
        select(PriceAlert)
        .where(PriceAlert.user_id == user_id)
        .order_by(PriceAlert.created_at.desc())
    ).all()
    return {"alerts": [
        {
            "id":           a.id,
            "symbol":       a.symbol,
            "alert_type":   a.alert_type,
            "target_value": a.target_value,
            "triggered":    a.triggered,
            "triggered_at": a.triggered_at,
            "active":       a.active,
            "recurring":    a.recurring,
            "created_at":   a.created_at,
        }
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

    if not has_plan(user, "investor", "tax_pro"):
        count = len(session.exec(
            select(PriceAlert).where(
                PriceAlert.user_id == user_id, PriceAlert.active == True
            )
        ).all())
        if count >= FREE_ALERT_LIMIT:
            raise HTTPException(
                402,
                f"Free plan limited to {FREE_ALERT_LIMIT} price alerts. "
                "Upgrade to Investor for unlimited alerts."
            )

    valid_types = ["price_above", "price_below", "percent_change_up", "percent_change_down"]
    if data.alert_type not in valid_types:
        raise HTTPException(400, f"Invalid alert_type. Must be one of: {', '.join(valid_types)}")
    if data.target_value <= 0:
        raise HTTPException(400, "target_value must be positive")

    asset_data = get_asset_data(data.symbol)
    if not asset_data:
        raise HTTPException(404, f"Asset '{data.symbol}' not found")

    alert = PriceAlert(
        user_id=user_id,
        symbol=asset_data["real_symbol"],
        alert_type=data.alert_type,
        target_value=data.target_value,
        recurring=data.recurring,
        created_at=str(datetime.now()),
    )
    session.add(alert); session.commit(); session.refresh(alert)
    return {
        "id":           alert.id,
        "symbol":       alert.symbol,
        "alert_type":   alert.alert_type,
        "target_value": alert.target_value,
        "recurring":    alert.recurring,
    }


@app.delete("/alerts/{alert_id}")
def delete_alert(
    alert_id: int,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    alert = session.get(PriceAlert, alert_id)
    if not alert or alert.user_id != user_id:
        raise HTTPException(404, "Alert not found")
    session.delete(alert); session.commit()
    return {"ok": True}


@app.post("/alerts/{alert_id}/toggle")
def toggle_alert(
    alert_id: int,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    alert = session.get(PriceAlert, alert_id)
    if not alert or alert.user_id != user_id:
        raise HTTPException(404, "Alert not found")
    alert.active = not alert.active
    session.add(alert); session.commit()
    return {"active": alert.active}


@app.post("/alerts/check")
def check_alerts_endpoint(background_tasks: BackgroundTasks):
    background_tasks.add_task(_run_alert_check)
    return {"status": "checking alerts in background"}


def _run_alert_check():
    with Session(engine) as session:
        check_and_trigger_alerts(session, send_alert_email_async)


# ═══════════════════════════════════════════════════════════════════════════════
# ASSETS
# ═══════════════════════════════════════════════════════════════════════════════

@app.post("/assets/")
def create_asset(
    data: AssetInput,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    sym = data.symbol.strip().upper()
    if not sym:
        raise HTTPException(400, "Symbol is required")
    if data.amount <= 0:
        raise HTTPException(400, "Amount must be greater than 0")
    if data.purchase_price <= 0:
        raise HTTPException(400, "Purchase price must be greater than 0")

    m = get_asset_data(sym)
    if not m:
        raise HTTPException(404, f"Asset '{sym}' not found. Check the symbol and try again.")

    real_sym = m["real_symbol"]
    p_date = data.purchase_date if data.purchase_date and len(data.purchase_date) >= 10 else str(date.today())

    existing = session.exec(
        select(Asset).where(Asset.symbol == real_sym, Asset.user_id == user_id)
    ).first()
    if existing:
        total_cost = existing.amount * existing.purchase_price + data.amount * data.purchase_price
        total_qty  = existing.amount + data.amount
        existing.amount = total_qty
        existing.purchase_price = total_cost / total_qty
        session.add(existing)
        session.add(Transaction(
            user_id=user_id, symbol=real_sym, type="buy",
            amount=data.amount, price=data.purchase_price,
            total_usd=data.amount * data.purchase_price,
            date=p_date, created_at=str(date.today()),
        ))
        session.commit(); session.refresh(existing)
        return existing

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")

    if not has_plan(user, "investor", "tax_pro"):
        count = len(session.exec(select(Asset).where(Asset.user_id == user_id)).all())
        if count >= FREE_ASSET_LIMIT:
            raise HTTPException(
                402,
                f"Free plan limit reached ({FREE_ASSET_LIMIT} assets). "
                "Upgrade to Investor for unlimited assets."
            )

    asset = Asset(
        symbol=real_sym, amount=data.amount, type=m["type"],
        purchase_price=data.purchase_price, purchase_date=p_date, user_id=user_id,
    )
    session.add(asset); session.commit()
    session.add(Transaction(
        user_id=user_id, symbol=real_sym, type="buy",
        amount=data.amount, price=data.purchase_price,
        total_usd=data.amount * data.purchase_price,
        date=p_date, created_at=str(date.today()),
    ))
    session.commit(); session.refresh(asset)
    return asset


@app.delete("/assets/{asset_id}")
def delete_asset(
    asset_id: int,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
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
        raise HTTPException(
            400,
            f"For stocks, sell quantity must be a whole number. You entered {data.amount}.",
        )

    m = get_asset_data(asset.symbol)
    current_price = m["current_price"] if m else asset.purchase_price
    sell_total = data.amount * current_price
    pnl = sell_total - data.amount * asset.purchase_price
    new_amt = round(asset.amount - data.amount, 8)

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
# PORTFOLIO
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/portfolio/balance")
def portfolio_balance(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
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
        if not r:
            continue
        a, m = r
        val    = m["current_price"] * a.amount
        profit = val - a.purchase_price * a.amount
        total += val

        days = 0
        if a.purchase_date:
            try:
                days = (
                    date.today() - datetime.strptime(a.purchase_date, "%Y-%m-%d").date()
                ).days
            except Exception:
                pass

        details.append({
            "id":             a.id,
            "symbol":         m["symbol"],
            "real_symbol":    a.symbol,
            "amount":         a.amount,
            "current_price":  m["current_price"],
            "purchase_price": a.purchase_price,
            "position_value": val,
            "profit":         profit,
            "percent_change": m["percent_change"],
            "history":        m["history"],
            "icon":           m.get("icon", ""),
            "days_held":      days,
            "type":           m.get("type", "stock"),
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

    # Enforce history limit for free users
    if not has_plan(user, "investor", "tax_pro"):
        period_day_map = {
            "1d": 1, "5d": 5, "1mo": 30, "3mo": 90,
            "6mo": 180, "1y": 365, "2y": 730,
        }
        requested_days = period_day_map.get(period, 30)
        if requested_days > FREE_HISTORY_DAYS:
            raise HTTPException(
                402,
                f"Free plan history is limited to {FREE_HISTORY_DAYS} days. "
                "Upgrade to Investor to unlock up to 2 years of history."
            )

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"dates": [], "portfolio": [], "benchmark": []}

    series, final_dates = None, []
    for a in assets:
        h = get_historical_data(a.symbol, period)
        if not h["prices"]:
            continue
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
        "benchmark": bench["prices"][: len(final_dates)] if series else [],
    }


@app.get("/portfolio/summary")
def portfolio_summary(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    txs    = session.exec(select(Transaction).where(Transaction.user_id == user_id)).all()
    total_invested = sum(a.amount * a.purchase_price for a in assets)
    realized_pnl   = sum(t.realized_pnl for t in txs if t.realized_pnl is not None)
    return {
        "asset_count":       len(assets),
        "total_invested":    total_invested,
        "realized_pnl":      realized_pnl,
        "transaction_count": len(txs),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# TAX (Tax Pro only)
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/tax/loss-harvesting")
def tax_loss_harvesting(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return positions with unrealised losses suitable for tax-loss harvesting."""
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
        if not r:
            continue
        a, m = r
        current_value  = m["current_price"] * a.amount
        cost_basis     = a.purchase_price * a.amount
        unrealised_pnl = current_value - cost_basis
        if unrealised_pnl < 0:
            opportunities.append({
                "id":              a.id,
                "symbol":          m["symbol"],
                "amount":          a.amount,
                "current_price":   m["current_price"],
                "purchase_price":  a.purchase_price,
                "unrealised_loss": unrealised_pnl,
                "cost_basis":      cost_basis,
            })

    opportunities.sort(key=lambda x: x["unrealised_loss"])
    return {"opportunities": opportunities}


@app.get("/tax/form-8949")
def form_8949_export(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return all sell transactions formatted for IRS Form 8949."""
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_tax_pro(user)

    txs = session.exec(
        select(Transaction).where(
            Transaction.user_id == user_id, Transaction.type == "sell"
        ).order_by(Transaction.date)
    ).all()

    rows = [
        {
            "description":      tx.symbol,
            "date_acquired":    "VARIOUS",
            "date_sold":        tx.date,
            "proceeds":         round(tx.total_usd, 2),
            "cost_basis":       round(tx.amount * (tx.total_usd / tx.amount - (tx.realized_pnl or 0) / tx.amount), 2)
                                if tx.amount else 0,
            "gain_loss":        round(tx.realized_pnl or 0, 2),
            "short_or_long":    "SHORT",   # simplified; proper holding-period logic can be added
        }
        for tx in txs
    ]

    total_proceeds  = sum(r["proceeds"]  for r in rows)
    total_gain_loss = sum(r["gain_loss"] for r in rows)
    return {
        "tax_year":      date.today().year,
        "rows":          rows,
        "total_proceeds":  round(total_proceeds,  2),
        "total_gain_loss": round(total_gain_loss, 2),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# SEARCH & HISTORY
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/search")
def search(q: str):
    if not q or len(q.strip()) < 1:
        return []
    return search_symbols(q.strip())


@app.get("/history/{symbol}")
def history(symbol: str, period: str = "1mo"):
    return get_historical_data(symbol, period)


# ═══════════════════════════════════════════════════════════════════════════════
# AI ANALYSIS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/analysis/portfolio")
def ai_portfolio(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
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
        if not r:
            continue
        a, m = r
        val = m["current_price"] * a.amount
        total_val += val
        enriched.append({
            "symbol": m["symbol"], "type": m["type"],
            "value": val, "change_pct": m["percent_change"],
        })

    if not enriched or total_val <= 0:
        return {"analysis": "Could not compute portfolio performance.", "change_pct": 0.0}

    weighted, ai_assets = 0.0, []
    for item in enriched:
        w = item["value"] / total_val
        weighted += w * item["change_pct"]
        ai_assets.append({
            "symbol":         item["symbol"],
            "type":           item["type"],
            "allocation_pct": w * 100,
            "change_pct":     item["change_pct"],
        })

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
    symbol: str,
    change: float = 0.0,
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    require_investor(user)
    return {"analysis": get_ai_analysis(symbol, change)}


# ═══════════════════════════════════════════════════════════════════════════════
# TRANSACTIONS
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/transactions")
def list_transactions(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    txs = session.exec(
        select(Transaction)
        .where(Transaction.user_id == user_id)
        .order_by(Transaction.id.desc())
        .limit(100)
    ).all()
    return [
        {
            "id":           t.id,
            "symbol":       t.symbol,
            "type":         t.type,
            "amount":       t.amount,
            "price":        t.price,
            "total_usd":    t.total_usd,
            "realized_pnl": t.realized_pnl,
            "date":         t.date,
        }
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

    # Select the correct price ID
    if data.plan == "tax_pro":
        price_id = PRICE_ID_TAX_PRO
        plan_label = "Tax Pro"
    else:
        price_id = PRICE_ID_INVESTOR
        plan_label = "Investor"

    if not price_id:
        raise HTTPException(
            500,
            f"Stripe not configured (missing STRIPE_PRICE_ID_{data.plan.upper()})"
        )

    success_url = os.getenv("STRIPE_SUCCESS_URL", "https://purp-production.up.railway.app/success")
    cancel_url  = os.getenv("STRIPE_CANCEL_URL",  "https://purp-production.up.railway.app/cancelled")

    try:
        # Re-use existing Stripe customer if available, otherwise let Stripe create one
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

        # Persist the Stripe customer ID as soon as we have it
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

    # ── Idempotency ─────────────────────────────────────────────
    event_id = event.get("id")
    if event_id:
        existing = session.get(ProcessedEvent, event_id)
        if existing:
            print(f"⚠️  Event {event_id} already processed at {existing.processed_at}")
            return {"ok": True}
        session.add(ProcessedEvent(event_id=event_id, processed_at=str(datetime.now())))
        session.commit()

    event_type = event["type"]

    # ── checkout.session.completed → assign plan ─────────────────
    if event_type == "checkout.session.completed":
        obj     = event["data"]["object"]
        meta    = obj.get("metadata", {})
        user_id = int(meta.get("user_id", 0))
        plan    = meta.get("plan", "investor")        # "investor" | "tax_pro"

        # Fallback: derive plan from price_id if metadata missing
        if not plan or plan == "investor":
            line_items_price = obj.get("line_items", {})  # may not be expanded
            price_id_from_obj = obj.get("line_items") and None  # expanded only via API
            # Use PRICE_PLAN_MAP as the source of truth
            # (metadata "plan" is reliable; this is just a safety net)

        if user_id:
            u = session.get(User, user_id)
            if u:
                u.plan       = plan
                u.is_premium = True   # back-compat
                # Save subscription / customer IDs if present
                if obj.get("subscription"):
                    u.stripe_subscription_id = obj["subscription"]
                if obj.get("customer") and not u.stripe_customer_id:
                    u.stripe_customer_id = obj["customer"]
                session.add(u); session.commit()
                print(f"✅ User {user_id} upgraded to plan='{plan}'")

    # ── subscription cancelled / paused → downgrade to free ──────
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
                    email = customer.get("email", "").lower().strip()
                    if email:
                        u = session.exec(select(User).where(User.email == email)).first()
                        if u:
                            user_id = u.id
                except Exception as e:
                    print(f"⚠️  Could not retrieve Stripe customer: {e}")

        if user_id:
            u = session.get(User, user_id)
            if u and has_plan(u, "investor", "tax_pro"):
                u.plan            = "free"
                u.is_premium      = False
                u.stripe_subscription_id = None
                session.add(u); session.commit()
                print(f"✅ User {user_id} downgraded to free (event: {event_type})")
        else:
            print(f"⚠️  Could not find user for subscription event {event_type}")

    # ── subscription updated (e.g. upgrade investor → tax_pro) ───
    elif event_type == "customer.subscription.updated":
        subscription = event["data"]["object"]
        # Determine the new plan from the first subscription item's price
        try:
            items = subscription.get("items", {}).get("data", [])
            if items:
                new_price_id = items[0]["price"]["id"]
                new_plan = PRICE_PLAN_MAP.get(new_price_id)
                if new_plan:
                    customer_id = subscription.get("customer")
                    u = None
                    if customer_id:
                        u = session.exec(
                            select(User).where(User.stripe_customer_id == customer_id)
                        ).first()
                    if u:
                        u.plan       = new_plan
                        u.is_premium = True
                        session.add(u); session.commit()
                        print(f"✅ User {u.id} plan updated to '{new_plan}'")
        except Exception as e:
            print(f"⚠️  subscription.updated handler error: {e}")

    return {"ok": True}


@app.get("/success")
def payment_success():
    return {"message": "Payment successful! Your plan has been upgraded. Please reload the extension."}


@app.get("/cancelled")
def payment_cancelled():
    return {"message": "Payment cancelled. Your plan was not changed."}


# ═══════════════════════════════════════════════════════════════════════════════
# HEALTH & DEBUG
# ═══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


@app.get("/debug")
def debug_db():
    from sqlalchemy import text as sa_text
    result = {
        "db_url_prefix": DATABASE_URL[:40],
        "is_postgres":   _is_postgres,
        "price_plan_map":PRICE_PLAN_MAP,
        "tables":        [],
        "user_count":    None,
        "error":         None,
    }
    try:
        with engine.connect() as conn:
            if _is_postgres:
                rows = conn.execute(
                    sa_text("SELECT tablename FROM pg_tables WHERE schemaname='public'")
                ).fetchall()
            else:
                rows = conn.execute(
                    sa_text("SELECT name FROM sqlite_master WHERE type='table'")
                ).fetchall()
            result["tables"] = [r[0] for r in rows]
    except Exception as e:
        result["error"] = str(e); return result

    try:
        with Session(engine) as s:
            result["user_count"] = len(s.exec(select(User)).all())
    except Exception as e:
        result["error"] = str(e)

    return result