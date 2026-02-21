"""
Purp — Data & AI services.
Fixes applied:
  - search_symbols always returns 'icon' field (not 'thumb')
  - BTC/ETH hardcoded entries now include real CoinGecko thumb URLs
  - get_asset_data: stocks that contain '.' or start with '^' skip CoinGecko
  - real_symbol for stocks never gets '-USD' suffix unless yfinance requires it
  - Gemini: google-genai v1 API (client.models.generate_content) — verified
  - All timeouts guarded; every function returns safe defaults on error
"""
import os
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

# ── CoinGecko cache ────────────────────────────────────────────────────────────
_cg_cache: dict[str, dict | None] = {
    "btc": {
        "id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
        "thumb": "https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png"
    },
    "bitcoin": {
        "id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
        "thumb": "https://assets.coingecko.com/coins/images/1/thumb/bitcoin.png"
    },
    "eth": {
        "id": "ethereum", "symbol": "eth", "name": "Ethereum",
        "thumb": "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png"
    },
    "ethereum": {
        "id": "ethereum", "symbol": "eth", "name": "Ethereum",
        "thumb": "https://assets.coingecko.com/coins/images/279/thumb/ethereum.png"
    },
    "sol": {
        "id": "solana", "symbol": "sol", "name": "Solana",
        "thumb": "https://assets.coingecko.com/coins/images/4128/thumb/solana.png"
    },
    "bnb": {
        "id": "binancecoin", "symbol": "bnb", "name": "BNB",
        "thumb": "https://assets.coingecko.com/coins/images/825/thumb/bnb-icon2_2x.png"
    },
    "xrp": {
        "id": "ripple", "symbol": "xrp", "name": "XRP",
        "thumb": "https://assets.coingecko.com/coins/images/44/thumb/xrp-symbol-white-128.png"
    },
    "ada": {
        "id": "cardano", "symbol": "ada", "name": "Cardano",
        "thumb": "https://assets.coingecko.com/coins/images/975/thumb/cardano.png"
    },
    "doge": {
        "id": "dogecoin", "symbol": "doge", "name": "Dogecoin",
        "thumb": "https://assets.coingecko.com/coins/images/5/thumb/dogecoin.png"
    },
}

# Known stock tickers — skip CoinGecko for these
_KNOWN_STOCKS = {
    "AAPL","MSFT","GOOGL","GOOG","AMZN","TSLA","NVDA","META","NFLX",
    "AMD","INTC","ORCL","IBM","CRM","ADBE","PYPL","SQ","SHOP",
    "BABA","JD","PDD","TCEHY","BIDU","NIO","LI","XPEV",
    "BRK.B","JPM","BAC","GS","MS","WFC","C",
    "SPY","QQQ","IWM","GLD","SLV","USO","TLT","VTI",
    "^GSPC","^IXIC","^DJI","^BVSP","^FTSE","^N225",
}

_CG_HEADERS = {"User-Agent": "Purp/1.0", "Accept": "application/json"}


def _is_likely_stock(symbol: str) -> bool:
    """Return True if symbol is almost certainly a stock/ETF, not crypto."""
    s = symbol.upper().strip()
    if s in _KNOWN_STOCKS:
        return True
    if s.startswith("^"):
        return True
    if "." in s:  # e.g. BRK.B, HAPV3.SA
        return True
    # All-caps, 1-5 chars with no numeric — could be either; let CoinGecko try
    return False


def _cg_find(symbol: str) -> dict | None:
    """Resolve symbol → CoinGecko coin info dict with caching."""
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
            r = c.get("market_cap_rank")
            return 999_999 if r is None else int(r)

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
    """Return (price_usd, change_24h_pct) with CoinGecko market precision."""
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={
                "vs_currency": "usd",
                "ids": coin_id,
                "precision": "full",
                "price_change_percentage": "24h",
            },
            headers=_CG_HEADERS, timeout=6
        )
        r.raise_for_status()
        payload = r.json() or []
        d = payload[0] if payload else {}
        p = d.get("current_price")
        ch = d.get("price_change_percentage_24h")
        return (float(p) if p else None, float(ch) if ch is not None else None)
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


def _cg_history(coin_id: str, days: int, force_hourly: bool = False) -> dict:
    """Return {"dates": [...], "prices": [...]}."""
    try:
        r = requests.get(
            f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
            params={"vs_currency": "usd", "days": str(days)},
            headers=_CG_HEADERS, timeout=10
        )
        r.raise_for_status()
        raw = r.json().get("prices", [])
        if force_hourly and raw:
            by_hour = {}
            for ms, price in raw:
                hour_key = int(ms // 3_600_000)
                by_hour[hour_key] = (ms, price)
            raw = [by_hour[k] for k in sorted(by_hour.keys())][-24:]
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
    """
    Fetch current price, 24h change, sparkline, and icon for any asset.
    Returns None if asset cannot be resolved.
    """
    if not symbol:
        return None

    symbol = symbol.upper().strip()
    base = symbol.replace("-USD", "").strip()

    def _pct_from_series(series: list[float]) -> float:
        if len(series) < 2 or series[0] <= 0:
            return 0.0
        return ((series[-1] - series[0]) / series[0]) * 100

    # ── 1) Try CoinGecko for likely crypto
    if not _is_likely_stock(base):
        try:
            coin = _cg_find(base)
            if coin and coin.get("id"):
                price, change = _cg_price(coin["id"])
                if price and price > 0:
                    intraday = _cg_history(coin["id"], 1, force_hourly=True)
                    spark = intraday["prices"]
                    change_hourly = _pct_from_series(spark)
                    return {
                        "symbol": base,
                        "real_symbol": base,
                        "current_price": price,
                        "percent_change": change_hourly if spark else (change or 0.0),
                        "history": spark[-40:] if spark else [price],
                        "type": "crypto",
                        "icon": coin.get("thumb") or "",
                    }
        except Exception as e:
            print(f"⚠️  CoinGecko asset '{base}': {e}")

    # ── 2) Fallback to Yahoo Finance
    for sym in [symbol, base, f"{base}-USD"]:
        try:
            ticker = yf.Ticker(sym)
            hist = ticker.history(period="2d", interval="60m")
            if hist.empty:
                continue

            price = float(hist["Close"].iloc[-1])
            closes = [float(v) for v in hist["Close"].tolist() if v is not None][-24:]
            change = _pct_from_series(closes)

            info = {}
            try:
                info = ticker.info or {}
            except Exception:
                pass

            quote_type = info.get("quoteType", "")
            is_crypto = "CRYPTOCURRENCY" in quote_type or sym.endswith("-USD")
            asset_type = "crypto" if is_crypto else "stock"

            # real_symbol: store without -USD for stocks
            real_sym = sym if is_crypto else base

            icon = (
                info.get("logo_url")
                or info.get("image")
                or ""
            )

            return {
                "symbol": base,
                "real_symbol": real_sym,
                "current_price": price,
                "percent_change": change,
                "history": closes[-40:] if closes else [price],
                "type": asset_type,
                "icon": icon,
            }
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

    # Try CoinGecko for crypto
    if not _is_likely_stock(base):
        try:
            coin = _cg_find(base)
            if coin and coin.get("id"):
                days = days_map.get(period, 30)
                result = _cg_history(coin["id"], days, force_hourly=(period == "1d"))
                if result["prices"]:
                    return result
        except Exception as e:
            print(f"⚠️  CoinGecko history '{base}': {e}")

    # Yahoo Finance fallback
    for sym in [symbol, base, f"{base}-USD"]:
        try:
            interval = "60m" if period == "1d" else None
            hist = yf.Ticker(sym).history(period=period, interval=interval) if interval else yf.Ticker(sym).history(period=period)
            if hist.empty:
                continue
            is_intraday = period in ("1d", "5d")
            fmt = "%H:%M" if is_intraday else "%m/%d"
            dates = [d.strftime(fmt) for d in hist.index]
            prices = hist["Close"].tolist()
            if period == "1d":
                dates = dates[-24:]
                prices = prices[-24:]
            return {"dates": dates, "prices": prices}
        except Exception as e:
            print(f"⚠️  yfinance history '{sym}': {e}")
            continue

    return {"dates": [], "prices": []}


def search_symbols(query: str) -> list[dict]:
    """
    Search both CoinGecko and Yahoo Finance.
    Always returns list of {"symbol", "name", "type", "icon"}.
    """
    results: list[dict] = []
    seen: set[str] = set()

    # CoinGecko
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
                    "icon": c.get("thumb") or c.get("large") or "",  # always 'icon'
                })
    except Exception as e:
        print(f"⚠️  CoinGecko search: {e}")

    # Yahoo Finance
    try:
        r = requests.get(
            f"https://query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=6",
            headers={"User-Agent": "Mozilla/5.0"}, timeout=4
        )
        for q in r.json().get("quotes", []):
            sym = (q.get("symbol") or "").upper()
            qtype = (q.get("quoteType") or "").upper()
            # Skip crypto duplicates already found via CoinGecko
            if not sym or sym in seen or qtype == "CRYPTOCURRENCY":
                continue
            seen.add(sym)
            results.append({
                "symbol": sym,
                "name": q.get("shortname") or q.get("longname") or sym,
                "type": "STOCK" if qtype in ("EQUITY", "ETF", "INDEX") else qtype or "STOCK",
                "icon": "",  # Yahoo doesn't provide icons directly
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
    """Safely extract text from Gemini response."""
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
    """Return 1-2 sentence AI analysis for a single asset."""
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
        text = _extract_gemini_text(res)
        return text or "Analysis temporarily unavailable."
    except Exception as e:
        print(f"❌ Gemini error for {symbol}: {e}")
        return f"AI analysis temporarily unavailable."


def get_portfolio_ai_analysis(portfolio_change: float, assets: list[dict]) -> str:
    """Return 2-3 sentence AI analysis for the whole portfolio."""
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
        text = _extract_gemini_text(res)
        return text or "Portfolio analysis temporarily unavailable."
    except Exception as e:
        print(f"❌ Gemini portfolio error: {e}")
        return "Portfolio analysis temporarily unavailable."
