"""
domain/digest.py
Weekly portfolio digest builder. Aggregates performance, dividends, alerts and
tax opportunities for a single user into a structured payload.
"""
from datetime import datetime, timedelta, timezone
from sqlmodel import select
from models import Asset, Dividend, PriceAlert, Transaction, User
from infrastructure.asset_resolver import get_asset_data, get_historical_data
from domain.tax import calculate_tax_loss_harvesting


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
    now      = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    user   = session.get(User, user_id)
    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()

    performance_rows: list[dict] = []
    start_total = 0.0
    end_total   = 0.0

    for a in assets:
        hist   = get_historical_data(a.symbol, period="7d")
        prices = [float(p) for p in (hist.get("prices") or []) if p is not None]
        if len(prices) < 2:
            data    = get_asset_data(a.symbol)
            current = float((data or {}).get("current_price") or 0)
            prices  = [current, current] if current > 0 else []
        if len(prices) < 2:
            continue

        start_price = prices[0]
        end_price   = prices[-1]
        amount      = float(a.amount or 0)
        start_value = start_price * amount
        end_value   = end_price   * amount

        if start_value <= 0 and end_value <= 0:
            continue

        pct_change = ((end_price - start_price) / start_price) * 100 if start_price > 0 else 0.0
        performance_rows.append({
            "symbol":       a.symbol,
            "start_price":  round(start_price, 4),
            "end_price":    round(end_price,   4),
            "change_pct":   round(pct_change,  2),
            "value_change": round(end_value - start_value, 2),
        })
        start_total += start_value
        end_total   += end_value

    performance_pct = ((end_total - start_total) / start_total) * 100 if start_total > 0 else 0.0
    best  = max(performance_rows, key=lambda x: x["change_pct"],  default=None)
    worst = min(performance_rows, key=lambda x: x["change_pct"],  default=None)

    weekly_dividends = session.exec(select(Dividend).where(Dividend.user_id == user_id)).all()
    dividends_total  = 0.0
    dividends_items  = []
    for d in weekly_dividends:
        pay_date = _parse_iso_date(d.pay_date) or _parse_iso_date(d.recorded_at)
        if pay_date and pay_date.tzinfo is None:
            pay_date = pay_date.replace(tzinfo=timezone.utc)
        if pay_date and pay_date >= week_ago:
            amount = float(d.total_received or 0)
            dividends_total += amount
            dividends_items.append({
                "symbol":   d.symbol,
                "amount":   round(amount, 2),
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

    txs            = session.exec(select(Transaction).where(Transaction.user_id == user_id)).all()
    weekly_tx_count = 0
    for tx in txs:
        tx_dt = _parse_iso_date(tx.date) or _parse_iso_date(tx.created_at)
        if tx_dt and tx_dt.tzinfo is None:
            tx_dt = tx_dt.replace(tzinfo=timezone.utc)
        if tx_dt and tx_dt >= week_ago:
            weekly_tx_count += 1

    # ── AI portfolio insight for the week ────────────────────────────
    ai_insight = ""
    try:
        from gateways.gemini import get_portfolio_ai_analysis
        ai_assets = [
            {
                "symbol":         row["symbol"],
                "type":           "asset",
                "allocation_pct": 0,
                "change_pct":     row["change_pct"],
            }
            for row in performance_rows
        ]
        ai_insight = get_portfolio_ai_analysis(performance_pct, ai_assets)
    except Exception as _ai_err:
        print(f"[WARN] Digest AI insight failed: {_ai_err}")

    tax_opportunities = []
    if user and user.plan == "tax_pro":
        tlh_input = []
        for a in assets:
            ad = get_asset_data(a.symbol)
            if not ad:
                continue
            tlh_input.append({
                "symbol":         a.symbol,
                "current_price":  ad.get("current_price", 0),
                "purchase_price": a.purchase_price,
                "amount":         a.amount,
                "purchase_date":  a.purchase_date,
            })
        tax_opportunities = calculate_tax_loss_harvesting(tlh_input)

    return {
        "window": {
            "start": week_ago.isoformat(),
            "end":   now.isoformat(),
        },
        "performance": {
            "start_value":  round(start_total, 2),
            "end_value":    round(end_total,   2),
            "change_value": round(end_total - start_total, 2),
            "change_pct":   round(performance_pct, 2),
        },
        "best_performer":    best,
        "worst_performer":   worst,
        "dividends": {
            "total": round(dividends_total, 2),
            "items": dividends_items,
        },
        "alerts_triggered":   alert_count,
        "transactions_count": weekly_tx_count,
        "tax_opportunities":  tax_opportunities,
        "is_tax_pro":         bool(user and user.plan == "tax_pro"),
        "ai_insight":         ai_insight,
    }
