from typing import Optional
from sqlmodel import Field, SQLModel, Relationship

class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True)
    password_hash: str  # Em produção, usar bcrypt
    # Mantém Optional para compatibilidade com DB existente,
    # mas o backend passa a exigir email no registro.
    email: Optional[str] = Field(default=None, index=True, unique=True)
    is_premium: bool = Field(default=False)
    created_at: Optional[str] = None

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
    amount: float      # quantidade
    price: float       # preco na hora da operacao
    total_usd: float   # amount * price
    realized_pnl: Optional[float] = None  # lucro/prejuizo realizado (so em vendas)
    date: str          # data da operacao (YYYY-MM-DD)
    created_at: Optional[str] = None

class PriceAlert(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key='user.id')
    symbol: str
    target_price: float
    direction: str   # 'above' ou 'below'
    triggered: bool = Field(default=False)
