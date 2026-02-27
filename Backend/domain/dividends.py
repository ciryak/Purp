"""
domain/dividends.py
Dividend data fetching via yfinance. Uses the shared price_cache with a 10-minute TTL.
"""
import yfinance as yf
from datetime import datetime, timedelta
from infrastructure.cache import price_cache


def get_dividend_data(symbol: str) -> dict:
    """
    Fetch dividend information for a stock using yfinance.

    Returns
    -------
    {
        "symbol": str,
        "annual_dividend_rate": float,
        "dividend_yield": float,        # e.g. 0.52 means 0.52%
        "ex_dividend_date": str | None,
        "pay_date": str | None,
        "quarterly_dividend": float,
        "last_12m_dividends": [{"date": str, "amount": float}, ...]
    }
    If the symbol pays no dividends the numeric fields are 0 / None.
    """
    sym = symbol.upper().strip()

    cached = price_cache.get(f"div_{sym}")
    if cached:
        return cached

    try:
        ticker = yf.Ticker(sym)
        info   = {}
        try:
            info = ticker.info or {}
        except Exception:
            pass

        annual_rate   = float(info.get("dividendRate") or 0)
        raw_yield     = info.get("dividendYield")
        div_yield     = round(float(raw_yield) * 100, 4) if raw_yield else 0.0
        quarterly_div = round(annual_rate / 4, 4) if annual_rate else 0.0

        ex_div_raw  = info.get("exDividendDate")
        ex_div_date = None
        if ex_div_raw:
            try:
                if isinstance(ex_div_raw, (int, float)):
                    ex_div_date = datetime.fromtimestamp(ex_div_raw).strftime("%Y-%m-%d")
                else:
                    ex_div_date = str(ex_div_raw)[:10]
            except Exception:
                ex_div_date = None

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

        last_12m: list[dict] = []
        try:
            hist_div = ticker.dividends
            if hist_div is not None and not hist_div.empty:
                cutoff = datetime.now() - timedelta(days=365)
                for ts, amount in hist_div.items():
                    try:
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
        price_cache.set(f"div_{sym}", result, ttl_override=600)
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
