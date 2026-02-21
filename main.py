from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select, create_engine, SQLModel
from pydantic import BaseModel, EmailStr
import concurrent.futures
from datetime import date, datetime
import pandas as pd
import hashlib
import secrets
import bcrypt
import stripe
from models import Asset, User
from jose import JWTError, jwt
from datetime import datetime, timedelta
from models import Asset, User, Transaction
from services import get_asset_data, get_ai_analysis, get_historical_data, search_symbols, get_portfolio_ai_analysis

SECRET_KEY = os.getenv('SECRET_KEY', 'fallback-inseguro')
ALGORITHM = os.getenv('ALGORITHM', 'HS256')
TOKEN_EXPIRE = int(os.getenv('ACCESS_TOKEN_EXPIRE_MINUTES', 10080))
stripe.api_key = os.getenv('STRIPE_SECRET_KEY')



sqlite_file_name = "database.db"
engine = create_engine(f"sqlite:///{sqlite_file_name}", connect_args={"check_same_thread": False})

# Armazena tokens de sessão (em produção, usar Redis ou JWT)
active_sessions: dict[str, int] = {}  # token -> user_id

FREE_ASSET_LIMIT = 4

def create_db():
    SQLModel.metadata.create_all(engine)
    # Melhor esforço: reforça unicidade de email no SQLite (pode falhar se já houver duplicados)
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql('CREATE UNIQUE INDEX IF NOT EXISTS ix_user_email_unique ON "user"(email)')
            conn.commit()
    except:
        pass
    # Garante que o usuário id=1 (se existir) seja Premium
    try:
        with Session(engine) as s:
            u = s.get(User, 1)
            if u and not u.is_premium:
                u.is_premium = True
                s.add(u)
                s.commit()
    except:
        pass
app = FastAPI(on_startup=[create_db])

app.add_middleware(
    CORSMiddleware,
    # ANTES:
    allow_origins=["*"],

    # DEPOIS (em desenvolvimento pode deixar com * temporariamente):
    # Em producao, use o dominio real da sua extensao ou do seu app:
    #allow_origins=["chrome-extension://SEU_ID_DA_EXTENSAO", "https://seusite.com"],

    allow_methods=["*"],
    allow_headers=["*"],
)

def get_session():
    with Session(engine) as s: yield s

def create_token(user_id: int) -> str:
    expire = datetime.utcnow() + timedelta(minutes=TOKEN_EXPIRE)
    data = {'sub': str(user_id), 'exp': expire}
    return jwt.encode(data, SECRET_KEY, algorithm=ALGORITHM)

def get_current_user(token: str | None = Header(None, alias='X-Auth-Token')) -> int:
    if not token:
        raise HTTPException(401, 'Nao autenticado')
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get('sub'))
        return user_id
    except (JWTError, ValueError, TypeError):
        raise HTTPException(401, 'Token invalido ou expirado')


def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode(), salt).decode()

def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode(), password_hash.encode())


# ========== AUTENTICAÇÃO ==========

class LoginInput(BaseModel):
    username: str
    password: str

class RegisterInput(BaseModel):
    username: str
    password: str
    email: EmailStr

@app.post("/auth/register")
def register(data: RegisterInput, session: Session = Depends(get_session)):
    """Registra novo usuário"""
    existing = session.exec(select(User).where(User.username == data.username)).first()
    if existing:
        raise HTTPException(400, "Usuário já existe")

    email_norm = str(data.email).strip().lower()
    if not email_norm:
        raise HTTPException(400, "Email é obrigatório")

    existing_email = session.exec(select(User).where(User.email == email_norm)).first()
    if existing_email:
        raise HTTPException(400, "Email já cadastrado")
    
    user = User(
        username=data.username,
        password_hash=hash_password(data.password),
        email=email_norm,
        is_premium=False,
        created_at=str(date.today())
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    
    # Auto-login após registro
    if user.id is None:
        raise HTTPException(500, "Erro ao criar usuário")
    token = create_token(user.id)
    
    
    return {
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "is_premium": user.is_premium
        }
    }

@app.post("/auth/login")
def login(data: LoginInput, session: Session = Depends(get_session)):
    """Login e retorna token"""
    user = session.exec(select(User).where(User.username == data.username)).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(401, "Credenciais inválidas")
    
    if user.id is None:
        raise HTTPException(500, "Erro ao recuperar usuário")
    token = create_token(user.id)
    
    
    return {
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "is_premium": user.is_premium
        }
    }

@app.get("/auth/me")
def get_current_user_info(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Retorna informações do usuário logado"""
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado")
    return {
        "id": user.id,
        "username": user.username,
        "is_premium": user.is_premium,
        "email": user.email
    }

@app.post('/auth/logout')
def logout():
    return {'ok': True}  # o frontend apaga o token localmente


# ========== ASSET MANAGEMENT ==========

class AssetInput(BaseModel):
    symbol: str
    amount: float
    purchase_price: float
    purchase_date: str | None = None

class SellInput(BaseModel):
    amount: float

@app.post("/assets/")
def create_asset(data: AssetInput, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Cria ou atualiza ativo do usuário"""
    m_data = get_asset_data(data.symbol)
    if not m_data: 
        m_data = get_asset_data(f"{data.symbol}-USD")
    if not m_data: 
        raise HTTPException(404, "Ativo não encontrado")

    p_date = data.purchase_date if (data.purchase_date and len(data.purchase_date) >= 10) else str(date.today())
    real_symbol = m_data["real_symbol"]

    # Busca ativo existente DO MESMO USUÁRIO
    existing = session.exec(
        select(Asset).where(Asset.symbol == real_symbol, Asset.user_id == user_id)
    ).first()
    
    if existing:
        total_cost = (existing.amount * existing.purchase_price) + (data.amount * data.purchase_price)
        total_qty = existing.amount + data.amount
        existing.amount = total_qty
        existing.purchase_price = total_cost / total_qty if total_qty > 0 else 0
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing

    # Limite de ativos para não-premium (somente para criação de novo ativo)
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado")
    if not user.is_premium:
        current_assets = session.exec(select(Asset.id).where(Asset.user_id == user_id)).all()
        if len(current_assets) >= FREE_ASSET_LIMIT:
            raise HTTPException(
                status_code=402,
                detail=f"Recurso premium: plano grátis permite acompanhar até {FREE_ASSET_LIMIT} ativos. Vire Premium por US$ 15/mês."
            )
    
    new_asset = Asset(
        symbol=real_symbol,
        amount=data.amount,
        type=m_data['type'],
        purchase_price=data.purchase_price,
        purchase_date=p_date,
        user_id=user_id
    )
    session.add(new_asset)
    session.commit()
    transaction = Transaction(
        user_id=user_id,
        symbol=real_symbol,
        type='buy',
        amount=data.amount,
        price=data.purchase_price,
        total_usd=data.amount * data.purchase_price,
        date=p_date,
        created_at=str(date.today())
    )
    session.add(transaction)
    session.commit()

    session.refresh(new_asset)
    return new_asset

@app.get("/portfolio/balance")
def get_balance(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Retorna carteira do usuário logado"""
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    details = []
    total = 0.0

    def process(a):
        d = get_asset_data(a.symbol)
        return (a, d) if d else None

    with concurrent.futures.ThreadPoolExecutor() as ex:
        results = list(ex.map(process, assets))

    for res in results:
        if not res: continue
        asset, m_data = res
        
        val = m_data['current_price'] * asset.amount
        profit = val - (asset.purchase_price * asset.amount)
        total += val
        
        days = 0
        if asset.purchase_date:
            try: 
                days = (date.today() - datetime.strptime(asset.purchase_date, "%Y-%m-%d").date()).days
            except: pass

        details.append({
            "id": asset.id,
            "symbol": m_data['symbol'],
            "real_symbol": asset.symbol,
            "amount": asset.amount,
            "current_price": m_data['current_price'],
            "purchase_price": asset.purchase_price,
            "position_value": val,
            "profit": profit,
            "percent_change": m_data['percent_change'],
            "history": m_data['history'],
            "icon": m_data.get('icon', ''),
            "days_held": days
        })

    return {"total_balance_usd": total, "assets": details}

@app.post("/assets/{asset_id}/sell")
def sell_asset(asset_id: int, data: SellInput, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Vende ativo do usuário"""
    asset = session.get(Asset, asset_id)
    if not asset: 
        raise HTTPException(404, "Ativo não existe")
    if asset.user_id != user_id:
        raise HTTPException(403, "Acesso negado")
    
    if data.amount <= 0: 
        raise HTTPException(400, "Qtd inválida")
    
    new_amount = round(asset.amount - data.amount, 8)
    
    if new_amount <= 0:
        session.delete(asset)
        status = "sold_all"
    else:
        asset.amount = new_amount
        session.add(asset)
        status = "partial"
        # Calcula o lucro/prejuizo realizado
        sell_total = data.amount * m_data['current_price']  # valor recebido
        cost_basis = data.amount * asset.purchase_price      # quanto custou
        pnl = sell_total - cost_basis

        transaction = Transaction(
            user_id=user_id,
            symbol=asset.symbol,
            type='sell',
            amount=data.amount,
            price=m_data['current_price'],
            total_usd=sell_total,
            realized_pnl=pnl,
            date=str(date.today()),
            created_at=str(date.today())
        )
    session.add(transaction)

    session.commit()
    return {"status": status, "remaining": new_amount}

@app.get("/search")
def search(q: str): 
    return search_symbols(q)

@app.get("/analysis/{symbol}")
def ai(symbol: str, change: float, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Análise IA (premium-only)"""
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado")
    if not user.is_premium:
        raise HTTPException(
            status_code=402,
            detail="Recurso premium: sistema de IA disponível apenas no Premium. Vire Premium por US$ 15/mês."
        )
    return {"analysis": get_ai_analysis(symbol, change)}


@app.get("/analysis/portfolio")
def portfolio_ai(user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Análise IA da carteira inteira (premium-only)."""
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado")
    if not user.is_premium:
        raise HTTPException(
            status_code=402,
            detail="Recurso premium: análise consolidada da carteira disponível apenas no Premium. Vire Premium por US$ 15/mês."
        )

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return {"analysis": "Sua carteira está vazia. Adicione alguns ativos para que a IA possa analisar.", "change_pct": 0.0}

    # Busca dados de mercado atuais de forma concorrente
    def process(a: Asset):
        d = get_asset_data(a.symbol)
        return (a, d) if d else None

    with concurrent.futures.ThreadPoolExecutor() as ex:
        results = list(ex.map(process, assets))

    enriched = []
    total_value = 0.0
    for res in results:
        if not res:
            continue
        a, m_data = res
        value = m_data["current_price"] * a.amount
        total_value += value
        enriched.append(
            {
                "symbol": m_data["symbol"],
                "type": m_data["type"],
                "value": value,
                "change_pct": m_data["percent_change"],
            }
        )

    if total_value <= 0 or not enriched:
        return {
            "analysis": "Não foi possível calcular a variação da carteira nas últimas 24 horas.",
            "change_pct": 0.0,
        }

    # Variação aproximada da carteira: média ponderada pela participação de cada ativo
    weighted_change = 0.0
    assets_for_ai: list[dict] = []
    for item in enriched:
        weight = item["value"] / total_value
        weighted_change += weight * item["change_pct"]
        assets_for_ai.append(
            {
                "symbol": item["symbol"],
                "type": item["type"],
                "allocation_pct": weight * 100.0,
                "change_pct": item["change_pct"],
            }
        )

    try:
        analysis_text = get_portfolio_ai_analysis(weighted_change, assets_for_ai)
    except Exception as e:
        analysis_text = f"Não foi possível gerar a análise no momento. Tente novamente. ({str(e)})"
    return {
        "analysis": analysis_text,
        "change_pct": weighted_change,
    }

@app.get("/portfolio/history")
def get_portfolio_history(
    period: str = "1mo", 
    benchmark: str = "^GSPC", 
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    """Histórico da carteira do usuário"""
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets: 
        return {"dates": [], "portfolio": [], "benchmark": []}

    portfolio_series = None
    final_dates = []

    for asset in assets:
        hist_data = get_historical_data(asset.symbol, period)
        if not hist_data['prices']: 
            continue
        
        prices = [p * asset.amount for p in hist_data['prices']]
        
        if portfolio_series is None:
            portfolio_series = prices
            final_dates = hist_data['dates']
        else:
            min_len = min(len(portfolio_series), len(prices))
            portfolio_series = [portfolio_series[i] + prices[i] for i in range(min_len)]
            final_dates = final_dates[:min_len]

    bench_data = get_historical_data(benchmark, period)
    
    return {
        "dates": final_dates if portfolio_series else [],
        "portfolio": portfolio_series if portfolio_series else [],
        "benchmark": bench_data['prices'][:len(final_dates)] if portfolio_series else []
    }

@app.get("/history/{symbol}")
def hist(symbol: str, period: str = "1mo"): 
    return get_historical_data(symbol, period)

@app.post('/stripe/create-checkout')
def create_checkout(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, 'Usuario nao encontrado')
    checkout = stripe.checkout.Session.create(
        payment_method_types=['card'],
        line_items=[{
            'price': os.getenv('STRIPE_PRICE_ID'),
            'quantity': 1
        }],
        mode='subscription',
        success_url='http://localhost:8000/sucesso?session_id={CHECKOUT_SESSION_ID}',
        cancel_url='http://localhost:8000/cancelado',
        metadata={'user_id': str(user_id)}
    )
    return {'checkout_url': checkout.url}





@app.get('/transactions')
def list_transactions(
    user_id: int = Depends(get_current_user),
    session: Session = Depends(get_session)
):
    txs = session.exec(
        select(Transaction)
        .where(Transaction.user_id == user_id)
        .order_by(Transaction.id.desc())
        .limit(50)
    ).all()
    return [{
        'id': t.id,
        'symbol': t.symbol,
        'type': t.type,
        'amount': t.amount,
        'price': t.price,
        'total_usd': t.total_usd,
        'realized_pnl': t.realized_pnl,
        'date': t.date
    } for t in txs]


@app.delete("/assets/{asset_id}")
def delete(asset_id: int, user_id: int = Depends(get_current_user), session: Session = Depends(get_session)):
    """Deleta ativo do usuário"""
    asset = session.get(Asset, asset_id)
    if asset and asset.user_id == user_id:
        session.delete(asset)
        session.commit()
    return {"ok": True}
