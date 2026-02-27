"""
gateways/coincap.py
Fallback price sources: CoinCap (free, no API key) and Finnhub (free tier with API key).
Used by infrastructure/asset_resolver.py when Binance and yfinance both fail.
"""
import os
import requests


_ICON_BASE = "https://assets.coincap.io/assets/icons/{}@2x.png"


def _coin_icon(symbol: str) -> str:
    return _ICON_BASE.format(symbol.lower())


def get_asset_coincap(symbol: str) -> dict | None:
    """
    Fetch price data for a crypto asset from CoinCap.
    Returns a normalised asset dict or None on failure.
    """
    base = symbol.upper().strip()
    try:
        r = requests.get(
            f"https://api.coincap.io/v2/assets/{base.lower()}",
            headers={"User-Agent": "Purp/2.0"},
            timeout=8,
        )
        if not r.ok:
            return None
        j = r.json()
        d = j.get("data") or {}
        price = float(d.get("priceUsd") or 0)
        if price <= 0:
            return None
        ch     = d.get("changePercent24Hr")
        change = float(ch) if ch is not None else 0.0
        return {
            "symbol":         base,
            "real_symbol":    base,
            "name":           d.get("name") or base,
            "current_price":  price,
            "percent_change": change,
            "history":        [price],
            "type":           "crypto",
            "icon":           _coin_icon(base),
        }
    except Exception as e:
        print(f"⚠️  CoinCap fallback '{base}': {e}")
        return None


def get_asset_finnhub(symbol: str) -> dict | None:
    """
    Fetch quote for a stock from Finnhub (requires FINNHUB_API_KEY env var).
    Returns a normalised asset dict or None on failure / missing key.
    """
    finnhub_key = os.getenv("FINNHUB_API_KEY", "").strip()
    if not finnhub_key:
        return None

    base = symbol.upper().strip()
    try:
        r = requests.get(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": base},
            headers={"X-Finnhub-Token": finnhub_key},
            timeout=8,
        )
        if not r.ok:
            return None
        j     = r.json()
        price = float(j.get("c") or j.get("pc") or 0)
        if price <= 0:
            return None
        prev   = float(j.get("pc") or price)
        change = ((price - prev) / prev * 100) if prev else 0.0
        return {
            "symbol":         base,
            "real_symbol":    base,
            "name":           base,
            "current_price":  price,
            "percent_change": change,
            "history":        [price],
            "type":           "stock",
            "icon":           "",
        }
    except Exception as e:
        print(f"⚠️  Finnhub fallback '{base}': {e}")
        return None
