"""
infrastructure/asset_resolver.py
Orchestrates the gateway chain to resolve any asset symbol into a normalised
price/metadata dict. Resolution order:
  1. Binance  (crypto)
  2. Yahoo Finance  (stocks + coins not on Binance)
  3. CoinCap  (crypto fallback, free, no key)
  4. Finnhub  (stock fallback, requires FINNHUB_API_KEY)

Also provides get_historical_data() and search_symbols() which main.py needs.
"""
import requests
from infrastructure.cache import price_cache
from gateways.binance import (
    _is_binance_crypto,
    _is_likely_stock,
    _binance_price,
    _binance_klines,
    _binance_history,
    _binance_usdt_assets,
    _binance_pairs_loaded,
    _load_binance_pairs,
    _COIN_META,
    _pct_from_series,
)
from gateways.yahoo import get_asset_data_yf, get_historical_data_yf, get_volume_history_yf
from gateways.coincap import get_asset_coincap, get_asset_finnhub


def get_asset_data(symbol: str) -> dict | None:
    """
    Fetch current price, 24h change, sparkline, name and icon for any asset.
    Uses a 15-second TTL cache to avoid redundant API calls.
    """
    if not symbol:
        return None

    symbol = symbol.upper().strip()
    base   = symbol.replace("-USD", "").strip()

    cached = price_cache.get(f"asset_{base}")
    if cached:
        return cached

    # 1) Binance for crypto
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
                    "icon":           "/logo/" + base,
                }
                price_cache.set(f"asset_{base}", result)
                return result
        except Exception as e:
            print(f"⚠️  Binance asset '{base}': {e}")

    # 2) Yahoo Finance fallback (stocks, indices, coins not on Binance)
    result = get_asset_data_yf(symbol)
    if result:
        result["icon"] = result.get("icon") or "/logo/" + base
        price_cache.set(f"asset_{base}", result)
        return result

    # 3) CoinCap fallback (crypto)
    if not _is_likely_stock(base):
        result = get_asset_coincap(base)
        if result:
            result["icon"] = result.get("icon") or "/logo/" + base
            price_cache.set(f"asset_{base}", result)
            return result

    # 4) Finnhub fallback (stocks)
    if _is_likely_stock(base):
        result = get_asset_finnhub(base)
        if result:
            result["icon"] = result.get("icon") or "/logo/" + base
            price_cache.set(f"asset_{base}", result)
            return result

    print(f"❌ Could not resolve asset: {symbol}")
    return None


def get_historical_data(symbol: str, period: str = "1mo") -> dict:
    """Return {dates: [...], prices: [...]} for a symbol over a period."""
    if not symbol or symbol == "PORTFOLIO":
        return {"dates": [], "prices": []}

    base     = symbol.upper().strip().replace("-USD", "")
    days_map = {"1d": 1, "5d": 5, "7d": 7, "1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730}

    # Binance crypto
    if not _is_likely_stock(base) and _is_binance_crypto(base):
        try:
            days   = days_map.get(period, 30)
            result = _binance_history(base, days)
            if result["prices"]:
                return result
        except Exception as e:
            print(f"⚠️  Binance history '{base}': {e}")

    # Yahoo Finance (stocks + coins not on Binance)
    return get_historical_data_yf(symbol, period)


def search_symbols(query: str) -> list[dict]:
    """Search Binance (crypto) + Yahoo Finance (stocks). Returns list of result dicts."""
    results: list[dict] = []
    seen:    set[str]   = set()

    q_upper = query.upper().strip()

    # 1) Binance symbol match
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
                "icon":   "/logo/" + sym,
            })

    # 2) Yahoo Finance stock/ETF search
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
                "icon":   "/logo/" + sym,
            })
    except Exception as e:
        print(f"⚠️  Yahoo search: {e}")

    return results[:10]
