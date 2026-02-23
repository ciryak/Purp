"""
Purp — Data & AI services v4.
Novidades:
  - check_and_trigger_alerts: função para monitorar e disparar alertas
  - get_asset_data agora retorna 'name' do asset
  - Melhorias na cache e performance
"""
import os
import threading
import time
import yfinance as yf
from google import genai
import requests
from datetime import datetime
from dotenv import load_dotenv

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

# ── Price cache (60s TTL) ──────────────────────────────────────────────────────
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

# ── CoinGecko coin info cache ──────────────────────────────────────────────────
_cg_cache: dict[str, dict | None] = {
    "btc":      {"id": "bitcoin",       "symbol": "btc",  "name": "Bitcoin",   "thumb": "https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png"},
    "bitcoin":  {"id": "bitcoin",       "symbol": "btc",  "name": "Bitcoin",   "thumb": "https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png"},
    "eth":      {"id": "ethereum",      "symbol": "eth",  "name": "Ethereum",  "thumb": "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png"},
    "ethereum": {"id": "ethereum",      "symbol": "eth",  "name": "Ethereum",  "thumb": "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png"},
    "sol":      {"id": "solana",        "symbol": "sol",  "name": "Solana",    "thumb": "https://assets.coingecko.com/coins/images/4128/thumb/solana.png"},
    "bnb":      {"id": "binancecoin",   "symbol": "bnb",  "name": "BNB",       "thumb": "https://assets.coingecko.com/coins/images/825/thumb/bnb-icon2_2x.png"},
    "xrp":      {"id": "ripple",        "symbol": "xrp",  "name": "XRP",       "thumb": "https://assets.coingecko.com/coins/images/44/thumb/xrp-symbol-white-128.png"},
    "ada":      {"id": "cardano",       "symbol": "ada",  "name": "Cardano",   "thumb": "https://assets.coingecko.com/coins/images/975/thumb/cardano.png"},
    "doge":     {"id": "dogecoin",      "symbol": "doge", "name": "Dogecoin",  "thumb": "https://assets.coingecko.com/coins/images/5/thumb/dogecoin.png"},
    "avax":     {"id": "avalanche-2",   "symbol": "avax", "name": "Avalanche", "thumb": "https://assets.coingecko.com/coins/images/12559/thumb/Avalanche_Circle_RedWhite_Trans.png"},
    "dot":      {"id": "polkadot",      "symbol": "dot",  "name": "Polkadot",  "thumb": "https://assets.coingecko.com/coins/images/12171/thumb/polkadot.png"},
    "link":     {"id": "chainlink",     "symbol": "link", "name": "Chainlink", "thumb": "https://assets.coingecko.com/coins/images/877/thumb/chainlink-new-logo.png"},
    "matic":    {"id": "matic-network", "symbol": "matic","name": "Polygon",   "thumb": "https://assets.coingecko.com/coins/images/4713/thumb/matic-token-icon.png"},
    "shib":     {"id": "shiba-inu",     "symbol": "shib", "name": "Shiba Inu", "thumb": "https://assets.coingecko.com/coins/images/11939/thumb/shiba.png"},
}

_KNOWN_STOCKS = {
    "AAPL","MSFT","GOOGL","GOOG","AMZN","TSLA","NVDA","META","NFLX",
    "AMD","INTC","ORCL","IBM","CRM","ADBE","PYPL","SQ","SHOP",
    "BABA","JD","PDD","TCEHY","BIDU","NIO","LI","XPEV",
    "BRK.B","JPM","BAC","GS","MS","WFC","C","V","MA","COIN",
    "SPY","QQQ","IWM","GLD","SLV","USO","TLT","VTI","ARKK",
    "^GSPC","^IXIC","^DJI","^BVSP","^FTSE","^N225",
}

_CG_HEADERS = {"User-Agent": "Purp/2.0", "Accept": "application/json"}


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


def _cg_find(symbol: str) -> dict | None:
    s = symbol.lower().strip()
    if s in _cg_cache:
        return _cg_cache[s]

    try:
        r = requests.get(
            f"https://api.coingecko.com/api/v3/search?query={s}",
            headers=_CG_HEADERS, timeout=6
        )
        r.raise_for_status()
        coins = r.json().get("coins", []) or []

        exact = [c for c in coins if (c.get("symbol") or "").lower() == s]
        pool = exact if exact else coins[:3]

        def rank(c):
            rv = c.get("market_cap_rank")
            return 999_999 if rv is None else int(rv)

        best = sorted(pool, key=rank)[0] if pool else None
        if best and best.get("id"):
            result = {
                "id": best["id"],
                "symbol": (best.get("symbol") or "").lower(),
                "name": best.get("name", ""),
                "thumb": best.get("thumb") or best.get("large") or "",
            }
            _cg_cache[s] = result
            return result

        _cg_cache[s] = None
        return None
    except Exception as e:
        print(f"⚠️  CoinGecko search '{s}': {e}")
        _cg_cache[s] = None
        return None


def _cg_price(coin_id: str) -> tuple[float | None, float | None]:
    """Return (price_usd, change_24h_pct)."""
    cached = _cache_get(f"cg_price_{coin_id}")
    if cached:
        return cached.get("price"), cached.get("change")

    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": coin_id, "vs_currencies": "usd", "include_24hr_change": "true"},
            headers=_CG_HEADERS, timeout=6
        )
        r.raise_for_status()
        d = r.json().get(coin_id, {})
        price = float(d["usd"]) if d.get("usd") else None
        change = float(d["usd_24h_change"]) if d.get("usd_24h_change") is not None else None
        if price:
            _cache_set(f"cg_price_{coin_id}", {"price": price, "change": change})
        return price, change
    except Exception as e:
        print(f"⚠️  CoinGecko price '{coin_id}': {e}")
        return None, None


def _cg_spark(coin_id: str, days: int = 1) -> list[float]:
    """Return list of close prices for sparkline."""
    try:
        r = requests.get(
            f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
            params={"vs_currency": "usd", "days": str(days)},
            headers=_CG_HEADERS, timeout=8
        )
        r.raise_for_status()
        prices = r.json().get("prices", [])
        return [float(p[1]) for p in prices if len(p) == 2]
    except Exception as e:
        print(f"⚠️  CoinGecko spark '{coin_id}': {e}")
        return []


def _cg_history(coin_id: str, days: int) -> dict:
    """Return {"dates": [...], "prices": [...]}."""
    try:
        r = requests.get(
            f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
            params={"vs_currency": "usd", "days": str(days)},
            headers=_CG_HEADERS, timeout=10
        )
        r.raise_for_status()
        raw = r.json().get("prices", [])
        is_intraday = days <= 5
        fmt = "%H:%M" if is_intraday else "%m/%d"
        dates, vals = [], []
        for ms, price in raw:
            try:
                dates.append(datetime.fromtimestamp(ms / 1000).strftime(fmt))
                vals.append(float(price))
            except Exception:
                continue
        return {"dates": dates, "prices": vals}
    except Exception as e:
        print(f"⚠️  CoinGecko history '{coin_id}': {e}")
        return {"dates": [], "prices": []}


# ── Public API ─────────────────────────────────────────────────────────────────

def get_asset_data(symbol: str) -> dict | None:
    """Fetch current price, 24h change, sparkline, name and icon for any asset."""
    if not symbol:
        return None

    symbol = symbol.upper().strip()
    base = symbol.replace("-USD", "").strip()

    cached = _cache_get(f"asset_{base}")
    if cached:
        return cached

    # ── 1) CoinGecko for crypto
    if not _is_likely_stock(base):
        try:
            coin = _cg_find(base)
            if coin and coin.get("id"):
                price, change = _cg_price(coin["id"])
                if price and price > 0:
                    spark = _cg_spark(coin["id"], days=1)
                    result = {
                        "symbol": base,
                        "real_symbol": base,
                        "name": coin.get("name", base),
                        "current_price": price,
                        "percent_change": change or _pct_from_series(spark) or 0.0,
                        "history": spark[-40:] if spark else [price],
                        "type": "crypto",
                        "icon": coin.get("thumb") or "",
                    }
                    _cache_set(f"asset_{base}", result)
                    return result
        except Exception as e:
            print(f"⚠️  CoinGecko asset '{base}': {e}")

    # ── 2) Yahoo Finance fallback
    for sym in [symbol, base, f"{base}-USD"]:
        try:
            ticker = yf.Ticker(sym)
            hist = ticker.history(period="1d", interval="15m")
            if hist.empty:
                continue

            price = float(hist["Close"].iloc[-1])
            closes = [float(v) for v in hist["Close"].tolist() if v is not None]
            change = _pct_from_series(closes)

            info = {}
            try:
                info = ticker.info or {}
            except Exception:
                pass

            quote_type = info.get("quoteType", "")
            is_crypto = "CRYPTOCURRENCY" in quote_type or sym.endswith("-USD")
            asset_type = "crypto" if is_crypto else "stock"
            real_sym = sym if is_crypto else base
            icon = info.get("logo_url") or info.get("image") or ""
            name = info.get("shortName") or info.get("longName") or base

            result = {
                "symbol": base,
                "real_symbol": real_sym,
                "name": name,
                "current_price": price,
                "percent_change": change,
                "history": closes[-40:] if closes else [price],
                "type": asset_type,
                "icon": icon,
            }
            _cache_set(f"asset_{base}", result)
            return result
        except Exception as e:
            print(f"⚠️  yfinance '{sym}': {e}")
            continue

    print(f"❌ Could not resolve asset: {symbol}")
    return None


def get_historical_data(symbol: str, period: str = "1mo") -> dict:
    """Return {"dates": [...], "prices": [...]} for a symbol over a period."""
    if not symbol or symbol == "PORTFOLIO":
        return {"dates": [], "prices": []}

    base = symbol.upper().strip().replace("-USD", "")
    days_map = {"1d": 1, "5d": 5, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730}

    if not _is_likely_stock(base):
        try:
            coin = _cg_find(base)
            if coin and coin.get("id"):
                days = days_map.get(period, 30)
                result = _cg_history(coin["id"], days)
                if result["prices"]:
                    return result
        except Exception as e:
            print(f"⚠️  CoinGecko history '{base}': {e}")

    # Yahoo Finance
    yf_interval = "60m" if period == "1d" else "1d"
    for sym in [symbol, base, f"{base}-USD"]:
        try:
            hist = yf.Ticker(sym).history(period=period, interval=yf_interval)
            if hist.empty:
                hist = yf.Ticker(sym).history(period=period)
            if hist.empty:
                continue
            is_intraday = period in ("1d", "5d")
            fmt = "%H:%M" if is_intraday else "%m/%d"
            dates = [d.strftime(fmt) for d in hist.index]
            prices = hist["Close"].tolist()
            return {"dates": dates, "prices": prices}
        except Exception as e:
            print(f"⚠️  yfinance history '{sym}': {e}")
            continue

    return {"dates": [], "prices": []}


def search_symbols(query: str) -> list[dict]:
    """Search CoinGecko and Yahoo Finance. Returns list of {"symbol","name","type","icon"}."""
    results: list[dict] = []
    seen: set[str] = set()

    try:
        r = requests.get(
            f"https://api.coingecko.com/api/v3/search?query={query}",
            headers=_CG_HEADERS, timeout=4
        )
        coins = r.json().get("coins", [])[:5]
        for c in coins:
            sym = (c.get("symbol") or "").upper()
            if sym and sym not in seen:
                seen.add(sym)
                results.append({
                    "symbol": sym,
                    "name": c.get("name", ""),
                    "type": "CRYPTO",
                    "icon": c.get("thumb") or c.get("large") or "",
                })
    except Exception as e:
        print(f"⚠️  CoinGecko search: {e}")

    try:
        r = requests.get(
            f"https://query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=6",
            headers={"User-Agent": "Mozilla/5.0"}, timeout=4
        )
        for q in r.json().get("quotes", []):
            sym = (q.get("symbol") or "").upper()
            qtype = (q.get("quoteType") or "").upper()
            if not sym or sym in seen or qtype == "CRYPTOCURRENCY":
                continue
            seen.add(sym)
            results.append({
                "symbol": sym,
                "name": q.get("shortname") or q.get("longname") or sym,
                "type": "STOCK" if qtype in ("EQUITY", "ETF", "INDEX") else qtype or "STOCK",
                "icon": "",
            })
    except Exception as e:
        print(f"⚠️  Yahoo search: {e}")

    return results[:10]


# ── AI ────────────────────────────────────────────────────────────────────────

def get_ai_status() -> dict:
    return {
        "enabled": _gemini_client is not None,
        "provider": "gemini",
        "status": _gemini_status,
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

def check_and_trigger_alerts(session, send_email_callback) -> None:
    """
    Checa todos os alertas ativos e dispara notificações quando as condições são atingidas.
    Esta função deve ser chamada periodicamente (via cron job ou background task).
    """
    from models import PriceAlert, User
    from sqlmodel import select
    from datetime import datetime
    
    try:
        # Busca todos os alertas ativos
        active_alerts = session.exec(
            select(PriceAlert).where(PriceAlert.active == True, PriceAlert.triggered == False)
        ).all()
        
        if not active_alerts:
            print("📋 No active alerts to check")
            return
        
        print(f"🔍 Checking {len(active_alerts)} active alerts...")
        
        # Agrupa alertas por symbol para otimizar chamadas de API
        alerts_by_symbol: dict[str, list] = {}
        for alert in active_alerts:
            if alert.symbol not in alerts_by_symbol:
                alerts_by_symbol[alert.symbol] = []
            alerts_by_symbol[alert.symbol].append(alert)
        
        # Processa cada symbol
        for symbol, alerts in alerts_by_symbol.items():
            try:
                # Busca dados atuais do asset
                data = get_asset_data(symbol)
                if not data:
                    print(f"⚠️  Could not fetch data for {symbol}")
                    continue
                
                current_price = data["current_price"]
                percent_change = data["percent_change"]
                
                # Checa cada alerta desse symbol
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
                    
                    if triggered:
                        # Atualiza alert
                        alert.triggered = True
                        alert.triggered_at = str(datetime.now())
                        
                        # Se não é recorrente, desativa
                        if not alert.recurring:
                            alert.active = False
                        else:
                            # Se é recorrente, reseta o triggered para que possa disparar novamente
                            alert.triggered = False
                        
                        session.add(alert)
                        
                        # Busca usuário para enviar email
                        user = session.get(User, alert.user_id)
                        if user and user.email and user.notification_email:
                            send_email_callback(
                                user.email,
                                user.username,
                                symbol,
                                alert.alert_type,
                                alert.target_value,
                                current_price
                            )
                            print(f"✅ Alert triggered for {user.username}: {symbol} {alert.alert_type}")
                
            except Exception as e:
                print(f"⚠️  Error processing alerts for {symbol}: {e}")
                continue
        
        # Commit todas as mudanças
        session.commit()
        print("✅ Alert check completed")
        
    except Exception as e:
        print(f"❌ Error in check_and_trigger_alerts: {e}")
        session.rollback()