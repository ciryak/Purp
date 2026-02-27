"""
gateways/yahoo.py
Yahoo Finance (yfinance) interactions: historical price series and volume history.
"""
import yfinance as yf


def get_historical_data_yf(symbol: str, period: str = "1mo") -> dict:
    """
    Return {dates: [...], prices: [...]} for a symbol over a period using yfinance.
    Tries symbol variants (base, base-USD) before giving up.
    """
    base = symbol.upper().strip().replace("-USD", "")
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


def get_asset_data_yf(symbol: str) -> dict | None:
    """
    Fetch current price, 24h change, sparkline, name, icon and type via yfinance.
    Returns None if the symbol cannot be resolved.
    """
    base = symbol.upper().strip().replace("-USD", "")

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
                _coin_icon_yf(base) if is_crypto else ""
            )
            name = info.get("shortName") or info.get("longName") or base

            return {
                "symbol":         base,
                "real_symbol":    real_sym,
                "name":           name,
                "current_price":  price,
                "percent_change": change,
                "history":        closes[-40:] if closes else [price],
                "type":           asset_type,
                "icon":           icon,
            }
        except Exception as e:
            print(f"⚠️  yfinance '{sym}': {e}")
            continue

    return None


def get_volume_history_yf(symbol: str, days: int = 21) -> list[float]:
    """Return a daily volume series for a stock/ETF using yfinance."""
    base = (symbol or "").upper().strip().replace("-USD", "")
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


def _pct_from_series(series: list[float]) -> float:
    if len(series) < 2 or series[0] <= 0:
        return 0.0
    return ((series[-1] - series[0]) / series[0]) * 100


def _coin_icon_yf(symbol: str) -> str:
    return f"https://assets.coincap.io/assets/icons/{symbol.lower()}@2x.png"
