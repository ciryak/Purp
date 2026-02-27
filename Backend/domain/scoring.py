"""
domain/scoring.py
Portfolio scoring and RSI calculation — pure business logic, no I/O.
"""


def calculate_rsi(prices: list[float], period: int = 14) -> float:
    """Calculate standard RSI (0-100) from a close-price series."""
    if not prices or len(prices) < 2:
        return 50.0

    period = max(1, int(period or 14))
    closes = [float(p) for p in prices if p is not None]
    if len(closes) < period + 1:
        return 50.0

    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains  = [max(d, 0.0)       for d in deltas]
    losses = [abs(min(d, 0.0))  for d in deltas]

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(deltas)):
        avg_gain = ((avg_gain * (period - 1)) + gains[i]) / period
        avg_loss = ((avg_loss * (period - 1)) + losses[i]) / period

    if avg_loss == 0:
        return 100.0

    rs  = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    return max(0.0, min(100.0, float(rsi)))


def calculate_portfolio_score(enriched_assets: list[dict], txs: list) -> dict:
    """
    Compute portfolio grade (A–D) plus numeric sub-scores for diversification,
    risk, tax efficiency and consistency.

    Returns:
        {
            grade: str,
            overall: int (0-100),
            diversification: int,
            risk: int,
            tax_efficiency: int | None,
            consistency: int,
            score_trend: int,
            insights: list[str],
        }
    """
    total_value   = sum(float(a.get("position_value") or 0) for a in enriched_assets)
    n_positions   = len(enriched_assets)

    # ── Diversification score (0-100) ─────────────────────────────────────────
    if n_positions == 0:
        diversification = 0
    elif n_positions >= 15:
        diversification = 100
    elif n_positions >= 10:
        diversification = 80
    elif n_positions >= 5:
        diversification = 60
    elif n_positions >= 3:
        diversification = 40
    elif n_positions >= 2:
        diversification = 25
    else:
        diversification = 10

    # ── Concentration penalty: largest position > 60 % → reduce score ─────────
    if total_value > 0 and n_positions > 0:
        max_alloc = max(
            float(a.get("position_value") or 0) / total_value * 100
            for a in enriched_assets
        )
        if max_alloc > 80:
            diversification = max(0, diversification - 30)
        elif max_alloc > 60:
            diversification = max(0, diversification - 15)

    # ── Risk-adjusted score (0-100) ────────────────────────────────────────────
    # Proxy: mix of asset types; more variety = lower concentrated risk
    types = {(a.get("type") or "stock").lower() for a in enriched_assets}
    risk  = 50
    if len(types) >= 2:
        risk = 70
    if n_positions >= 5 and len(types) >= 2:
        risk = 80
    if n_positions >= 10:
        risk = 90

    # ── Tax efficiency (0-100, only for tax_pro) ──────────────────────────────
    tax_efficiency = None
    if enriched_assets and any(a.get("is_tax_pro") for a in enriched_assets):
        long_term    = sum(1 for a in enriched_assets if int(a.get("days_held") or 0) >= 365)
        pct_long     = (long_term / len(enriched_assets)) * 100 if enriched_assets else 0
        tax_efficiency = min(100, max(0, round(pct_long)))

    # ── Consistency (0-100): based on number of transactions showing regular activity
    consistency = 50
    if txs:
        tx_count    = len(txs)
        consistency = min(100, 50 + tx_count * 5)

    # ── Overall score ──────────────────────────────────────────────────────────
    components = [diversification, risk, consistency]
    if tax_efficiency is not None:
        components.append(tax_efficiency)
    overall = round(sum(components) / len(components))

    # ── Grade ──────────────────────────────────────────────────────────────────
    if overall >= 80:
        grade = "A"
    elif overall >= 60:
        grade = "B"
    elif overall >= 40:
        grade = "C"
    else:
        grade = "D"

    # ── Insights ──────────────────────────────────────────────────────────────
    insights: list[str] = []
    if n_positions == 1:
        insights.append("Consider diversifying — single-asset portfolios carry high concentration risk.")
    if total_value > 0 and n_positions > 0:
        max_alloc = max(
            float(a.get("position_value") or 0) / total_value * 100
            for a in enriched_assets
        )
        if max_alloc > 60:
            sym = max(enriched_assets, key=lambda a: float(a.get("position_value") or 0)).get("symbol", "")
            insights.append(f"{sym} represents {max_alloc:.0f}% of your portfolio — consider rebalancing.")
    if tax_efficiency is not None and tax_efficiency < 40:
        insights.append("Most positions are short-term. Holding >1 year can reduce capital gains tax.")

    return {
        "grade":           grade,
        "overall":         overall,
        "diversification": diversification,
        "risk":            risk,
        "tax_efficiency":  tax_efficiency,
        "consistency":     consistency,
        "score_trend":     15,
        "insights":        insights,
    }
