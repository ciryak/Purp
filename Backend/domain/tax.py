"""
domain/tax.py
Tax-related financial calculations: Tax Loss Harvesting, cost basis (FIFO/LIFO/HIFO/SPEC)
and IRS Form 8949 generation. Pure business logic — no I/O.
"""
from datetime import date, datetime, timedelta


_TLH_REPLACEMENTS: dict[str, str] = {
    "SPY": "VOO",  "VOO": "IVV",   "IVV": "SPY",   "QQQ": "QQQM",
    "QQQM": "QQQ", "IWM": "VB",    "VB": "IWM",    "GLD": "IAU",
    "IAU": "GLD",  "SLV": "SIVR",  "TLT": "IEF",   "ARKK": "CTEC",
    "AAPL": "MSFT","MSFT": "AAPL", "GOOGL": "META", "GOOG": "META",
    "META": "SNAP","NVDA": "AMD",  "AMD": "INTC",   "TSLA": "RIVN",
    "AMZN": "SHOP","NFLX": "DIS",  "PYPL": "SQ",    "SQ": "PYPL",
    "COIN": "MSTR",
    "BTC": "ETH",  "ETH": "BTC",   "SOL": "AVAX",  "AVAX": "DOT",
    "DOT": "LINK", "LINK": "UNI",  "BNB": "CRO",   "XRP": "XLM",
    "ADA": "ALGO", "DOGE": "SHIB", "SHIB": "DOGE", "MATIC": "FTM",
}


def calculate_tax_loss_harvesting(
    assets: list[dict],
    tax_bracket: float = 0.22,
) -> list[dict]:
    today = date.today()
    opportunities: list[dict] = []

    for asset in assets:
        try:
            symbol         = (asset.get("symbol") or "").upper()
            current_price  = float(asset.get("current_price")  or 0)
            purchase_price = float(asset.get("purchase_price") or 0)
            amount         = float(asset.get("amount")         or 0)

            if not symbol or current_price <= 0 or purchase_price <= 0 or amount <= 0:
                continue

            unrealized_loss = (current_price - purchase_price) * amount
            if unrealized_loss >= -50:
                continue

            purchase_date_raw = asset.get("purchase_date") or str(today)
            try:
                pd = datetime.strptime(str(purchase_date_raw)[:10], "%Y-%m-%d").date()
            except ValueError:
                pd = today

            holding_days = (today - pd).days
            gain_type    = "short_term" if holding_days < 365 else "long_term"

            if gain_type == "long_term":
                effective_rate = 0.0 if tax_bracket <= 0.12 else (0.15 if tax_bracket <= 0.35 else 0.20)
            else:
                effective_rate = tax_bracket

            estimated_tax_saved   = abs(unrealized_loss) * effective_rate
            wash_sale_safe_date   = (today + timedelta(days=31)).strftime("%Y-%m-%d")
            suggested_replacement = _TLH_REPLACEMENTS.get(symbol, f"{symbol}2")

            opportunities.append({
                "symbol":                symbol,
                "unrealized_loss":       round(unrealized_loss, 2),
                "estimated_tax_saved":   round(estimated_tax_saved, 2),
                "holding_days":          holding_days,
                "gain_type":             gain_type,
                "wash_sale_safe_date":   wash_sale_safe_date,
                "suggested_replacement": suggested_replacement,
                "current_price":         round(current_price, 6),
                "purchase_price":        round(purchase_price, 6),
                "amount":                amount,
                "effective_rate_pct":    round(effective_rate * 100, 1),
            })
        except Exception as e:
            print(f"⚠️  TLH calc error for {asset.get('symbol')}: {e}")

    opportunities.sort(key=lambda x: x["estimated_tax_saved"], reverse=True)
    return opportunities


def calculate_cost_basis(transactions: list[dict], method: str = "FIFO") -> dict:
    method = method.upper().strip()
    if method not in ("FIFO", "LIFO", "HIFO", "SPEC"):
        method = "FIFO"

    buys  = sorted(
        [t for t in transactions if (t.get("type") or "").lower() == "buy"],
        key=lambda t: t.get("date") or "0000-00-00",
    )
    sells = sorted(
        [t for t in transactions if (t.get("type") or "").lower() == "sell"],
        key=lambda t: t.get("date") or "0000-00-00",
    )

    lots = [
        {
            "date":      b.get("date", ""),
            "price":     float(b.get("price",  0) or 0),
            "amount":    float(b.get("amount", 0) or 0),
            "lot_id":    b.get("lot_id", None),
            "remaining": float(b.get("amount", 0) or 0),
        }
        for b in buys
        if float(b.get("amount", 0) or 0) > 0 and float(b.get("price", 0) or 0) > 0
    ]

    realized_gains  = 0.0
    realized_losses = 0.0

    for sell in sells:
        sell_amount = float(sell.get("amount", 0) or 0)
        sell_price  = float(sell.get("price",  0) or 0)
        if sell_amount <= 0 or sell_price <= 0:
            continue

        remaining_to_sell = sell_amount

        if method == "FIFO":
            ordered = sorted(lots, key=lambda l: l["date"])
        elif method == "LIFO":
            ordered = sorted(lots, key=lambda l: l["date"], reverse=True)
        elif method == "HIFO":
            ordered = sorted(lots, key=lambda l: l["price"], reverse=True)
        else:
            target_id = sell.get("lot_id")
            if target_id:
                ordered = [l for l in lots if l.get("lot_id") == target_id] + \
                          [l for l in lots if l.get("lot_id") != target_id]
            else:
                ordered = sorted(lots, key=lambda l: l["date"])

        for lot in ordered:
            if lot["remaining"] <= 0 or remaining_to_sell <= 1e-9:
                break
            used = min(lot["remaining"], remaining_to_sell)
            pnl  = (sell_price - lot["price"]) * used
            if pnl >= 0:
                realized_gains  += pnl
            else:
                realized_losses += abs(pnl)
            lot["remaining"]  -= used
            remaining_to_sell -= used

    open_lots  = [l for l in lots if l["remaining"] > 1e-9]
    cost_basis = sum(l["remaining"] * l["price"] for l in open_lots)

    return {
        "cost_basis":      round(cost_basis, 2),
        "realized_gains":  round(realized_gains, 2),
        "realized_losses": round(realized_losses, 2),
        "net_gain_loss":   round(realized_gains - realized_losses, 2),
        "method_used":     method,
        "open_lots": [
            {
                "date":      l["date"],
                "price":     round(l["price"],     6),
                "remaining": round(l["remaining"], 8),
                "cost":      round(l["remaining"] * l["price"], 2),
            }
            for l in open_lots
        ],
    }


def generate_form_8949(
    transactions: list[dict],
    tax_year: int,
    method: str = "FIFO",
) -> dict:
    """
    Generate IRS Form 8949 data for a given tax year.
    Returns part_I (short-term) and part_II (long-term) rows plus a summary.
    """
    method   = method.upper().strip()
    if method not in ("FIFO", "LIFO", "HIFO"):
        method = "FIFO"

    year_str = str(tax_year)

    lots_by_sym: dict[str, list[dict]] = {}
    for tx in sorted(transactions, key=lambda t: t.get("date") or ""):
        if (tx.get("type") or "").lower() != "buy":
            continue
        sym    = (tx.get("symbol") or "").upper()
        amount = float(tx.get("amount") or 0)
        price  = float(tx.get("price")  or 0)
        if amount <= 0 or price <= 0:
            continue
        lots_by_sym.setdefault(sym, []).append({
            "date":      tx.get("date", ""),
            "price":     price,
            "remaining": amount,
        })

    part_I:  list[dict] = []
    part_II: list[dict] = []

    sells_in_year = [
        t for t in transactions
        if (t.get("type") or "").lower() == "sell"
        and (t.get("date") or "")[:4] == year_str
    ]
    sells_in_year.sort(key=lambda t: t.get("date") or "")

    for sell in sells_in_year:
        sym         = (sell.get("symbol") or "").upper()
        sell_amount = float(sell.get("amount") or 0)
        sell_price  = float(sell.get("price")  or 0)
        sell_date   = sell.get("date", "")

        if sell_amount <= 0 or sell_price <= 0:
            continue

        proceeds = round(sell_amount * sell_price, 2)
        lots     = lots_by_sym.get(sym, [])

        if method == "FIFO":
            ordered = sorted(lots, key=lambda l: l["date"])
        elif method == "LIFO":
            ordered = sorted(lots, key=lambda l: l["date"], reverse=True)
        else:
            ordered = sorted(lots, key=lambda l: l["price"], reverse=True)

        remaining_sell = sell_amount
        cost_total     = 0.0
        acquire_dates: list[str] = []

        for lot in ordered:
            if lot["remaining"] <= 1e-9 or remaining_sell <= 1e-9:
                break
            used           = min(lot["remaining"], remaining_sell)
            cost_total    += used * lot["price"]
            remaining_sell -= used
            lot["remaining"] -= used
            acquire_dates.append(lot["date"])

        cost_basis  = round(cost_total, 2)
        gain_loss   = round(proceeds - cost_basis, 2)

        is_long = False
        acq_display = "VARIOUS" if len(acquire_dates) > 1 else (acquire_dates[0] if acquire_dates else "VARIOUS")
        if acquire_dates:
            try:
                first_acq = datetime.strptime(acquire_dates[0][:10], "%Y-%m-%d")
                sold_dt   = datetime.strptime(sell_date[:10], "%Y-%m-%d")
                is_long   = (sold_dt - first_acq).days >= 365
            except Exception:
                pass

        row = {
            "description":   f"{sell_amount:g} units of {sym}",
            "date_acquired": acq_display,
            "date_sold":     sell_date,
            "proceeds":      proceeds,
            "cost_basis":    cost_basis,
            "gain_loss":     gain_loss,
        }

        (part_II if is_long else part_I).append(row)

    all_rows         = part_I + part_II
    total_proceeds   = round(sum(r["proceeds"]  for r in all_rows), 2)
    total_cost_basis = round(sum(r["cost_basis"] for r in all_rows), 2)
    net_short        = round(sum(r["gain_loss"]  for r in part_I),  2)
    net_long         = round(sum(r["gain_loss"]  for r in part_II), 2)

    return {
        "tax_year": tax_year,
        "method":   method,
        "part_I":   part_I,
        "part_II":  part_II,
        "summary": {
            "total_proceeds":      total_proceeds,
            "total_cost_basis":    total_cost_basis,
            "net_short_term":      net_short,
            "net_long_term":       net_long,
            "total_net_gain_loss": round(net_short + net_long, 2),
        },
    }
