"""
gateways/binance.py
All Binance REST API interactions: pair discovery, price tickers, klines, history.
Uses the shared TTLCache from infrastructure.cache.
"""
import threading
import requests
from datetime import datetime

from infrastructure.cache import price_cache

_BINANCE_BASE    = "https://api.binance.com"
_BINANCE_HEADERS = {"User-Agent": "Purp/2.0", "Accept": "application/json"}

_ICON_BASE = "https://assets.coincap.io/assets/icons/{}@2x.png"

_COIN_META: dict[str, dict] = {
    "BTC":  {"name": "Bitcoin",         "id": "btc"},
    "ETH":  {"name": "Ethereum",        "id": "eth"},
    "SOL":  {"name": "Solana",          "id": "sol"},
    "BNB":  {"name": "BNB",             "id": "bnb"},
    "XRP":  {"name": "XRP",             "id": "xrp"},
    "ADA":  {"name": "Cardano",         "id": "ada"},
    "DOGE": {"name": "Dogecoin",        "id": "doge"},
    "AVAX": {"name": "Avalanche",       "id": "avax"},
    "DOT":  {"name": "Polkadot",        "id": "dot"},
    "LINK": {"name": "Chainlink",       "id": "link"},
    "MATIC":{"name": "Polygon",         "id": "matic"},
    "SHIB": {"name": "Shiba Inu",       "id": "shib"},
    "LTC":  {"name": "Litecoin",        "id": "ltc"},
    "UNI":  {"name": "Uniswap",         "id": "uni"},
    "ATOM": {"name": "Cosmos",          "id": "atom"},
    "XLM":  {"name": "Stellar",         "id": "xlm"},
    "ETC":  {"name": "Ethereum Classic","id": "etc"},
    "NEAR": {"name": "NEAR Protocol",   "id": "near"},
    "APT":  {"name": "Aptos",           "id": "apt"},
    "ARB":  {"name": "Arbitrum",        "id": "arb"},
    "OP":   {"name": "Optimism",        "id": "op"},
    "INJ":  {"name": "Injective",       "id": "inj"},
    "SUI":  {"name": "Sui",             "id": "sui"},
    "TRX":  {"name": "TRON",            "id": "trx"},
    "SAND": {"name": "The Sandbox",     "id": "sand"},
    "MANA": {"name": "Decentraland",    "id": "mana"},
    "FTM":  {"name": "Fantom",          "id": "ftm"},
    "ALGO": {"name": "Algorand",        "id": "algo"},
    "AAVE": {"name": "Aave",            "id": "aave"},
    "COMP": {"name": "Compound",        "id": "comp"},
    "MKR":  {"name": "Maker",           "id": "mkr"},
    "HBAR": {"name": "Hedera",          "id": "hbar"},
    "VET":  {"name": "VeChain",         "id": "vet"},
    "THETA":{"name": "Theta Network",   "id": "theta"},
    "GRT":  {"name": "The Graph",       "id": "grt"},
}

_KNOWN_STOCKS = {
    "AAPL","MSFT","GOOGL","GOOG","AMZN","TSLA","NVDA","META","NFLX",
    "AMD","INTC","ORCL","IBM","CRM","ADBE","PYPL","SQ","SHOP",
    "BABA","JD","PDD","TCEHY","BIDU","NIO","LI","XPEV",
    "BRK.B","JPM","BAC","GS","MS","WFC","C","V","MA","COIN",
    "SPY","QQQ","IWM","GLD","SLV","USO","TLT","VTI","ARKK",
    "^GSPC","^IXIC","^DJI","^BVSP","^FTSE","^N225",
}

_binance_usdt_assets: set[str] = set()
_binance_pairs_loaded = False
_binance_pairs_lock   = threading.Lock()


def _coin_icon(symbol: str) -> str:
    meta    = _COIN_META.get(symbol.upper(), {})
    coin_id = meta.get("id") or symbol.lower()
    return _ICON_BASE.format(coin_id)


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
            print(f"[OK] Binance: loaded {len(_binance_usdt_assets)} USDT pairs")
        except Exception as e:
            print(f"[WARN] Binance exchangeInfo failed: {e} - will retry on first price call")


# Kick off pair loading in background thread on import
threading.Thread(target=_load_binance_pairs, daemon=True).start()


def _is_binance_crypto(symbol: str) -> bool:
    """True if symbol trades as {symbol}USDT on Binance."""
    sym = symbol.upper().strip()
    if not _binance_pairs_loaded:
        _load_binance_pairs()
    return sym in _binance_usdt_assets


def _binance_price(symbol: str) -> tuple[float | None, float | None]:
    """Return (price_usd, change_24h_pct) from Binance 24h ticker."""
    sym  = symbol.upper().strip()
    pair = f"{sym}USDT"

    cached = price_cache.get(f"bnb_price_{sym}")
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
        d      = r.json()
        price  = float(d["lastPrice"])
        change = float(d["priceChangePercent"])
        if price > 0:
            price_cache.set(f"bnb_price_{sym}", {"price": price, "change": change})
        return price, change
    except Exception as e:
        print(f"[WARN] Binance price '{sym}': {e}")
        return None, None


def _binance_mini_ticker_batch(symbols: list[str]) -> dict[str, dict]:
    """Fetch prices for multiple symbols at once. Returns {SYMBOL: {price, change}}."""
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
        print(f"[WARN] Binance batch ticker: {e}")
        return {}


def _binance_klines(symbol: str, interval: str = "1h", limit: int = 48) -> list[float]:
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
        return [float(k[4]) for k in r.json()]
    except Exception as e:
        print(f"[WARN] Binance klines '{sym}': {e}")
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
        print(f"[WARN] Binance history '{sym}': {e}")
        return {"dates": [], "prices": []}
