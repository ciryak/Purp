"""
Purp — Data & AI services v4.
Novidades:
  - check_and_trigger_alerts: função para monitorar e disparar alertas
  - get_asset_data agora retorna 'name' do asset
  - Melhorias na cache e performance
  - parse_broker_csv: parser de CSV para múltiplos brokers
"""
import os
import csv
import io
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
        active_alerts = session.exec(
            select(PriceAlert).where(PriceAlert.active == True, PriceAlert.triggered == False)
        ).all()

        if not active_alerts:
            print("📋 No active alerts to check")
            return

        print(f"🔍 Checking {len(active_alerts)} active alerts...")

        alerts_by_symbol: dict[str, list] = {}
        for alert in active_alerts:
            if alert.symbol not in alerts_by_symbol:
                alerts_by_symbol[alert.symbol] = []
            alerts_by_symbol[alert.symbol].append(alert)

        for symbol, alerts in alerts_by_symbol.items():
            try:
                data = get_asset_data(symbol)
                if not data:
                    print(f"⚠️  Could not fetch data for {symbol}")
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

        session.commit()
        print("✅ Alert check completed")

    except Exception as e:
        print(f"❌ Error in check_and_trigger_alerts: {e}")
        session.rollback()


# ══════════════════════════════════════════════════════════════════════════════
# CSV BROKER PARSER
# ══════════════════════════════════════════════════════════════════════════════

def _clean_price(raw: str) -> float:
    """Remove currency symbols, commas, spaces and return float. Returns 0.0 on failure."""
    if not raw:
        return 0.0
    cleaned = raw.strip().replace("$", "").replace(",", "").replace(" ", "")
    try:
        return abs(float(cleaned))   # abs: some brokers export negative amounts for sells
    except ValueError:
        return 0.0


def _normalize_date(raw: str, fmt_hints: list[str] | None = None) -> str:
    """
    Try several datetime formats and return YYYY-MM-DD.
    Falls back to today if parsing fails.
    """
    if not raw:
        return str(datetime.today().date())

    raw = raw.strip()
    formats = fmt_hints or [
        "%Y-%m-%dT%H:%M:%S%z",   # ISO 8601 with tz  (Coinbase)
        "%Y-%m-%dT%H:%M:%SZ",    # ISO 8601 UTC
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S %Z",
        "%Y-%m-%d %H:%M:%S",
        "%m/%d/%Y",               # Robinhood / Fidelity
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

    # Last resort: try dateutil if available
    try:
        from dateutil import parser as du_parser
        return du_parser.parse(raw).strftime("%Y-%m-%d")
    except Exception:
        pass

    return str(datetime.today().date())


def _sniff_delimiter(content: str) -> str:
    """Detect CSV delimiter (comma or semicolon)."""
    first_line = content.split("\n")[0] if "\n" in content else content
    return ";" if first_line.count(";") > first_line.count(",") else ","


def _csv_rows(content: str) -> tuple[list[str], list[dict]]:
    """
    Parse CSV content and return (headers_lower, rows_as_dicts).
    Skips leading comment/blank lines (Coinbase adds a preamble).
    """
    delimiter = _sniff_delimiter(content)
    lines = content.splitlines()

    # Find the header line: first line that has several delimiter-separated tokens
    start_idx = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and len(stripped.split(delimiter)) >= 3:
            start_idx = i
            break

    clean_content = "\n".join(lines[start_idx:])
    reader = csv.DictReader(io.StringIO(clean_content), delimiter=delimiter)
    rows = list(reader)
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    return headers, rows


# ─── Per-broker parsers ───────────────────────────────────────────────────────

def _parse_coinbase(rows: list[dict]) -> list[dict]:
    """
    Columns: Timestamp, Transaction Type, Asset, Quantity Transacted,
             Spot Price Currency, Spot Price at Transaction, Subtotal, Total, Fees, Notes
    """
    TYPE_MAP = {"buy": "buy", "sell": "sell", "advanced trade buy": "buy", "advanced trade sell": "sell"}
    results = []
    for row in rows:
        raw_type = (row.get("Transaction Type") or row.get("transaction type") or "").strip().lower()
        tx_type = TYPE_MAP.get(raw_type)
        if not tx_type:
            continue  # Skip Rewards, Conversions, etc.

        symbol = (row.get("Asset") or row.get("asset") or "").strip().upper()
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
    """
    Columns: Activity Date, Process Date, Settle Date, Instrument,
             Description, Trans Code, Quantity, Price, Amount
    """
    TYPE_MAP = {"buy": "buy", "sell": "sell", "bto": "buy", "sto": "sell"}
    results = []
    for row in rows:
        trans_code = (row.get("Trans Code") or row.get("trans code") or "").strip().lower()
        tx_type = TYPE_MAP.get(trans_code)
        if not tx_type:
            continue

        symbol   = (row.get("Instrument") or row.get("instrument") or "").strip().upper()
        qty_raw  = row.get("Quantity") or row.get("quantity") or "0"
        price_raw= row.get("Price") or row.get("price") or "0"
        date_raw = row.get("Activity Date") or row.get("activity date") or ""

        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)

        if not symbol or amount <= 0:
            continue

        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_fidelity(rows: list[dict]) -> list[dict]:
    """
    Columns: Run Date, Account, Action, Symbol, Description,
             Type, Quantity, Price, Commission, Amount
    Keeps only rows where Action contains BOUGHT or SOLD.
    """
    results = []
    for row in rows:
        action = (row.get("Action") or row.get("action") or "").strip().upper()
        if "BOUGHT" in action:
            tx_type = "buy"
        elif "SOLD" in action:
            tx_type = "sell"
        else:
            continue

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
    """
    Columns: txid, refid, time, type, subtype, aclass, asset, amount, fee, balance
    Keeps only rows where type == "trade".
    Pairs buy/sell by sign of `amount`: positive → buy, negative → sell.
    """
    results = []
    for row in rows:
        tx_type_raw = (row.get("type") or "").strip().lower()
        if tx_type_raw != "trade":
            continue

        asset_raw = (row.get("asset") or "").strip().upper()
        # Kraken uses symbols like XXBT (BTC), XETH (ETH) — strip leading X/Z
        symbol = asset_raw
        if len(symbol) == 4 and symbol[0] in ("X", "Z") and symbol[1:] in (
            "BTC", "ETH", "LTC", "XRP", "XLM", "EOS", "BCH", "ADA"
        ):
            symbol = symbol[1:]
        if symbol in ("XXBT", "XBT"):
            symbol = "BTC"
        if symbol in ("XETH",):
            symbol = "ETH"
        if symbol.endswith(".S"):   # staking variants
            symbol = symbol[:-2]

        amount_raw = (row.get("amount") or "0").strip()
        try:
            raw_amount = float(amount_raw)
        except ValueError:
            continue

        # Determine direction from sign; skip fees/staking rows with 0 amount
        if raw_amount == 0:
            continue
        tx_type = "buy" if raw_amount > 0 else "sell"
        amount = abs(raw_amount)

        # Kraken doesn't include price per unit — compute from amount and total if available
        # Fallback: use 0 (will be resolved at import time via market data)
        price = 0.0
        date_raw = row.get("time") or ""
        date = _normalize_date(date_raw)

        if not symbol:
            continue

        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_schwab(rows: list[dict]) -> list[dict]:
    """
    Charles Schwab export.
    Columns: Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount
    Keeps Buy and Sell actions.
    """
    results = []
    for row in rows:
        action = (row.get("Action") or row.get("action") or "").strip()
        action_upper = action.upper()
        if "BUY" in action_upper:
            tx_type = "buy"
        elif "SELL" in action_upper:
            tx_type = "sell"
        else:
            continue

        symbol    = (row.get("Symbol") or row.get("symbol") or "").strip().upper()
        qty_raw   = row.get("Quantity") or row.get("quantity") or "0"
        price_raw = row.get("Price") or row.get("price") or "0"
        date_raw  = row.get("Date") or row.get("date") or ""

        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)

        if not symbol or amount <= 0:
            continue

        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


# ─── Public entry point ───────────────────────────────────────────────────────

SUPPORTED_BROKERS = ("coinbase", "robinhood", "fidelity", "kraken", "schwab")

def parse_broker_csv(content: str, broker: str) -> list[dict]:
    """
    Parse a broker CSV export and return a list of normalised transaction dicts:
        {symbol: str, type: "buy"|"sell", amount: float, price: float, date: "YYYY-MM-DD"}

    Raises ValueError with a descriptive message for unrecognised brokers or
    structurally invalid files.

    Supported brokers: coinbase, robinhood, fidelity, kraken, schwab
    """
    broker = broker.strip().lower()

    if broker not in SUPPORTED_BROKERS:
        raise ValueError(
            f"Unsupported broker '{broker}'. "
            f"Supported brokers: {', '.join(SUPPORTED_BROKERS)}."
        )

    if not content or not content.strip():
        raise ValueError("CSV file is empty.")

    try:
        headers, rows = _csv_rows(content)
    except Exception as e:
        raise ValueError(f"Could not parse CSV file: {e}")

    if not rows:
        raise ValueError("CSV file contains no data rows.")

    # Dispatch
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

    # Basic validation: ensure required fields exist on every row
    validated = []
    for i, tx in enumerate(transactions):
        missing = [f for f in ("symbol", "type", "amount", "price", "date") if f not in tx]
        if missing:
            print(f"⚠️  Row {i} missing fields {missing} — skipped")
            continue
        if tx["type"] not in ("buy", "sell"):
            print(f"⚠️  Row {i} invalid type '{tx['type']}' — skipped")
            continue
        validated.append(tx)

    return validated


# ── TAX LOSS HARVESTING ────────────────────────────────────────────────────────

# Suggested replacements for tax-loss harvesting (avoids wash sale rule)
_TLH_REPLACEMENTS: dict[str, str] = {
    # ETFs
    "SPY": "VOO", "VOO": "IVV", "IVV": "SPY", "QQQ": "QQQM",
    "QQQM": "QQQ", "IWM": "VB", "VB": "IWM", "GLD": "IAU",
    "IAU": "GLD", "SLV": "SIVR", "TLT": "IEF", "ARKK": "CTEC",
    # Tech stocks
    "AAPL": "MSFT", "MSFT": "AAPL", "GOOGL": "META", "GOOG": "META",
    "META": "SNAP", "NVDA": "AMD", "AMD": "INTC", "TSLA": "RIVN",
    "AMZN": "SHOP", "NFLX": "DIS", "PYPL": "SQ", "SQ": "PYPL",
    "COIN": "MSTR",
    # Crypto
    "BTC": "ETH", "ETH": "BTC", "SOL": "AVAX", "AVAX": "DOT",
    "DOT": "LINK", "LINK": "UNI", "BNB": "CRO", "XRP": "XLM",
    "ADA": "ALGO", "DOGE": "SHIB", "SHIB": "DOGE", "MATIC": "FTM",
}


def calculate_tax_loss_harvesting(
    assets: list[dict],
    tax_bracket: float = 0.22,
) -> list[dict]:
    """
    Identify tax-loss harvesting opportunities from a user's portfolio.

    Parameters
    ----------
    assets      : list of dicts with keys:
                  symbol, amount, purchase_price, current_price, purchase_date
    tax_bracket : marginal federal tax rate (default 22 %)

    Returns
    -------
    List of opportunity dicts, sorted by estimated_tax_saved descending.
    Only positions with unrealized loss > $50 are included.
    """
    from datetime import date, datetime, timedelta

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

            # Only include if loss exceeds $50
            if unrealized_loss >= -50:
                continue

            # Holding period
            purchase_date_raw = asset.get("purchase_date") or str(today)
            try:
                pd = datetime.strptime(str(purchase_date_raw)[:10], "%Y-%m-%d").date()
            except ValueError:
                pd = today

            holding_days = (today - pd).days
            gain_type    = "short_term" if holding_days < 365 else "long_term"

            # Tax rate depends on gain type
            # Long-term rate approximation: if bracket <= 22 % → 0 %, else 15 % or 20 %
            if gain_type == "long_term":
                effective_rate = 0.0 if tax_bracket <= 0.12 else (0.15 if tax_bracket <= 0.35 else 0.20)
            else:
                effective_rate = tax_bracket

            estimated_tax_saved  = abs(unrealized_loss) * effective_rate
            wash_sale_safe_date  = (today + timedelta(days=31)).strftime("%Y-%m-%d")
            suggested_replacement = _TLH_REPLACEMENTS.get(symbol, f"{symbol}2")  # fallback hint

            opportunities.append({
                "symbol":               symbol,
                "unrealized_loss":      round(unrealized_loss, 2),
                "estimated_tax_saved":  round(estimated_tax_saved, 2),
                "holding_days":         holding_days,
                "gain_type":            gain_type,
                "wash_sale_safe_date":  wash_sale_safe_date,
                "suggested_replacement": suggested_replacement,
                "current_price":        round(current_price, 6),
                "purchase_price":       round(purchase_price, 6),
                "amount":               amount,
                "effective_rate_pct":   round(effective_rate * 100, 1),
            })

        except Exception as e:
            print(f"⚠️  TLH calc error for {asset.get('symbol')}: {e}")
            continue

    opportunities.sort(key=lambda x: x["estimated_tax_saved"], reverse=True)
    return opportunities


# ── COST BASIS METHODS ─────────────────────────────────────────────────────────

def calculate_cost_basis(
    transactions: list[dict],
    method: str = "FIFO",
) -> dict:
    """
    Calculate cost basis and realized gains/losses for a set of transactions.

    Supported methods:
        FIFO  — First In, First Out  (IRS default)
        LIFO  — Last In, First Out
        HIFO  — Highest In, First Out (minimizes taxes)
        SPEC  — Specific Identification (uses lot_id field on each tx)

    Parameters
    ----------
    transactions : list of dicts with keys:
                   type ('buy'|'sell'), amount, price, date
                   Optional: lot_id (for SPEC method)

    Returns
    -------
    {
        cost_basis       : total cost of remaining open lots,
        realized_gains   : total gains from closed lots,
        realized_losses  : total losses from closed lots (positive number),
        net_gain_loss    : net realized P&L,
        method_used      : method string,
        open_lots        : list of remaining open lots,
    }
    """
    from datetime import datetime

    method = method.upper().strip()
    if method not in ("FIFO", "LIFO", "HIFO", "SPEC"):
        method = "FIFO"

    # Separate buys (lots) and sells, sorted by date
    buys  = sorted(
        [t for t in transactions if (t.get("type") or "").lower() == "buy"],
        key=lambda t: t.get("date") or "0000-00-00",
    )
    sells = sorted(
        [t for t in transactions if (t.get("type") or "").lower() == "sell"],
        key=lambda t: t.get("date") or "0000-00-00",
    )

    # Build open lots list: each entry is a mutable dict
    lots = [
        {
            "date":   b.get("date",  ""),
            "price":  float(b.get("price",  0) or 0),
            "amount": float(b.get("amount", 0) or 0),
            "lot_id": b.get("lot_id", None),
            "remaining": float(b.get("amount", 0) or 0),
        }
        for b in buys
        if float(b.get("amount", 0) or 0) > 0 and float(b.get("price", 0) or 0) > 0
    ]

    realized_gains   = 0.0
    realized_losses  = 0.0

    for sell in sells:
        sell_amount = float(sell.get("amount", 0) or 0)
        sell_price  = float(sell.get("price",  0) or 0)
        if sell_amount <= 0 or sell_price <= 0:
            continue

        remaining_to_sell = sell_amount

        # Sort lots according to method
        if method == "FIFO":
            ordered = sorted(lots, key=lambda l: l["date"])
        elif method == "LIFO":
            ordered = sorted(lots, key=lambda l: l["date"], reverse=True)
        elif method == "HIFO":
            ordered = sorted(lots, key=lambda l: l["price"], reverse=True)
        else:  # SPEC — match by lot_id, fallback to FIFO
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
                realized_gains += pnl
            else:
                realized_losses += abs(pnl)

            lot["remaining"]  -= used
            remaining_to_sell -= used

    # Sum remaining open lots for cost basis
    open_lots = [l for l in lots if l["remaining"] > 1e-9]
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
                "price":     round(l["price"], 6),
                "remaining": round(l["remaining"], 8),
                "cost":      round(l["remaining"] * l["price"], 2),
            }
            for l in open_lots
        ],
    }