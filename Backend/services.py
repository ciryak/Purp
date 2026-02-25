"""
Purp — Data & AI services v5.
Novidades:
  - Binance API substituiu CoinGecko para maior estabilidade e sem rate-limits
  - generate_form_8949: motor IRS Form 8949 (Part I / II, FIFO/HIFO/LIFO)
  - Mantidas todas as funções anteriores com mesma assinatura pública
"""
import os
import csv
import io
import threading
import time
import yfinance as yf
from google import genai
import requests
from datetime import datetime, date, timedelta,timezone
from dotenv import load_dotenv
from sqlmodel import select

from models import Asset, Dividend, PriceAlert, Transaction, User

load_dotenv()

# ── Gemini ─────────────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
_gemini_client = None
_gemini_status = "missing_api_key"

try:
    if GEMINI_API_KEY and "YOUR_KEY" not in GEMINI_API_KEY and len(GEMINI_API_KEY) > 10:
        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        _gemini_status = "ok"
        print("✅ Gemini client initialized")
    else:
        print("⚠️  GEMINI_API_KEY/GOOGLE_API_KEY not set — AI features disabled")
except Exception as e:
    _gemini_status = f"init_error: {e}"
    print(f"⚠️  Gemini init error: {e}")
    _gemini_client = None

# ── Price cache (60 s TTL) ─────────────────────────────────────────────────────
_price_cache: dict[str, tuple[dict, float]] = {}
_price_cache_lock = threading.Lock()
_PRICE_TTL = 60


def _cache_get(key: str) -> dict | None:
    with _price_cache_lock:
        entry = _price_cache.get(key)
        if entry and time.time() - entry[1] < _PRICE_TTL:
            return entry[0]
    return None


def _cache_set(key: str, value: dict) -> None:
    with _price_cache_lock:
        _price_cache[key] = (value, time.time())


# ══════════════════════════════════════════════════════════════════════════════
# BINANCE  (substitui CoinGecko)
# ══════════════════════════════════════════════════════════════════════════════

_BINANCE_BASE    = "https://api.binance.com"
_BINANCE_HEADERS = {"User-Agent": "Purp/2.0", "Accept": "application/json"}

# Set of base assets trading against USDT on Binance
_binance_usdt_assets: set[str] = set()
_binance_pairs_loaded  = False
_binance_pairs_lock    = threading.Lock()

# Icon CDN — free, no API key (CoinCap)
_ICON_BASE = "https://assets.coincap.io/assets/icons/{}@2x.png"

# Hard-coded popular coin metadata (name + icon) so we don't need CoinGecko search
_COIN_META: dict[str, dict] = {
    "BTC":  {"name": "Bitcoin",       "id": "btc"},
    "ETH":  {"name": "Ethereum",      "id": "eth"},
    "SOL":  {"name": "Solana",        "id": "sol"},
    "BNB":  {"name": "BNB",           "id": "bnb"},
    "XRP":  {"name": "XRP",           "id": "xrp"},
    "ADA":  {"name": "Cardano",       "id": "ada"},
    "DOGE": {"name": "Dogecoin",      "id": "doge"},
    "AVAX": {"name": "Avalanche",     "id": "avax"},
    "DOT":  {"name": "Polkadot",      "id": "dot"},
    "LINK": {"name": "Chainlink",     "id": "link"},
    "MATIC":{"name": "Polygon",       "id": "matic"},
    "SHIB": {"name": "Shiba Inu",     "id": "shib"},
    "LTC":  {"name": "Litecoin",      "id": "ltc"},
    "UNI":  {"name": "Uniswap",       "id": "uni"},
    "ATOM": {"name": "Cosmos",        "id": "atom"},
    "XLM":  {"name": "Stellar",       "id": "xlm"},
    "ETC":  {"name": "Ethereum Classic","id": "etc"},
    "NEAR": {"name": "NEAR Protocol", "id": "near"},
    "APT":  {"name": "Aptos",         "id": "apt"},
    "ARB":  {"name": "Arbitrum",      "id": "arb"},
    "OP":   {"name": "Optimism",      "id": "op"},
    "INJ":  {"name": "Injective",     "id": "inj"},
    "SUI":  {"name": "Sui",           "id": "sui"},
    "TRX":  {"name": "TRON",          "id": "trx"},
    "SAND": {"name": "The Sandbox",   "id": "sand"},
    "MANA": {"name": "Decentraland",  "id": "mana"},
    "FTM":  {"name": "Fantom",        "id": "ftm"},
    "ALGO": {"name": "Algorand",      "id": "algo"},
    "AAVE": {"name": "Aave",          "id": "aave"},
    "COMP": {"name": "Compound",      "id": "comp"},
    "MKR":  {"name": "Maker",         "id": "mkr"},
    "HBAR": {"name": "Hedera",        "id": "hbar"},
    "VET":  {"name": "VeChain",       "id": "vet"},
    "THETA":{"name": "Theta Network", "id": "theta"},
    "GRT":  {"name": "The Graph",     "id": "grt"},
}

_KNOWN_STOCKS = {
    "AAPL","MSFT","GOOGL","GOOG","AMZN","TSLA","NVDA","META","NFLX",
    "AMD","INTC","ORCL","IBM","CRM","ADBE","PYPL","SQ","SHOP",
    "BABA","JD","PDD","TCEHY","BIDU","NIO","LI","XPEV",
    "BRK.B","JPM","BAC","GS","MS","WFC","C","V","MA","COIN",
    "SPY","QQQ","IWM","GLD","SLV","USO","TLT","VTI","ARKK",
    "^GSPC","^IXIC","^DJI","^BVSP","^FTSE","^N225",
}


def _load_binance_pairs() -> None:
    """Fetch all USDT spot trading pairs from Binance Exchange Info (once at startup)."""
    global _binance_usdt_assets, _binance_pairs_loaded
    with _binance_pairs_lock:
        if _binance_pairs_loaded:
            return
        try:
            r = requests.get(
                f"{_BINANCE_BASE}/api/v3/exchangeInfo",
                headers=_BINANCE_HEADERS,
                timeout=12,
            )
            r.raise_for_status()
            symbols = r.json().get("symbols", [])
            _binance_usdt_assets = {
                s["baseAsset"].upper()
                for s in symbols
                if s.get("quoteAsset") == "USDT" and s.get("status") == "TRADING"
            }
            _binance_pairs_loaded = True
            print(f"✅ Binance: loaded {len(_binance_usdt_assets)} USDT pairs")
        except Exception as e:
            print(f"⚠️  Binance exchangeInfo failed: {e} — will retry on first price call")


# Kick off pair loading in a background thread on import
threading.Thread(target=_load_binance_pairs, daemon=True).start()


def _is_binance_crypto(symbol: str) -> bool:
    """True if symbol trades as {symbol}USDT on Binance."""
    sym = symbol.upper().strip()
    if not _binance_pairs_loaded:
        _load_binance_pairs()
    return sym in _binance_usdt_assets


def _is_likely_stock(symbol: str) -> bool:
    s = symbol.upper().strip()
    if s in _KNOWN_STOCKS:
        return True
    if s.startswith("^"):
        return True
    if "." in s:
        return True
    return False


def _pct_from_series(series: list[float]) -> float:
    if len(series) < 2 or series[0] <= 0:
        return 0.0
    return ((series[-1] - series[0]) / series[0]) * 100


# ── Binance price ──────────────────────────────────────────────────────────────

def _binance_price(symbol: str) -> tuple[float | None, float | None]:
    """Return (price_usd, change_24h_pct) from Binance 24 h ticker."""
    sym  = symbol.upper().strip()
    pair = f"{sym}USDT"

    cached = _cache_get(f"bnb_price_{sym}")
    if cached:
        return cached.get("price"), cached.get("change")

    try:
        r = requests.get(
            f"{_BINANCE_BASE}/api/v3/ticker/24hr",
            params={"symbol": pair},
            headers=_BINANCE_HEADERS,
            timeout=5,
        )
        r.raise_for_status()
        d     = r.json()
        price  = float(d["lastPrice"])
        change = float(d["priceChangePercent"])
        if price > 0:
            _cache_set(f"bnb_price_{sym}", {"price": price, "change": change})
        return price, change
    except Exception as e:
        print(f"⚠️  Binance price '{sym}': {e}")
        return None, None


def _binance_mini_ticker_batch(symbols: list[str]) -> dict[str, dict]:
    """
    Fetch prices for multiple symbols at once using the bookTicker endpoint.
    Returns {SYMBOL: {price, change}} dict.
    """
    try:
        r = requests.get(
            f"{_BINANCE_BASE}/api/v3/ticker/24hr",
            headers=_BINANCE_HEADERS,
            timeout=10,
        )
        r.raise_for_status()
        result = {}
        for d in r.json():
            if not d["symbol"].endswith("USDT"):
                continue
            base = d["symbol"][:-4]
            if base in symbols:
                result[base] = {
                    "price":  float(d["lastPrice"]),
                    "change": float(d["priceChangePercent"]),
                }
        return result
    except Exception as e:
        print(f"⚠️  Binance batch ticker: {e}")
        return {}


def _binance_klines(
    symbol: str,
    interval: str = "1h",
    limit: int = 48,
) -> list[float]:
    """Return list of close prices from Binance klines."""
    sym  = symbol.upper().strip()
    pair = f"{sym}USDT"
    try:
        r = requests.get(
            f"{_BINANCE_BASE}/api/v3/klines",
            params={"symbol": pair, "interval": interval, "limit": limit},
            headers=_BINANCE_HEADERS,
            timeout=8,
        )
        r.raise_for_status()
        return [float(k[4]) for k in r.json()]   # k[4] = close price
    except Exception as e:
        print(f"⚠️  Binance klines '{sym}': {e}")
        return []


def _binance_history(symbol: str, days: int) -> dict:
    """Return {dates: [...], prices: [...]} from Binance klines."""
    sym  = symbol.upper().strip()
    pair = f"{sym}USDT"

    if days <= 1:
        interval, limit, fmt = "15m", 96, "%H:%M"
    elif days <= 7:
        interval, limit, fmt = "1h", days * 24, "%m/%d %H:%M"
    elif days <= 90:
        interval, limit, fmt = "1d", days, "%m/%d"
    elif days <= 365:
        interval, limit, fmt = "1d", days, "%m/%d"
    else:
        interval, limit, fmt = "3d", min(days // 3, 1000), "%m/%d/%y"

    try:
        r = requests.get(
            f"{_BINANCE_BASE}/api/v3/klines",
            params={"symbol": pair, "interval": interval, "limit": limit},
            headers=_BINANCE_HEADERS,
            timeout=10,
        )
        r.raise_for_status()
        dates, prices = [], []
        for k in r.json():
            ts = int(k[0]) / 1000
            dates.append(datetime.fromtimestamp(ts).strftime(fmt))
            prices.append(float(k[4]))
        return {"dates": dates, "prices": prices}
    except Exception as e:
        print(f"⚠️  Binance history '{sym}': {e}")
        return {"dates": [], "prices": []}


def _coin_icon(symbol: str) -> str:
    """Return icon URL for a crypto symbol (CoinCap CDN, free / no key)."""
    meta = _COIN_META.get(symbol.upper(), {})
    coin_id = meta.get("id") or symbol.lower()
    return _ICON_BASE.format(coin_id)


# ── Public API ─────────────────────────────────────────────────────────────────

def get_asset_data(symbol: str) -> dict | None:
    """Fetch current price, 24 h change, sparkline, name and icon for any asset."""
    if not symbol:
        return None

    symbol = symbol.upper().strip()
    base   = symbol.replace("-USD", "").strip()

    cached = _cache_get(f"asset_{base}")
    if cached:
        return cached

    # ── 1) Binance for crypto ──────────────────────────────────────────────────
    if not _is_likely_stock(base) and _is_binance_crypto(base):
        try:
            price, change = _binance_price(base)
            if price and price > 0:
                spark  = _binance_klines(base, interval="1h", limit=40)
                meta   = _COIN_META.get(base, {})
                result = {
                    "symbol":         base,
                    "real_symbol":    base,
                    "name":           meta.get("name", base),
                    "current_price":  price,
                    "percent_change": change if change is not None else _pct_from_series(spark),
                    "history":        spark[-40:] if spark else [price],
                    "type":           "crypto",
                    "icon":           _coin_icon(base),
                }
                _cache_set(f"asset_{base}", result)
                return result
        except Exception as e:
            print(f"⚠️  Binance asset '{base}': {e}")

    # ── 2) Yahoo Finance fallback (stocks, indices, coins not on Binance) ──────
    for sym in [symbol, base, f"{base}-USD"]:
        try:
            ticker = yf.Ticker(sym)
            hist   = ticker.history(period="1d", interval="15m")
            if hist.empty:
                continue

            price  = float(hist["Close"].iloc[-1])
            closes = [float(v) for v in hist["Close"].tolist() if v is not None]
            change = _pct_from_series(closes)

            info = {}
            try:
                info = ticker.info or {}
            except Exception:
                pass

            quote_type = info.get("quoteType", "")
            is_crypto  = "CRYPTOCURRENCY" in quote_type or sym.endswith("-USD")
            asset_type = "crypto" if is_crypto else "stock"
            real_sym   = sym if is_crypto else base
            icon       = info.get("logo_url") or info.get("image") or (
                _coin_icon(base) if is_crypto else ""
            )
            name = info.get("shortName") or info.get("longName") or base

            result = {
                "symbol":         base,
                "real_symbol":    real_sym,
                "name":           name,
                "current_price":  price,
                "percent_change": change,
                "history":        closes[-40:] if closes else [price],
                "type":           asset_type,
                "icon":           icon,
            }
            _cache_set(f"asset_{base}", result)
            return result
        except Exception as e:
            print(f"⚠️  yfinance '{sym}': {e}")
            continue

    print(f"❌ Could not resolve asset: {symbol}")
    return None


def get_historical_data(symbol: str, period: str = "1mo") -> dict:
    """Return {dates: [...], prices: [...]} for a symbol over a period."""
    if not symbol or symbol == "PORTFOLIO":
        return {"dates": [], "prices": []}

    base     = symbol.upper().strip().replace("-USD", "")
    days_map = {"1d": 1, "5d": 5, "7d": 7, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730}

    # ── Binance crypto ─────────────────────────────────────────────────────────
    if not _is_likely_stock(base) and _is_binance_crypto(base):
        try:
            days   = days_map.get(period, 30)
            result = _binance_history(base, days)
            if result["prices"]:
                return result
        except Exception as e:
            print(f"⚠️  Binance history '{base}': {e}")

    # ── Yahoo Finance (stocks + coins not on Binance) ──────────────────────────
    yf_interval = "60m" if period == "1d" else "1d"
    for sym in [symbol, base, f"{base}-USD"]:
        try:
            hist = yf.Ticker(sym).history(period=period, interval=yf_interval)
            if hist.empty:
                hist = yf.Ticker(sym).history(period=period)
            if hist.empty:
                continue
            is_intraday = period in ("1d", "5d")
            fmt    = "%H:%M" if is_intraday else "%m/%d"
            dates  = [d.strftime(fmt) for d in hist.index]
            prices = hist["Close"].tolist()
            return {"dates": dates, "prices": prices}
        except Exception as e:
            print(f"⚠️  yfinance history '{sym}': {e}")
            continue

    return {"dates": [], "prices": []}


def _parse_iso_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    txt = str(raw).strip()
    if not txt:
        return None
    try:
        return datetime.fromisoformat(txt.replace("Z", "+00:00"))
    except ValueError:
        try:
            return datetime.strptime(txt[:10], "%Y-%m-%d")
        except ValueError:
            return None


def generate_weekly_digest(user_id: int, session) -> dict:
    """Build a structured weekly digest payload for an active user."""
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    user = session.get(User, user_id)
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()

    performance_rows: list[dict] = []
    start_total = 0.0
    end_total = 0.0

    for a in assets:
        hist = get_historical_data(a.symbol, period="7d")
        prices = [float(p) for p in (hist.get("prices") or []) if p is not None]
        if len(prices) < 2:
            data = get_asset_data(a.symbol)
            current = float((data or {}).get("current_price") or 0)
            prices = [current, current] if current > 0 else []
        if len(prices) < 2:
            continue

        start_price = prices[0]
        end_price = prices[-1]
        amount = float(a.amount or 0)
        start_value = start_price * amount
        end_value = end_price * amount

        if start_value <= 0 and end_value <= 0:
            continue

        pct_change = ((end_price - start_price) / start_price) * 100 if start_price > 0 else 0.0
        performance_rows.append({
            "symbol": a.symbol,
            "start_price": round(start_price, 4),
            "end_price": round(end_price, 4),
            "change_pct": round(pct_change, 2),
            "value_change": round(end_value - start_value, 2),
        })
        start_total += start_value
        end_total += end_value

    performance_pct = ((end_total - start_total) / start_total) * 100 if start_total > 0 else 0.0

    best = max(performance_rows, key=lambda x: x["change_pct"], default=None)
    worst = min(performance_rows, key=lambda x: x["change_pct"], default=None)

    weekly_dividends = session.exec(select(Dividend).where(Dividend.user_id == user_id)).all()
    dividends_total = 0.0
    dividends_items = []
    for d in weekly_dividends:
        pay_date = _parse_iso_date(d.pay_date) or _parse_iso_date(d.recorded_at)
        if pay_date and pay_date.tzinfo is None:
            pay_date = pay_date.replace(tzinfo=timezone.utc)
        if pay_date and pay_date >= week_ago:
            amount = float(d.total_received or 0)
            dividends_total += amount
            dividends_items.append({
                "symbol": d.symbol,
                "amount": round(amount, 2),
                "pay_date": d.pay_date,
            })

    triggered_alerts = session.exec(
        select(PriceAlert).where(
            PriceAlert.user_id == user_id,
            PriceAlert.triggered == True,
        )
    ).all()
    alert_count = 0
    for alert in triggered_alerts:
        trg = _parse_iso_date(alert.triggered_at)
        if trg and trg.tzinfo is None:
            trg = trg.replace(tzinfo=timezone.utc)
        if trg and trg >= week_ago:
            alert_count += 1

    txs = session.exec(select(Transaction).where(Transaction.user_id == user_id)).all()
    weekly_tx_count = 0
    for tx in txs:
        tx_dt = _parse_iso_date(tx.date) or _parse_iso_date(tx.created_at)
        if tx_dt and tx_dt.tzinfo is None:
            tx_dt = tx_dt.replace(tzinfo=timezone.utc)
        if tx_dt and tx_dt >= week_ago:
            weekly_tx_count += 1

    tax_opportunities = []
    if user and user.plan == "tax_pro":
        tlh_input = []
        for a in assets:
            ad = get_asset_data(a.symbol)
            if not ad:
                continue
            tlh_input.append({
                "symbol": a.symbol,
                "current_price": ad.get("current_price", 0),
                "purchase_price": a.purchase_price,
                "amount": a.amount,
                "purchase_date": a.purchase_date,
            })
        tax_opportunities = calculate_tax_loss_harvesting(tlh_input)

    return {
        "window": {
            "start": week_ago.isoformat(),
            "end": now.isoformat(),
        },
        "performance": {
            "start_value": round(start_total, 2),
            "end_value": round(end_total, 2),
            "change_value": round(end_total - start_total, 2),
            "change_pct": round(performance_pct, 2),
        },
        "best_performer": best,
        "worst_performer": worst,
        "dividends": {
            "total": round(dividends_total, 2),
            "items": dividends_items,
        },
        "alerts_triggered": alert_count,
        "transactions_count": weekly_tx_count,
        "tax_opportunities": tax_opportunities,
        "is_tax_pro": bool(user and user.plan == "tax_pro"),
    }




def _tx_attr(tx, key: str, default=None):
    if isinstance(tx, dict):
        return tx.get(key, default)
    return getattr(tx, key, default)


def _clamp_score(v: float) -> int:
    return int(max(0, min(100, round(v))))


def _score_grade(score: int) -> str:
    if score >= 93:
        return "A"
    if score >= 88:
        return "A-"
    if score >= 83:
        return "B+"
    if score >= 78:
        return "B"
    if score >= 73:
        return "B-"
    if score >= 68:
        return "C+"
    if score >= 63:
        return "C"
    if score >= 58:
        return "C-"
    if score >= 50:
        return "D"
    return "F"


def calculate_portfolio_score(assets: list[dict], transactions: list) -> dict:
    """Calculate a 0-100 portfolio score across diversification, risk, tax and consistency."""
    assets = assets or []
    transactions = transactions or []
    insights: list[str] = []

    if not assets:
        return {
            "overall": 0,
            "diversification": 0,
            "risk_adjusted": 0,
            "tax_efficiency": None,
            "consistency": 0,
            "grade": "F",
            "insights": ["Add assets to start building your Portfolio Score."],
        }

    is_tax_pro = bool(any(a.get("is_tax_pro") for a in assets))

    # 1) Diversification
    total_value = sum(float(a.get("position_value") or (float(a.get("amount") or 0) * float(a.get("current_price") or 0))) for a in assets)
    n_assets = len(assets)
    max_conc = 0.0
    types = set()
    if total_value > 0:
        for a in assets:
            val = float(a.get("position_value") or (float(a.get("amount") or 0) * float(a.get("current_price") or 0)))
            max_conc = max(max_conc, val / total_value)
            types.add((a.get("type") or "").lower())

    diversification = 45.0
    diversification += min(n_assets, 5) * 10
    diversification -= max(0.0, (max_conc - 0.40) * 120)
    if types == {"crypto"} or types == {"stock"}:
        diversification -= 12
        insights.append("Try mixing stocks and crypto to improve diversification.")
    if max_conc > 0.4:
        top = max(assets, key=lambda a: float(a.get("position_value") or 0))
        insights.append(f"Your {top.get('symbol', 'top')} position is too concentrated at {max_conc * 100:.0f}%.")
    diversification = _clamp_score(diversification)

    # 2) Risk-adjusted (lower portfolio volatility than S&P500 => higher)
    port_returns: list[float] = []
    hist_pairs = []
    for a in assets:
        h = get_historical_data(a.get("real_symbol") or a.get("symbol"), period="1mo")
        prices = [float(x) for x in (h.get("prices") or []) if x]
        if len(prices) < 8:
            continue
        rets = []
        for i in range(1, len(prices)):
            if prices[i-1] > 0:
                rets.append((prices[i] / prices[i-1]) - 1)
        if rets:
            val = float(a.get("position_value") or 0)
            hist_pairs.append((rets, val))

    if hist_pairs:
        min_len = min(len(r) for r, _ in hist_pairs)
        if min_len > 2:
            w_sum = sum(v for _, v in hist_pairs) or len(hist_pairs)
            for i in range(min_len):
                port_returns.append(sum((r[i] * (v / w_sum if w_sum else 0)) for r, v in hist_pairs))

    bench = get_historical_data("^GSPC", period="1mo")
    bench_prices = [float(x) for x in (bench.get("prices") or []) if x]
    bench_returns = [((bench_prices[i] / bench_prices[i-1]) - 1) for i in range(1, len(bench_prices)) if bench_prices[i-1] > 0]

    def _vol(series: list[float]) -> float:
        if len(series) < 2:
            return 0.0
        mean = sum(series) / len(series)
        var = sum((x - mean) ** 2 for x in series) / (len(series) - 1)
        return var ** 0.5

    port_vol = _vol(port_returns)
    bench_vol = _vol(bench_returns)
    risk_adjusted = 60.0
    if port_vol > 0 and bench_vol > 0:
        rel = port_vol / bench_vol
        risk_adjusted = 80 - ((rel - 1) * 40)
        if rel < 1:
            insights.append("Great risk control: your portfolio was less volatile than the S&P 500.")
        elif rel > 1.3:
            insights.append("Portfolio volatility is significantly above S&P 500; consider reducing high-beta concentration.")
    risk_adjusted = _clamp_score(risk_adjusted)

    # 3) Tax efficiency
    tax_efficiency = None
    if is_tax_pro:
        lt_value = 0.0
        st_value = 0.0
        for a in assets:
            v = float(a.get("position_value") or 0)
            days = int(a.get("days_held") or 0)
            if days >= 365:
                lt_value += v
            else:
                st_value += v
        total_holding_value = lt_value + st_value
        long_term_ratio = (lt_value / total_holding_value) if total_holding_value > 0 else 0.0
        tax_efficiency = 55 + long_term_ratio * 45

        tlh_input = []
        for a in assets:
            tlh_input.append({
                "symbol": a.get("symbol"),
                "current_price": a.get("current_price", 0),
                "purchase_price": a.get("purchase_price", 0),
                "amount": a.get("amount", 0),
                "purchase_date": a.get("purchase_date"),
            })
        missed = calculate_tax_loss_harvesting(tlh_input)
        if missed:
            penalty = min(25, len(missed) * 5)
            tax_efficiency -= penalty
            insights.append(f"You have {len(missed)} tax-loss harvesting opportunities still open.")
        tax_efficiency = _clamp_score(tax_efficiency)

    # 4) Consistency (DCA regularity + panic selling)
    buy_dates = []
    panic_sells = 0
    buy_prices_by_symbol: dict[str, list[float]] = {}
    for tx in transactions:
        tx_type = str(_tx_attr(tx, "type", "")).lower()
        symbol = str(_tx_attr(tx, "symbol", "") or "").upper()
        tx_date = _parse_iso_date(_tx_attr(tx, "date")) or _parse_iso_date(_tx_attr(tx, "created_at"))
        price = float(_tx_attr(tx, "price", 0) or 0)
        realized = _tx_attr(tx, "realized_pnl", None)

        if tx_type == "buy" and tx_date:
            buy_dates.append(tx_date)
            if price > 0:
                buy_prices_by_symbol.setdefault(symbol, []).append(price)

        if tx_type == "sell":
            avg_buy = 0.0
            buys = buy_prices_by_symbol.get(symbol, [])
            if buys:
                avg_buy = sum(buys) / len(buys)
            is_panic = False
            if avg_buy > 0 and price > 0 and ((price / avg_buy) - 1) <= -0.10:
                is_panic = True
            if realized is not None and float(realized) < 0 and avg_buy > 0 and price <= avg_buy * 0.95:
                is_panic = True
            if is_panic:
                panic_sells += 1

    consistency = 65.0
    if buy_dates:
        month_counts: dict[str, int] = {}
        for d in buy_dates:
            month_counts[d.strftime("%Y-%m")] = month_counts.get(d.strftime("%Y-%m"), 0) + 1
        counts = list(month_counts.values())
        mean_c = sum(counts) / len(counts)
        std_c = ((sum((x - mean_c) ** 2 for x in counts) / len(counts)) ** 0.5) if counts else 0
        cv = (std_c / mean_c) if mean_c > 0 else 1
        consistency += max(0, 25 - cv * 30)
        if cv < 0.6:
            insights.append("Strong DCA consistency: your contributions are regular.")
    else:
        consistency -= 20
        insights.append("No recent buy activity detected; consistency improves with regular contributions.")

    if panic_sells > 0:
        consistency -= min(30, panic_sells * 10)
        insights.append(f"Detected {panic_sells} potential panic sell event(s) during drawdowns.")
    consistency = _clamp_score(consistency)

    if is_tax_pro and tax_efficiency is not None:
        overall = round(diversification * 0.30 + risk_adjusted * 0.30 + tax_efficiency * 0.20 + consistency * 0.20)
    else:
        overall = round(diversification * 0.375 + risk_adjusted * 0.375 + consistency * 0.25)

    overall = _clamp_score(overall)
    return {
        "overall": overall,
        "diversification": diversification,
        "risk_adjusted": risk_adjusted,
        "tax_efficiency": tax_efficiency,
        "consistency": consistency,
        "grade": _score_grade(overall),
        "insights": insights[:6],
    }


def search_symbols(query: str) -> list[dict]:
    """Search Binance (crypto) + Yahoo Finance (stocks). Returns list of result dicts."""
    results: list[dict] = []
    seen:    set[str]   = set()

    q_upper = query.upper().strip()

    # ── 1) Binance symbol match ────────────────────────────────────────────────
    if not _binance_pairs_loaded:
        _load_binance_pairs()

    binance_matches = sorted(
        [s for s in _binance_usdt_assets if s.startswith(q_upper)],
        key=lambda s: (0 if s == q_upper else 1, len(s)),
    )[:6]

    for sym in binance_matches:
        if sym in seen:
            continue
        seen.add(sym)
        meta = _COIN_META.get(sym, {})
        results.append({
            "symbol": sym,
            "name":   meta.get("name", sym),
            "type":   "CRYPTO",
            "icon":   _coin_icon(sym),
        })

    # ── 2) Yahoo Finance stock/ETF search ──────────────────────────────────────
    try:
        r = requests.get(
            f"https://query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=8",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=4,
        )
        for q in r.json().get("quotes", []):
            sym   = (q.get("symbol") or "").upper()
            qtype = (q.get("quoteType") or "").upper()
            if not sym or sym in seen or qtype == "CRYPTOCURRENCY":
                continue
            seen.add(sym)
            results.append({
                "symbol": sym,
                "name":   q.get("shortname") or q.get("longname") or sym,
                "type":   "STOCK" if qtype in ("EQUITY", "ETF", "INDEX") else qtype or "STOCK",
                "icon":   "",
            })
    except Exception as e:
        print(f"⚠️  Yahoo search: {e}")

    return results[:10]


# ── AI ─────────────────────────────────────────────────────────────────────────

def get_ai_status() -> dict:
    return {
        "enabled":        _gemini_client is not None,
        "provider":       "gemini",
        "status":         _gemini_status,
        "api_key_source": "GEMINI_API_KEY/GOOGLE_API_KEY",
    }


def _extract_gemini_text(res) -> str:
    try:
        if hasattr(res, "text") and res.text:
            return res.text
        if hasattr(res, "candidates") and res.candidates:
            for cand in res.candidates:
                if hasattr(cand, "content") and cand.content:
                    for part in cand.content.parts:
                        if hasattr(part, "text") and part.text:
                            return part.text
    except Exception:
        pass
    return ""


def get_ai_analysis(symbol: str, change: float) -> str:
    if not _gemini_client:
        return "⚠️ Gemini API not configured. Add GEMINI_API_KEY to your environment."

    direction = "rose" if change > 0 else "fell" if change < 0 else "was flat"
    prompt = (
        f"In 1-2 concise sentences, analyze the asset {symbol} which {direction} "
        f"{abs(change):.2f}% in the last 24h. Mention possible general market reasons "
        "without inventing specific news. Respond in English."
    )

    try:
        res = _gemini_client.models.generate_content(
            model="gemini-1.5-flash",
            contents=prompt,
        )
        return _extract_gemini_text(res) or "Analysis temporarily unavailable."
    except Exception as e:
        print(f"❌ Gemini error for {symbol}: {e}")
        return "AI analysis temporarily unavailable."


def get_portfolio_ai_analysis(portfolio_change: float, assets: list[dict]) -> str:
    if not _gemini_client:
        return "⚠️ Gemini API not configured. Add GEMINI_API_KEY to your environment."

    direction = "rose" if portfolio_change > 0 else "fell" if portfolio_change < 0 else "was flat"
    lines = "\n".join(
        f"- {a.get('symbol')} ({a.get('type')}) "
        f"{a.get('allocation_pct', 0):.1f}% allocation, {a.get('change_pct', 0):+.2f}% today"
        for a in assets[:8]
    )
    prompt = (
        f"As a portfolio manager, my portfolio {direction} {abs(portfolio_change):.2f}% today.\n"
        f"Holdings:\n{lines}\n\n"
        "In 2-3 sentences: comment on the portfolio behavior and give 1-2 generic "
        "allocation tips. Do not recommend specific assets. Respond in English."
    )

    try:
        res = _gemini_client.models.generate_content(
            model="gemini-1.5-flash",
            contents=prompt,
        )
        return _extract_gemini_text(res) or "Portfolio analysis temporarily unavailable."
    except Exception as e:
        print(f"❌ Gemini portfolio error: {e}")
        return "Portfolio analysis temporarily unavailable."



# ── ALERTS ─────────────────────────────────────────────────────────────────────

def calculate_rsi(prices: list[float], period: int = 14) -> float:
    """Calculate standard RSI (0-100) from a close-price series."""
    if not prices or len(prices) < 2:
        return 50.0

    period = max(1, int(period or 14))
    closes = [float(p) for p in prices if p is not None]
    if len(closes) < period + 1:
        return 50.0

    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [max(d, 0.0) for d in deltas]
    losses = [abs(min(d, 0.0)) for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(deltas)):
        avg_gain = ((avg_gain * (period - 1)) + gains[i]) / period
        avg_loss = ((avg_loss * (period - 1)) + losses[i]) / period

    if avg_loss == 0:
        return 100.0

    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return max(0.0, min(100.0, float(rsi)))


def check_advanced_alert(alert, asset_data: dict, portfolio_data: dict = None) -> bool:
    """Evaluate advanced alert conditions."""
    alert_type = (getattr(alert, "alert_type", "") or "").strip()
    target = float(getattr(alert, "target_value", 0) or 0)

    if alert_type in ("rsi_oversold", "rsi_overbought"):
        prices = (asset_data or {}).get("historical_prices") or []
        period = int(getattr(alert, "rsi_period", 14) or 14)
        rsi = calculate_rsi(prices, period=period)
        return rsi < target if alert_type == "rsi_oversold" else rsi > target

    if alert_type == "rebalance_drift":
        current_alloc = (asset_data or {}).get("current_allocation_pct")
        target_alloc = getattr(alert, "target_allocation_pct", None)
        threshold = getattr(alert, "rebalance_threshold_pct", None)
        if threshold is None:
            threshold = target
        if current_alloc is None or target_alloc is None or threshold is None:
            return False
        drift = abs(float(current_alloc) - float(target_alloc))
        return drift >= float(threshold)

    if alert_type == "volume_spike":
        volume_history = (asset_data or {}).get("volume_history") or []
        if len(volume_history) < 2:
            return False
        current_volume = float(volume_history[-1])
        baseline_window = volume_history[-21:-1] or volume_history[:-1]
        if not baseline_window:
            return False
        avg_volume = sum(float(v) for v in baseline_window) / len(baseline_window)
        return avg_volume > 0 and current_volume > (target * avg_volume)

    if alert_type == "portfolio_down":
        if not portfolio_data:
            return False
        pct_24h = float(portfolio_data.get("percent_change_24h", 0) or 0)
        return pct_24h <= -target

    return False


def _get_volume_history(symbol: str, days: int = 21) -> list[float]:
    """Return a daily volume series for the asset."""
    base = (symbol or "").upper().strip().replace("-USD", "")
    if not base:
        return []

    if not _is_likely_stock(base) and _is_binance_crypto(base):
        try:
            r = requests.get(
                f"{_BINANCE_BASE}/api/v3/klines",
                params={"symbol": f"{base}USDT", "interval": "1d", "limit": max(2, days)},
                headers=_BINANCE_HEADERS,
                timeout=8,
            )
            r.raise_for_status()
            return [float(k[5]) for k in r.json()]
        except Exception as e:
            print(f"⚠️  Binance volume '{base}': {e}")

    for sym in [symbol, base, f"{base}-USD"]:
        try:
            hist = yf.Ticker(sym).history(period="1mo", interval="1d")
            if hist.empty or "Volume" not in hist:
                continue
            vols = [float(v) for v in hist["Volume"].tolist() if v is not None]
            if vols:
                return vols[-max(2, days):]
        except Exception as e:
            print(f"⚠️  yfinance volume '{sym}': {e}")

    return []


def _portfolio_change_24h_for_user(session, user_id: int) -> float:
    from models import Asset
    from sqlmodel import select

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return 0.0

    prev_total = 0.0
    curr_total = 0.0
    for a in assets:
        data = get_asset_data(a.symbol)
        if not data:
            continue
        amount = float(a.amount or 0)
        current_price = float(data.get("current_price") or 0)
        change_pct = float(data.get("percent_change") or 0)
        if current_price <= 0:
            continue
        prev_price = current_price / (1 + (change_pct / 100)) if change_pct != -100 else current_price
        curr_total += amount * current_price
        prev_total += amount * prev_price

    if prev_total <= 0:
        return 0.0
    return ((curr_total - prev_total) / prev_total) * 100


def check_and_trigger_alerts(session, send_email_callback) -> None:
    from models import PriceAlert, User, Asset
    from sqlmodel import select

    try:
        active_alerts = session.exec(
            select(PriceAlert).where(PriceAlert.active == True, PriceAlert.triggered == False)
        ).all()

        if not active_alerts:
            return

        print(f"🔍 Checking {len(active_alerts)} active alerts…")

        alerts_by_symbol: dict[str, list] = {}
        portfolio_alerts_by_user: dict[int, list] = {}
        for alert in active_alerts:
            if alert.alert_type == "portfolio_down":
                portfolio_alerts_by_user.setdefault(alert.user_id, []).append(alert)
                continue
            symbol = (alert.symbol or "").upper().strip()
            if symbol:
                alerts_by_symbol.setdefault(symbol, []).append(alert)

        for symbol, alerts in alerts_by_symbol.items():
            try:
                data = get_asset_data(symbol)
                if not data:
                    continue

                current_price = data["current_price"]
                percent_change = data["percent_change"]

                for alert in alerts:
                    triggered = False
                    if alert.alert_type == "price_above" and current_price >= alert.target_value:
                        triggered = True
                    elif alert.alert_type == "price_below" and current_price <= alert.target_value:
                        triggered = True
                    elif alert.alert_type == "percent_change_up" and percent_change >= alert.target_value:
                        triggered = True
                    elif alert.alert_type == "percent_change_down" and percent_change <= -alert.target_value:
                        triggered = True
                    elif alert.alert_type in {"rsi_oversold", "rsi_overbought", "rebalance_drift", "volume_spike"}:
                        adv_asset_data = {
                            "current_price": current_price,
                            "percent_change": percent_change,
                        }

                        if alert.alert_type in {"rsi_oversold", "rsi_overbought"}:
                            hist = get_historical_data(symbol, period="1mo")
                            adv_asset_data["historical_prices"] = (hist.get("prices") or [])[-20:]

                        if alert.alert_type == "volume_spike":
                            adv_asset_data["volume_history"] = _get_volume_history(symbol, days=21)

                        if alert.alert_type == "rebalance_drift":
                            user_assets = session.exec(select(Asset).where(Asset.user_id == alert.user_id)).all()
                            total_value = 0.0
                            this_asset_value = 0.0
                            for a in user_assets:
                                a_data = get_asset_data(a.symbol)
                                if not a_data:
                                    continue
                                pos_value = float(a.amount or 0) * float(a_data.get("current_price") or 0)
                                total_value += pos_value
                                if (a.symbol or "").upper().strip() == symbol:
                                    this_asset_value = pos_value
                            if total_value > 0:
                                adv_asset_data["current_allocation_pct"] = (this_asset_value / total_value) * 100

                        triggered = check_advanced_alert(alert, adv_asset_data)

                    if triggered:
                        alert.triggered = True
                        alert.triggered_at = str(datetime.now())
                        if not alert.recurring:
                            alert.active = False
                        else:
                            alert.triggered = False
                        session.add(alert)

                        user = session.get(User, alert.user_id)
                        if user and user.email and user.notification_email:
                            send_email_callback(
                                user.email, user.username, symbol,
                                alert.alert_type, alert.target_value, current_price,
                            )
                            print(f"✅ Alert → {user.username}: {symbol} {alert.alert_type}")

            except Exception as e:
                print(f"⚠️  Alert processing for {symbol}: {e}")

        for user_id, alerts in portfolio_alerts_by_user.items():
            try:
                portfolio_change_24h = _portfolio_change_24h_for_user(session, user_id)
                pdata = {"percent_change_24h": portfolio_change_24h}
                for alert in alerts:
                    if not check_advanced_alert(alert, asset_data={}, portfolio_data=pdata):
                        continue

                    alert.triggered = True
                    alert.triggered_at = str(datetime.now())
                    if not alert.recurring:
                        alert.active = False
                    else:
                        alert.triggered = False
                    session.add(alert)

                    user = session.get(User, alert.user_id)
                    if user and user.email and user.notification_email:
                        send_email_callback(
                            user.email,
                            user.username,
                            "PORTFOLIO",
                            alert.alert_type,
                            alert.target_value,
                            portfolio_change_24h,
                        )
                        print(f"✅ Alert → {user.username}: PORTFOLIO {alert.alert_type}")
            except Exception as e:
                print(f"⚠️  Portfolio alert processing for user={user_id}: {e}")

        session.commit()

    except Exception as e:
        print(f"❌ check_and_trigger_alerts: {e}")
        session.rollback()


# ══════════════════════════════════════════════════════════════════════════════
# IRS FORM 8949
# ══════════════════════════════════════════════════════════════════════════════

def generate_form_8949(
    transactions: list[dict],
    tax_year: int,
    method: str = "FIFO",
) -> dict:
    """
    Generate IRS Form 8949 data for a given tax year.

    Parameters
    ----------
    transactions : list of {type, symbol, amount, price, date} dicts
    tax_year     : e.g. 2024
    method       : "FIFO" | "LIFO" | "HIFO"

    Returns
    -------
    {
        tax_year, method,
        part_I  : [short-term rows],    # holding < 365 days
        part_II : [long-term rows],     # holding >= 365 days
        summary : {total_proceeds, total_cost_basis,
                   net_short_term, net_long_term, total_net_gain_loss}
    }

    Each row:
        description, date_acquired, date_sold, proceeds, cost_basis, gain_loss
    """
    method = method.upper().strip()
    if method not in ("FIFO", "LIFO", "HIFO"):
        method = "FIFO"

    year_str = str(tax_year)

    # ── Build open-lot ledger per symbol from ALL buy transactions ────────────
    lots_by_sym: dict[str, list[dict]] = {}
    for tx in sorted(transactions, key=lambda t: t.get("date") or ""):
        if (tx.get("type") or "").lower() != "buy":
            continue
        sym    = (tx.get("symbol") or "").upper()
        amount = float(tx.get("amount") or 0)
        price  = float(tx.get("price")  or 0)
        if amount <= 0 or price <= 0:
            continue
        lots_by_sym.setdefault(sym, []).append({
            "date":      tx.get("date", ""),
            "price":     price,
            "remaining": amount,
        })

    # ── Process each sell in the target tax year ──────────────────────────────
    part_I:  list[dict] = []
    part_II: list[dict] = []

    sells_in_year = [
        t for t in transactions
        if (t.get("type") or "").lower() == "sell"
        and (t.get("date") or "")[:4] == year_str
    ]
    sells_in_year.sort(key=lambda t: t.get("date") or "")

    for sell in sells_in_year:
        sym          = (sell.get("symbol") or "").upper()
        sell_amount  = float(sell.get("amount") or 0)
        sell_price   = float(sell.get("price")  or 0)
        sell_date    = sell.get("date", "")

        if sell_amount <= 0 or sell_price <= 0:
            continue

        proceeds      = round(sell_amount * sell_price, 2)
        lots          = lots_by_sym.get(sym, [])

        # Sort lots per method (operate on copies to preserve original order)
        if method == "FIFO":
            ordered = sorted(lots, key=lambda l: l["date"])
        elif method == "LIFO":
            ordered = sorted(lots, key=lambda l: l["date"], reverse=True)
        else:  # HIFO
            ordered = sorted(lots, key=lambda l: l["price"], reverse=True)

        remaining_sell = sell_amount
        cost_total     = 0.0
        acquire_dates: list[str] = []

        for lot in ordered:
            if lot["remaining"] <= 1e-9 or remaining_sell <= 1e-9:
                break
            used           = min(lot["remaining"], remaining_sell)
            cost_total    += used * lot["price"]
            remaining_sell -= used
            lot["remaining"] -= used
            acquire_dates.append(lot["date"])

        cost_basis  = round(cost_total, 2)
        gain_loss   = round(proceeds - cost_basis, 2)

        # Determine holding period from first acquisition date
        is_long = False
        acq_display = "VARIOUS" if len(acquire_dates) > 1 else (acquire_dates[0] if acquire_dates else "VARIOUS")
        if acquire_dates:
            try:
                first_acq = datetime.strptime(acquire_dates[0][:10], "%Y-%m-%d")
                sold_dt   = datetime.strptime(sell_date[:10], "%Y-%m-%d")
                is_long   = (sold_dt - first_acq).days >= 365
            except Exception:
                pass

        row = {
            "description":   f"{sell_amount:g} units of {sym}",
            "date_acquired": acq_display,
            "date_sold":     sell_date,
            "proceeds":      proceeds,
            "cost_basis":    cost_basis,
            "gain_loss":     gain_loss,
        }

        (part_II if is_long else part_I).append(row)

    # ── Summary ───────────────────────────────────────────────────────────────
    all_rows         = part_I + part_II
    total_proceeds   = round(sum(r["proceeds"]  for r in all_rows), 2)
    total_cost_basis = round(sum(r["cost_basis"] for r in all_rows), 2)
    net_short        = round(sum(r["gain_loss"]  for r in part_I),  2)
    net_long         = round(sum(r["gain_loss"]  for r in part_II), 2)

    return {
        "tax_year": tax_year,
        "method":   method,
        "part_I":   part_I,
        "part_II":  part_II,
        "summary": {
            "total_proceeds":    total_proceeds,
            "total_cost_basis":  total_cost_basis,
            "net_short_term":    net_short,
            "net_long_term":     net_long,
            "total_net_gain_loss": round(net_short + net_long, 2),
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# CSV BROKER PARSER
# ══════════════════════════════════════════════════════════════════════════════

def _clean_price(raw: str) -> float:
    if not raw:
        return 0.0
    cleaned = raw.strip().replace("$", "").replace(",", "").replace(" ", "")
    try:
        return abs(float(cleaned))
    except ValueError:
        return 0.0


def _normalize_date(raw: str, fmt_hints: list[str] | None = None) -> str:
    if not raw:
        return str(datetime.today().date())
    raw     = raw.strip()
    formats = fmt_hints or [
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S %Z",
        "%Y-%m-%d %H:%M:%S",
        "%m/%d/%Y",
        "%m-%d-%Y",
        "%d/%m/%Y",
        "%Y-%m-%d",
        "%b %d, %Y",
        "%B %d, %Y",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    try:
        from dateutil import parser as du_parser
        return du_parser.parse(raw).strftime("%Y-%m-%d")
    except Exception:
        pass
    return str(datetime.today().date())


def _sniff_delimiter(content: str) -> str:
    first_line = content.split("\n")[0] if "\n" in content else content
    return ";" if first_line.count(";") > first_line.count(",") else ","


def _csv_rows(content: str) -> tuple[list[str], list[dict]]:
    delimiter = _sniff_delimiter(content)
    lines     = content.splitlines()
    start_idx = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and len(stripped.split(delimiter)) >= 3:
            start_idx = i
            break
    clean_content = "\n".join(lines[start_idx:])
    reader  = csv.DictReader(io.StringIO(clean_content), delimiter=delimiter)
    rows    = list(reader)
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    return headers, rows


def _parse_coinbase(rows: list[dict]) -> list[dict]:
    TYPE_MAP = {"buy": "buy", "sell": "sell", "advanced trade buy": "buy", "advanced trade sell": "sell"}
    results  = []
    for row in rows:
        raw_type = (row.get("Transaction Type") or row.get("transaction type") or "").strip().lower()
        tx_type  = TYPE_MAP.get(raw_type)
        if not tx_type:
            continue
        symbol     = (row.get("Asset") or row.get("asset") or "").strip().upper()
        amount_raw = row.get("Quantity Transacted") or row.get("quantity transacted") or "0"
        price_raw  = row.get("Spot Price at Transaction") or row.get("spot price at transaction") or "0"
        date_raw   = row.get("Timestamp") or row.get("timestamp") or ""
        amount = _clean_price(amount_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_robinhood(rows: list[dict]) -> list[dict]:
    TYPE_MAP = {"buy": "buy", "sell": "sell", "bto": "buy", "sto": "sell"}
    results  = []
    for row in rows:
        trans_code = (row.get("Trans Code") or row.get("trans code") or "").strip().lower()
        tx_type    = TYPE_MAP.get(trans_code)
        if not tx_type:
            continue
        symbol   = (row.get("Instrument") or row.get("instrument") or "").strip().upper()
        qty_raw  = row.get("Quantity") or row.get("quantity") or "0"
        price_raw= row.get("Price")    or row.get("price")    or "0"
        date_raw = row.get("Activity Date") or row.get("activity date") or ""
        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_fidelity(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        action = (row.get("Action") or row.get("action") or "").strip().upper()
        if   "BOUGHT" in action: tx_type = "buy"
        elif "SOLD"   in action: tx_type = "sell"
        else: continue
        symbol   = (row.get("Symbol") or row.get("symbol") or "").strip().upper()
        qty_raw  = row.get("Quantity") or row.get("quantity") or "0"
        price_raw= row.get("Price ($)") or row.get("Price") or row.get("price") or "0"
        date_raw = row.get("Run Date") or row.get("run date") or ""
        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_kraken(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        if (row.get("type") or "").strip().lower() != "trade":
            continue
        asset_raw = (row.get("asset") or "").strip().upper()
        symbol    = asset_raw
        if len(symbol) == 4 and symbol[0] in ("X", "Z"):
            symbol = symbol[1:]
        if symbol in ("XXBT", "XBT"):
            symbol = "BTC"
        if symbol in ("XETH",):
            symbol = "ETH"
        if symbol.endswith(".S"):
            symbol = symbol[:-2]
        try:
            raw_amount = float((row.get("amount") or "0").strip())
        except ValueError:
            continue
        if raw_amount == 0:
            continue
        tx_type = "buy" if raw_amount > 0 else "sell"
        amount  = abs(raw_amount)
        date    = _normalize_date(row.get("time") or "")
        if not symbol:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": 0.0, "date": date})
    return results


def _parse_schwab(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        action       = (row.get("Action") or row.get("action") or "").strip().upper()
        if   "BUY"  in action: tx_type = "buy"
        elif "SELL" in action: tx_type = "sell"
        else: continue
        symbol    = (row.get("Symbol") or row.get("symbol") or "").strip().upper()
        qty_raw   = row.get("Quantity") or row.get("quantity") or "0"
        price_raw = row.get("Price")    or row.get("price")    or "0"
        date_raw  = row.get("Date")     or row.get("date")     or ""
        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


SUPPORTED_BROKERS = ("coinbase", "robinhood", "fidelity", "kraken", "schwab")


def parse_broker_csv(content: str, broker: str) -> list[dict]:
    broker = broker.strip().lower()
    if broker not in SUPPORTED_BROKERS:
        raise ValueError(
            f"Unsupported broker '{broker}'. Supported: {', '.join(SUPPORTED_BROKERS)}."
        )
    if not content or not content.strip():
        raise ValueError("CSV file is empty.")
    try:
        headers, rows = _csv_rows(content)
    except Exception as e:
        raise ValueError(f"Could not parse CSV file: {e}")
    if not rows:
        raise ValueError("CSV file contains no data rows.")

    parsers = {
        "coinbase":  _parse_coinbase,
        "robinhood": _parse_robinhood,
        "fidelity":  _parse_fidelity,
        "kraken":    _parse_kraken,
        "schwab":    _parse_schwab,
    }
    try:
        transactions = parsers[broker](rows)
    except Exception as e:
        raise ValueError(f"Error parsing {broker} CSV: {e}")

    validated = []
    for i, tx in enumerate(transactions):
        missing = [f for f in ("symbol", "type", "amount", "price", "date") if f not in tx]
        if missing:
            print(f"⚠️  Row {i} missing fields {missing} — skipped")
            continue
        if tx["type"] not in ("buy", "sell"):
            continue
        validated.append(tx)
    return validated


# ── TAX LOSS HARVESTING ────────────────────────────────────────────────────────

_TLH_REPLACEMENTS: dict[str, str] = {
    "SPY": "VOO", "VOO": "IVV", "IVV": "SPY", "QQQ": "QQQM",
    "QQQM": "QQQ", "IWM": "VB", "VB": "IWM", "GLD": "IAU",
    "IAU": "GLD", "SLV": "SIVR", "TLT": "IEF", "ARKK": "CTEC",
    "AAPL": "MSFT", "MSFT": "AAPL", "GOOGL": "META", "GOOG": "META",
    "META": "SNAP", "NVDA": "AMD", "AMD": "INTC", "TSLA": "RIVN",
    "AMZN": "SHOP", "NFLX": "DIS", "PYPL": "SQ", "SQ": "PYPL",
    "COIN": "MSTR",
    "BTC": "ETH", "ETH": "BTC", "SOL": "AVAX", "AVAX": "DOT",
    "DOT": "LINK", "LINK": "UNI", "BNB": "CRO", "XRP": "XLM",
    "ADA": "ALGO", "DOGE": "SHIB", "SHIB": "DOGE", "MATIC": "FTM",
}


def calculate_tax_loss_harvesting(
    assets: list[dict],
    tax_bracket: float = 0.22,
) -> list[dict]:
    today = date.today()
    opportunities: list[dict] = []

    for asset in assets:
        try:
            symbol         = (asset.get("symbol") or "").upper()
            current_price  = float(asset.get("current_price")  or 0)
            purchase_price = float(asset.get("purchase_price") or 0)
            amount         = float(asset.get("amount")         or 0)

            if not symbol or current_price <= 0 or purchase_price <= 0 or amount <= 0:
                continue

            unrealized_loss = (current_price - purchase_price) * amount
            if unrealized_loss >= -50:
                continue

            purchase_date_raw = asset.get("purchase_date") or str(today)
            try:
                pd = datetime.strptime(str(purchase_date_raw)[:10], "%Y-%m-%d").date()
            except ValueError:
                pd = today

            holding_days  = (today - pd).days
            gain_type     = "short_term" if holding_days < 365 else "long_term"

            if gain_type == "long_term":
                effective_rate = 0.0 if tax_bracket <= 0.12 else (0.15 if tax_bracket <= 0.35 else 0.20)
            else:
                effective_rate = tax_bracket

            estimated_tax_saved   = abs(unrealized_loss) * effective_rate
            wash_sale_safe_date   = (today + timedelta(days=31)).strftime("%Y-%m-%d")
            suggested_replacement = _TLH_REPLACEMENTS.get(symbol, f"{symbol}2")

            opportunities.append({
                "symbol":                symbol,
                "unrealized_loss":       round(unrealized_loss, 2),
                "estimated_tax_saved":   round(estimated_tax_saved, 2),
                "holding_days":          holding_days,
                "gain_type":             gain_type,
                "wash_sale_safe_date":   wash_sale_safe_date,
                "suggested_replacement": suggested_replacement,
                "current_price":         round(current_price, 6),
                "purchase_price":        round(purchase_price, 6),
                "amount":                amount,
                "effective_rate_pct":    round(effective_rate * 100, 1),
            })
        except Exception as e:
            print(f"⚠️  TLH calc error for {asset.get('symbol')}: {e}")

    opportunities.sort(key=lambda x: x["estimated_tax_saved"], reverse=True)
    return opportunities


# ── COST BASIS ─────────────────────────────────────────────────────────────────

def calculate_cost_basis(
    transactions: list[dict],
    method: str = "FIFO",
) -> dict:
    method = method.upper().strip()
    if method not in ("FIFO", "LIFO", "HIFO", "SPEC"):
        method = "FIFO"

    buys  = sorted(
        [t for t in transactions if (t.get("type") or "").lower() == "buy"],
        key=lambda t: t.get("date") or "0000-00-00",
    )
    sells = sorted(
        [t for t in transactions if (t.get("type") or "").lower() == "sell"],
        key=lambda t: t.get("date") or "0000-00-00",
    )

    lots = [
        {
            "date":      b.get("date", ""),
            "price":     float(b.get("price",  0) or 0),
            "amount":    float(b.get("amount", 0) or 0),
            "lot_id":    b.get("lot_id", None),
            "remaining": float(b.get("amount", 0) or 0),
        }
        for b in buys
        if float(b.get("amount", 0) or 0) > 0 and float(b.get("price", 0) or 0) > 0
    ]

    realized_gains  = 0.0
    realized_losses = 0.0

    for sell in sells:
        sell_amount = float(sell.get("amount", 0) or 0)
        sell_price  = float(sell.get("price",  0) or 0)
        if sell_amount <= 0 or sell_price <= 0:
            continue

        remaining_to_sell = sell_amount

        if method == "FIFO":
            ordered = sorted(lots, key=lambda l: l["date"])
        elif method == "LIFO":
            ordered = sorted(lots, key=lambda l: l["date"], reverse=True)
        elif method == "HIFO":
            ordered = sorted(lots, key=lambda l: l["price"], reverse=True)
        else:
            target_id = sell.get("lot_id")
            if target_id:
                ordered = [l for l in lots if l.get("lot_id") == target_id] + \
                          [l for l in lots if l.get("lot_id") != target_id]
            else:
                ordered = sorted(lots, key=lambda l: l["date"])

        for lot in ordered:
            if lot["remaining"] <= 0 or remaining_to_sell <= 1e-9:
                break
            used = min(lot["remaining"], remaining_to_sell)
            pnl  = (sell_price - lot["price"]) * used
            if pnl >= 0:
                realized_gains  += pnl
            else:
                realized_losses += abs(pnl)
            lot["remaining"]  -= used
            remaining_to_sell -= used

    open_lots  = [l for l in lots if l["remaining"] > 1e-9]
    cost_basis = sum(l["remaining"] * l["price"] for l in open_lots)

    return {
        "cost_basis":      round(cost_basis, 2),
        "realized_gains":  round(realized_gains, 2),
        "realized_losses": round(realized_losses, 2),
        "net_gain_loss":   round(realized_gains - realized_losses, 2),
        "method_used":     method,
        "open_lots":       [
            {
                "date":      l["date"],
                "price":     round(l["price"],     6),
                "remaining": round(l["remaining"], 8),
                "cost":      round(l["remaining"] * l["price"], 2),
            }
            for l in open_lots
        ],
    }


# ══════════════════════════════════════════════════════════════════════════════
# DIVIDEND TRACKER
# ══════════════════════════════════════════════════════════════════════════════

def get_dividend_data(symbol: str) -> dict:
    """
    Fetch dividend information for a stock using yfinance.

    Returns
    -------
    {
        "symbol": "AAPL",
        "annual_dividend_rate": 0.96,
        "dividend_yield": 0.52,       # percentage, e.g. 0.52 means 0.52 %
        "ex_dividend_date": "2024-02-09",
        "pay_date": "2024-02-15",
        "quarterly_dividend": 0.24,
        "last_12m_dividends": [
            {"date": "2024-02-09", "amount": 0.24},
            ...
        ]
    }
    If the symbol pays no dividends or data is unavailable the numeric fields
    are 0 / None and last_12m_dividends is [].
    """
    sym = symbol.upper().strip()

    cached = _cache_get(f"div_{sym}")
    if cached:
        return cached

    try:
        ticker = yf.Ticker(sym)
        info   = {}
        try:
            info = ticker.info or {}
        except Exception:
            pass

        # ── Annual dividend rate & yield ──────────────────────────────────────
        annual_rate   = float(info.get("dividendRate") or 0)
        raw_yield     = info.get("dividendYield")
        div_yield     = round(float(raw_yield) * 100, 4) if raw_yield else 0.0
        quarterly_div = round(annual_rate / 4, 4) if annual_rate else 0.0

        # ── Ex-dividend date ──────────────────────────────────────────────────
        ex_div_raw  = info.get("exDividendDate")
        ex_div_date = None
        if ex_div_raw:
            try:
                # yfinance returns epoch seconds for some fields
                if isinstance(ex_div_raw, (int, float)):
                    ex_div_date = datetime.fromtimestamp(ex_div_raw).strftime("%Y-%m-%d")
                else:
                    ex_div_date = str(ex_div_raw)[:10]
            except Exception:
                ex_div_date = None

        # ── Pay date (not always available) ──────────────────────────────────
        pay_raw  = info.get("lastDividendDate") or info.get("dividendDate")
        pay_date = None
        if pay_raw:
            try:
                if isinstance(pay_raw, (int, float)):
                    pay_date = datetime.fromtimestamp(pay_raw).strftime("%Y-%m-%d")
                else:
                    pay_date = str(pay_raw)[:10]
            except Exception:
                pay_date = None

        # ── Last 12 months historical dividends ───────────────────────────────
        last_12m: list[dict] = []
        try:
            hist_div = ticker.dividends
            if hist_div is not None and not hist_div.empty:
                cutoff = datetime.now() - timedelta(days=365)
                for ts, amount in hist_div.items():
                    try:
                        # ts is a pandas Timestamp
                        dt = ts.to_pydatetime() if hasattr(ts, "to_pydatetime") else datetime.fromtimestamp(ts)
                        if dt >= cutoff:
                            last_12m.append({
                                "date":   dt.strftime("%Y-%m-%d"),
                                "amount": round(float(amount), 6),
                            })
                    except Exception:
                        continue
                last_12m.sort(key=lambda x: x["date"])
        except Exception as e:
            print(f"⚠️  Dividend history '{sym}': {e}")

        result = {
            "symbol":               sym,
            "annual_dividend_rate": round(annual_rate, 4),
            "dividend_yield":       div_yield,
            "ex_dividend_date":     ex_div_date,
            "pay_date":             pay_date,
            "quarterly_dividend":   quarterly_div,
            "last_12m_dividends":   last_12m,
        }

        # Cache for 10 minutes (dividend data changes infrequently)
        with _price_cache_lock:
            _price_cache[f"div_{sym}"] = (result, time.time() - (_PRICE_TTL - 600))

        return result

    except Exception as e:
        print(f"❌ get_dividend_data '{symbol}': {e}")
        return {
            "symbol":               sym,
            "annual_dividend_rate": 0.0,
            "dividend_yield":       0.0,
            "ex_dividend_date":     None,
            "pay_date":             None,
            "quarterly_dividend":   0.0,
            "last_12m_dividends":   [],
        }
