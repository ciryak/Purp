from typing import Optional
from datetime import datetime
from sqlmodel import Field, SQLModel, Relationship

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True)
    password_hash: str
    email: Optional[str] = Field(default=None, index=True, unique=True)
    full_name: Optional[str] = Field(default=None)

    # Locale and currency for dashboard
    locale: Optional[str] = Field(default="pt-BR")
    currency: Optional[str] = Field(default="BRL")

    # ── Plan management ──────────────────────────────────────────
    plan: str = Field(default="free")                          # "free" | "investor" | "tax_pro"
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    plan_expires_at: Optional[datetime] = Field(default=None)

    # Kept for backward-compat; derived from plan at runtime — do NOT rely on it for gate checks
    is_premium: bool = Field(default=False)

    # ── Email verification ───────────────────────────────────────
    is_verified: bool = Field(default=False)

    created_at: Optional[str] = None

    # Notification preferences
    notification_email: bool = Field(default=True)
    notification_digest: bool = Field(default=True)
    notification_browser: bool = Field(default=True)

    # Referral / indication
    referral_code: Optional[str] = Field(default=None, unique=True, index=True)
    referred_by_id: Optional[int] = Field(default=None)


class UserSession(SQLModel, table=True):
    """Active sessions per device (jti from JWT)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    jti: str = Field(unique=True, index=True, max_length=64)
    created_at: str = Field()  # ISO datetime
    user_agent: Optional[str] = Field(default=None)


class RevokedJti(SQLModel, table=True):
    """Blacklist of revoked JWT IDs (logout, revoke session)."""
    jti: str = Field(primary_key=True, max_length=64)


class InvestmentGoal(SQLModel, table=True):
    """User investment goals (e.g. target value by date)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    label: str = Field()
    target_value: float = Field()
    target_date: Optional[str] = Field(default=None)  # ISO date
    created_at: Optional[str] = Field(default=None)


class EmailVerification(SQLModel, table=True):
    """6-digit email verification codes for new accounts."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    code: str = Field(max_length=6)
    expires_at: str   # ISO datetime string
    used: bool = Field(default=False)
    created_at: str


class Asset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    symbol: str
    amount: float
    type: str  # 'stock' | 'crypto'
    purchase_price: float
    purchase_date: Optional[str] = None
    user_id: int = Field(foreign_key="user.id", index=True)


class Transaction(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    symbol: str
    type: str           # 'buy' | 'sell'
    amount: float
    price: float
    total_usd: float
    realized_pnl: Optional[float] = None
    date: str
    created_at: Optional[str] = None


class PriceAlert(SQLModel, table=True):
    """Price alerts for paid users."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    symbol: Optional[str] = Field(default=None)
    alert_type: str   # basic + advanced alert types
    target_value: float
    rsi_period: Optional[int] = Field(default=14)
    rebalance_threshold_pct: Optional[float] = None
    target_allocation_pct: Optional[float] = None
    triggered: bool = Field(default=False)
    triggered_at: Optional[str] = None
    created_at: Optional[str] = None
    active: bool = Field(default=True)
    recurring: bool = Field(default=False)


class WatchlistItem(SQLModel, table=True):
    """User-customisable watchlist."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    symbol: str
    type: str  # 'stock' | 'crypto'
    added_at: Optional[str] = None
    order_index: int = Field(default=0)


class ProcessedEvent(SQLModel, table=True):
    """Stripe idempotency — tracks already-processed webhook events."""
    event_id: str = Field(primary_key=True, max_length=255)
    processed_at: str


class Dividend(SQLModel, table=True):
    """Records dividend payments received by the user."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    symbol: str
    amount_per_share: float
    total_received: float
    ex_date: str
    pay_date: str
    recorded_at: str


class NetWorthEntry(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    category: str  # "real_estate", "cash", "vehicle", "other_assets", "debt"
    label: str
    value: float   # positive for assets, negative for debts
    updated_at: str


class PasswordResetToken(SQLModel, table=True):
    """Token único para redefinição de senha por link no email."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    token: str = Field(unique=True, index=True, max_length=64)
    expires_at: str   # ISO datetime
    used: bool = Field(default=False)
    created_at: str
