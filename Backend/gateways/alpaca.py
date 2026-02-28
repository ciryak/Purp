"""
gateways/alpaca.py
Alpaca Data API: news, snapshots, asset search. Used as primary when keys are set;
fallback remains Binance/yFinance via asset_resolver.
"""
import os
import requests

_BASE_DATA = "https://data.alpaca.markets"
_BASE_TRADING = "https://paper-api.alpaca.markets"
_BASE_BROKER = "https://broker-api.alpaca.markets"
_TIMEOUT = 10


def _headers():
    key = os.getenv("ALPACA_API_KEY_ID") or os.getenv("APCA_API_KEY_ID")
    secret = os.getenv("ALPACA_API_SECRET_KEY") or os.getenv("APCA_API_SECRET_KEY")
    if not key or not secret:
        return None
    return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}


def alpaca_available() -> bool:
    return _headers() is not None


def get_news(symbols: list[str] | None = None, limit: int = 10) -> list[dict]:
    """Fetch latest news from Alpaca News API. Returns list of {headline, url, summary, created_at, symbols}."""
    h = _headers()
    if not h:
        return []
    params = {"limit": min(50, max(1, limit))}
    if symbols:
        params["symbols"] = ",".join(s[:20] for s in symbols[:20])
    try:
        r = requests.get(
            f"{_BASE_DATA}/v1beta1/news",
            headers=h,
            params=params,
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        news = data.get("news") or data if isinstance(data, list) else []
        return [
            {
                "id": n.get("id"),
                "headline": n.get("headline") or n.get("title", ""),
                "url": n.get("url") or n.get("link", ""),
                "summary": n.get("summary", ""),
                "created_at": n.get("created_at") or n.get("published_at", ""),
                "source": n.get("source", ""),
                "symbols": n.get("symbols") or [],
            }
            for n in news[:limit]
        ]
    except Exception as e:
        print(f"⚠️ Alpaca news: {e}")
        return []


def get_snapshot(symbol: str) -> dict | None:
    """Get latest quote/trade for a stock symbol. Returns {symbol, price, change_pct, prev_close, ...} or None."""
    h = _headers()
    if not h:
        return None
    sym = symbol.upper().strip().replace("-USD", "")
    try:
        r = requests.get(
            f"{_BASE_DATA}/v2/stocks/snapshots",
            headers=h,
            params={"symbols": sym},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        snap = (data.get("snapshots") or {}).get(sym)
        if not snap:
            return None
        quote = snap.get("latestQuote") or {}
        trade = snap.get("latestTrade") or {}
        prev = (snap.get("previousDailyBar") or {})
        ap = prev.get("c") or prev.get("close")
        price = float(trade.get("p") or quote.get("ap") or quote.get("bp") or 0)
        if not price and ap:
            price = float(ap)
        change_pct = None
        if ap and float(ap) and price:
            change_pct = ((price - float(ap)) / float(ap)) * 100
        return {
            "symbol": sym,
            "current_price": price,
            "percent_change": change_pct,
            "prev_close": float(ap) if ap else None,
            "type": "stock",
        }
    except Exception as e:
        print(f"⚠️ Alpaca snapshot '{sym}': {e}")
        return None


def search_assets_alpaca(query: str) -> list[dict]:
    """Search Alpaca tradable assets by symbol or name. Returns list of {symbol, name, type, exchange}."""
    h = _headers()
    if not h or not (query or "").strip():
        return []
    q = query.strip().upper()[:20]
    try:
        r = requests.get(
            f"{_BASE_TRADING}/v2/assets",
            headers=h,
            params={"status": "active", "asset_class": "us_equity"},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        assets = r.json() or []
        out = []
        for a in assets:
            sym = (a.get("symbol") or "").upper()
            name = (a.get("name") or "").strip()
            if not sym or (q not in sym and q not in name.upper()):
                continue
            out.append({
                "symbol": sym,
                "name": name or sym,
                "type": "STOCK",
                "exchange": a.get("exchange", ""),
                "icon": "/logo/" + sym,
            })
            if len(out) >= 10:
                break
        return out[:10]
    except Exception as e:
        print(f"⚠️ Alpaca assets search: {e}")
        return []


def get_top_movers(symbols: list[str]) -> list[dict]:
    """Get snapshots for given symbols and return sorted by percent change (gainers + losers)."""
    h = _headers()
    if not h or not symbols:
        return []
    syms = [s.upper().strip().replace("-USD", "") for s in symbols[:50]]
    try:
        r = requests.get(
            f"{_BASE_DATA}/v2/stocks/snapshots",
            headers=h,
            params={"symbols": ",".join(syms)},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        data = r.json()
        snapshots = data.get("snapshots") or {}
        results = []
        for sym, snap in snapshots.items():
            prev = (snap.get("previousDailyBar") or {})
            close_prev = prev.get("c") or prev.get("close")
            trade = snap.get("latestTrade") or {}
            quote = snap.get("latestQuote") or {}
            price = float(trade.get("p") or quote.get("ap") or quote.get("bp") or 0)
            if close_prev:
                price = price or float(close_prev)
            if not price and close_prev:
                price = float(close_prev)
            change_pct = None
            if close_prev and float(close_prev):
                change_pct = ((price - float(close_prev)) / float(close_prev)) * 100
            results.append({
                "symbol": sym,
                "current_price": price,
                "percent_change": change_pct or 0,
                "type": "stock",
            })
        results.sort(key=lambda x: (x.get("percent_change") or 0), reverse=True)
        return results
    except Exception as e:
        print(f"⚠️ Alpaca movers: {e}")
        return []


def get_asset_logo_url(symbol: str) -> str:
    """Return fallback CDN URL for asset logo (TradingView stocks, CoinCap-style for crypto)."""
    sym = (symbol or "").upper().strip().replace("-USD", "")
    if not sym:
        return ""
    return f"https://s3-symbol-logo.tradingview.com/{sym.lower()}.svg"


def get_logo_image(symbol: str) -> tuple[bytes | None, str]:
    """
    Fetch logo from Alpaca Logo API (Broker API v1beta1/logos). Returns (image_bytes, content_type) or (None, "").
    Tries symbol as-is then, for crypto, symbol+USD (e.g. BTC -> BTCUSD).
    If Broker API is not available (e.g. Data-only keys), falls back to None and caller redirects to CDN.
    """
    h = _headers()
    if not h:
        return None, ""
    sym = (symbol or "").upper().strip().replace("-USD", "")
    if not sym:
        return None, ""
    for try_sym in (sym, f"{sym}USD") if sym not in ("USD",) else (sym,):
        for base in (_BASE_BROKER, _BASE_DATA):
            try:
                r = requests.get(
                    f"{base}/v1beta1/logos/{try_sym}",
                    headers=h,
                    params={"placeholder": "true"},
                    timeout=_TIMEOUT,
                    stream=False,
                )
                if r.status_code == 200 and r.content:
                    content_type = r.headers.get("Content-Type", "image/png").split(";")[0].strip()
                    return r.content, content_type or "image/png"
                if r.status_code == 404:
                    break
                if r.status_code in (401, 403):
                    break
            except Exception as e:
                print(f"⚠️ Alpaca logo '{try_sym}' ({base}): {e}")
    return None, ""
