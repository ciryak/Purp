"""
domain/alerts.py
Alert evaluation logic: RSI, rebalance drift, volume spike, portfolio-down,
and the main check_and_trigger_alerts orchestrator.
"""
from datetime import datetime


def calculate_rsi(prices: list[float], period: int = 14) -> float:
    from domain.scoring import calculate_rsi as _rsi
    return _rsi(prices, period)


def check_advanced_alert(alert, asset_data: dict, portfolio_data: dict = None) -> bool:
    """Evaluate advanced alert conditions. Returns True if alert should fire."""
    alert_type = (getattr(alert, "alert_type", "") or "").strip()
    target     = float(getattr(alert, "target_value", 0) or 0)

    if alert_type in ("rsi_oversold", "rsi_overbought"):
        prices = (asset_data or {}).get("historical_prices") or []
        period = int(getattr(alert, "rsi_period", 14) or 14)
        rsi    = calculate_rsi(prices, period=period)
        return rsi < target if alert_type == "rsi_oversold" else rsi > target

    if alert_type == "rebalance_drift":
        current_alloc = (asset_data or {}).get("current_allocation_pct")
        target_alloc  = getattr(alert, "target_allocation_pct", None)
        threshold     = getattr(alert, "rebalance_threshold_pct", None)
        if threshold is None:
            threshold = target
        if current_alloc is None or target_alloc is None or threshold is None:
            return False
        drift = abs(float(current_alloc) - float(target_alloc))
        return drift >= float(threshold)

    if alert_type == "volume_spike":
        volume_history = (asset_data or {}).get("volume_history") or []
        if len(volume_history) < 2:
            return False
        current_volume   = float(volume_history[-1])
        baseline_window  = volume_history[-21:-1] or volume_history[:-1]
        if not baseline_window:
            return False
        avg_volume = sum(float(v) for v in baseline_window) / len(baseline_window)
        return avg_volume > 0 and current_volume > (target * avg_volume)

    if alert_type == "portfolio_down":
        if not portfolio_data:
            return False
        pct_24h = float(portfolio_data.get("percent_change_24h", 0) or 0)
        return pct_24h <= -target

    return False


def _portfolio_change_24h_for_user(session, user_id: int) -> float:
    from models import Asset
    from sqlmodel import select
    from infrastructure.asset_resolver import get_asset_data

    assets = session.exec(select(Asset).where(Asset.user_id == user_id)).all()
    if not assets:
        return 0.0

    prev_total = 0.0
    curr_total = 0.0
    for a in assets:
        data = get_asset_data(a.symbol)
        if not data:
            continue
        amount        = float(a.amount or 0)
        current_price = float(data.get("current_price") or 0)
        change_pct    = float(data.get("percent_change") or 0)
        if current_price <= 0:
            continue
        prev_price  = current_price / (1 + (change_pct / 100)) if change_pct != -100 else current_price
        curr_total += amount * current_price
        prev_total += amount * prev_price

    if prev_total <= 0:
        return 0.0
    return ((curr_total - prev_total) / prev_total) * 100


def _get_volume_history(symbol: str, days: int = 21) -> list[float]:
    from gateways.binance import _is_binance_crypto, _is_likely_stock, _BINANCE_BASE, _BINANCE_HEADERS
    import requests

    base = (symbol or "").upper().strip().replace("-USD", "")
    if not base:
        return []

    if not _is_likely_stock(base) and _is_binance_crypto(base):
        try:
            r = requests.get(
                f"{_BINANCE_BASE}/api/v3/klines",
                params={"symbol": f"{base}USDT", "interval": "1d", "limit": max(2, days)},
                headers=_BINANCE_HEADERS,
                timeout=8,
            )
            r.raise_for_status()
            return [float(k[5]) for k in r.json()]
        except Exception as e:
            print(f"⚠️  Binance volume '{base}': {e}")

    from gateways.yahoo import get_volume_history_yf
    return get_volume_history_yf(symbol, days=days)


def check_and_trigger_alerts(session, send_email_callback) -> None:
    from models import PriceAlert, User, Asset
    from sqlmodel import select
    from infrastructure.asset_resolver import get_asset_data
    try:
        active_alerts = session.exec(
            select(PriceAlert).where(PriceAlert.active.is_(True), PriceAlert.triggered.is_(False))
        ).all()

        if not active_alerts:
            return

        print(f"🔍 Checking {len(active_alerts)} active alerts…")

        alerts_by_symbol:         dict[str, list] = {}
        portfolio_alerts_by_user: dict[int, list] = {}

        for alert in active_alerts:
            if alert.alert_type == "portfolio_down":
                portfolio_alerts_by_user.setdefault(alert.user_id, []).append(alert)
                continue
            symbol = (alert.symbol or "").upper().strip()
            if symbol:
                alerts_by_symbol.setdefault(symbol, []).append(alert)

        for symbol, alerts in alerts_by_symbol.items():
            try:
                data = get_asset_data(symbol)
                if not data:
                    continue

                current_price  = data["current_price"]
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
                    elif alert.alert_type in {"rsi_oversold", "rsi_overbought", "rebalance_drift", "volume_spike"}:
                        adv_asset_data = {
                            "current_price":  current_price,
                            "percent_change": percent_change,
                        }

                        if alert.alert_type in {"rsi_oversold", "rsi_overbought"}:
                            from infrastructure.asset_resolver import get_historical_data
                            hist = get_historical_data(symbol, period="1mo")
                            adv_asset_data["historical_prices"] = (hist.get("prices") or [])[-20:]

                        if alert.alert_type == "volume_spike":
                            adv_asset_data["volume_history"] = _get_volume_history(symbol, days=21)

                        if alert.alert_type == "rebalance_drift":
                            user_assets = session.exec(select(Asset).where(Asset.user_id == alert.user_id)).all()
                            total_value      = 0.0
                            this_asset_value = 0.0
                            for a in user_assets:
                                a_data = get_asset_data(a.symbol)
                                if not a_data:
                                    continue
                                pos_value = float(a.amount or 0) * float(a_data.get("current_price") or 0)
                                total_value += pos_value
                                if (a.symbol or "").upper().strip() == symbol:
                                    this_asset_value = pos_value
                            if total_value > 0:
                                adv_asset_data["current_allocation_pct"] = (this_asset_value / total_value) * 100

                        triggered = check_advanced_alert(alert, adv_asset_data)

                    if triggered:
                        alert.triggered    = True
                        alert.triggered_at = str(datetime.now())
                        if not alert.recurring:
                            alert.active = False
                        else:
                            alert.triggered = False
                        session.add(alert)

                        user = session.get(User, alert.user_id)
                        if user and user.email and user.notification_email:
                            send_email_callback(
                                user.email, user.username, symbol,
                                alert.alert_type, alert.target_value, current_price,
                            )
                            print(f"✅ Alert → {user.username}: {symbol} {alert.alert_type}")

            except Exception as e:
                print(f"⚠️  Alert processing for {symbol}: {e}")

        for user_id, alerts in portfolio_alerts_by_user.items():
            try:
                portfolio_change_24h = _portfolio_change_24h_for_user(session, user_id)
                pdata = {"percent_change_24h": portfolio_change_24h}
                for alert in alerts:
                    if not check_advanced_alert(alert, asset_data={}, portfolio_data=pdata):
                        continue

                    alert.triggered    = True
                    alert.triggered_at = str(datetime.now())
                    if not alert.recurring:
                        alert.active = False
                    else:
                        alert.triggered = False
                    session.add(alert)

                    user = session.get(User, alert.user_id)
                    if user and user.email and user.notification_email:
                        send_email_callback(
                            user.email, user.username, "PORTFOLIO",
                            alert.alert_type, alert.target_value, portfolio_change_24h,
                        )
                        print(f"✅ Alert → {user.username}: PORTFOLIO {alert.alert_type}")
            except Exception as e:
                print(f"⚠️  Portfolio alert processing for user={user_id}: {e}")

        session.commit()

    except Exception as e:
        print(f"❌ check_and_trigger_alerts: {e}")
        session.rollback()
