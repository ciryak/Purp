from typing import Optional
from sqlmodel import Field, SQLModel, Relationship

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True)
    password_hash: str
    email: Optional[str] = Field(default=None, index=True, unique=True)
    is_premium: bool = Field(default=False)
    created_at: Optional[str] = None
    # Preferências de notificação
    notification_email: bool = Field(default=True)
    notification_browser: bool = Field(default=True)

class Asset(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    symbol: str
    amount: float
    type: str  # 'stock' ou 'crypto'
    purchase_price: float
    purchase_date: Optional[str] = None
    user_id: int = Field(foreign_key="user.id", index=True)

class Transaction(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key='user.id', index=True)
    symbol: str
    type: str          # 'buy' ou 'sell'
    amount: float
    price: float
    total_usd: float
    realized_pnl: Optional[float] = None
    date: str
    created_at: Optional[str] = None

class PriceAlert(SQLModel, table=True):
    """Alertas de preço para usuários Premium"""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key='user.id', index=True)
    symbol: str
    alert_type: str  # 'price_above', 'price_below', 'percent_change_up', 'percent_change_down'
    target_value: float  # Preço alvo ou percentual
    triggered: bool = Field(default=False)
    triggered_at: Optional[str] = None
    created_at: Optional[str] = None
    active: bool = Field(default=True)
    # Notificação única ou recorrente
    recurring: bool = Field(default=False)

class WatchlistItem(SQLModel, table=True):
    """Items da watchlist customizável do usuário"""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key='user.id', index=True)
    symbol: str
    type: str  # 'stock' ou 'crypto'
    added_at: Optional[str] = None
    # Ordenação customizada
    order_index: int = Field(default=0)

class ProcessedEvent(SQLModel, table=True):
    """Rastreia eventos do Stripe já processados para idempotência"""
    event_id: str = Field(primary_key=True, max_length=255)
    processed_at: str