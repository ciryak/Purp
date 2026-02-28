"""
domain/csv_parsers.py
Broker-specific CSV transaction parsers. Pure logic — no I/O beyond reading the
string content passed in.
Supported brokers: coinbase, robinhood, fidelity, kraken, schwab.
"""
import csv
import io
from datetime import datetime


# ── Helpers ───────────────────────────────────────────────────────────────────

def _clean_price(raw: str) -> float:
    if not raw:
        return 0.0
    cleaned = raw.strip().replace("$", "").replace(",", "").replace(" ", "")
    try:
        return abs(float(cleaned))
    except ValueError:
        return 0.0


def _normalize_date(raw: str, fmt_hints: list[str] | None = None) -> str:
    if not raw:
        return str(datetime.today().date())
    raw     = raw.strip()
    formats = fmt_hints or [
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S %Z",
        "%Y-%m-%d %H:%M:%S",
        "%m/%d/%Y",
        "%m-%d-%Y",
        "%d/%m/%Y",
        "%Y-%m-%d",
        "%b %d, %Y",
        "%B %d, %Y",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    try:
        from dateutil import parser as du_parser
        return du_parser.parse(raw).strftime("%Y-%m-%d")
    except Exception:
        pass
    return str(datetime.today().date())


def _sniff_delimiter(content: str) -> str:
    first_line = content.split("\n")[0] if "\n" in content else content
    return ";" if first_line.count(";") > first_line.count(",") else ","


def _csv_rows(content: str) -> tuple[list[str], list[dict]]:
    delimiter = _sniff_delimiter(content)
    lines     = content.splitlines()
    start_idx = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and len(stripped.split(delimiter)) >= 3:
            start_idx = i
            break
    clean_content = "\n".join(lines[start_idx:])
    reader  = csv.DictReader(io.StringIO(clean_content), delimiter=delimiter)
    rows    = list(reader)
    headers = [h.strip().lower() for h in (reader.fieldnames or [])]
    return headers, rows


# ── Broker parsers ────────────────────────────────────────────────────────────

def _parse_coinbase(rows: list[dict]) -> list[dict]:
    TYPE_MAP = {
        "buy": "buy", "sell": "sell",
        "advanced trade buy": "buy", "advanced trade sell": "sell",
    }
    results = []
    for row in rows:
        raw_type = (row.get("Transaction Type") or row.get("transaction type") or "").strip().lower()
        tx_type  = TYPE_MAP.get(raw_type)
        if not tx_type:
            continue
        symbol     = (row.get("Asset") or row.get("asset") or "").strip().upper()
        amount_raw = row.get("Quantity Transacted") or row.get("quantity transacted") or "0"
        price_raw  = row.get("Spot Price at Transaction") or row.get("spot price at transaction") or "0"
        date_raw   = row.get("Timestamp") or row.get("timestamp") or ""
        amount = _clean_price(amount_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_robinhood(rows: list[dict]) -> list[dict]:
    TYPE_MAP = {"buy": "buy", "sell": "sell", "bto": "buy", "sto": "sell"}
    results  = []
    for row in rows:
        trans_code = (row.get("Trans Code") or row.get("trans code") or "").strip().lower()
        tx_type    = TYPE_MAP.get(trans_code)
        if not tx_type:
            continue
        symbol    = (row.get("Instrument") or row.get("instrument") or "").strip().upper()
        qty_raw   = row.get("Quantity")      or row.get("quantity")      or "0"
        price_raw = row.get("Price")         or row.get("price")         or "0"
        date_raw  = row.get("Activity Date") or row.get("activity date") or ""
        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_fidelity(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        action = (row.get("Action") or row.get("action") or "").strip().upper()
        if "BOUGHT" in action:
            tx_type = "buy"
        elif "SOLD" in action:
            tx_type = "sell"
        else:
            continue
        symbol    = (row.get("Symbol")   or row.get("symbol")   or "").strip().upper()
        qty_raw   = row.get("Quantity")  or row.get("quantity")  or "0"
        price_raw = row.get("Price ($)") or row.get("Price")     or row.get("price") or "0"
        date_raw  = row.get("Run Date")  or row.get("run date")  or ""
        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


def _parse_kraken(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        if (row.get("type") or "").strip().lower() != "trade":
            continue
        asset_raw = (row.get("asset") or "").strip().upper()
        symbol    = asset_raw
        if len(symbol) == 4 and symbol[0] in ("X", "Z"):
            symbol = symbol[1:]
        if symbol in ("XXBT", "XBT"):
            symbol = "BTC"
        if symbol in ("XETH",):
            symbol = "ETH"
        if symbol.endswith(".S"):
            symbol = symbol[:-2]
        try:
            raw_amount = float((row.get("amount") or "0").strip())
        except ValueError:
            continue
        if raw_amount == 0:
            continue
        tx_type = "buy" if raw_amount > 0 else "sell"
        amount  = abs(raw_amount)
        date    = _normalize_date(row.get("time") or "")
        if not symbol:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": 0.0, "date": date})
    return results


def _parse_schwab(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        action = (row.get("Action") or row.get("action") or "").strip().upper()
        if "BUY" in action:
            tx_type = "buy"
        elif "SELL" in action:
            tx_type = "sell"
        else:
            continue
        symbol    = (row.get("Symbol")   or row.get("symbol")   or "").strip().upper()
        qty_raw   = row.get("Quantity")  or row.get("quantity")  or "0"
        price_raw = row.get("Price")     or row.get("price")     or "0"
        date_raw  = row.get("Date")      or row.get("date")      or ""
        amount = _clean_price(qty_raw)
        price  = _clean_price(price_raw)
        date   = _normalize_date(date_raw)
        if not symbol or amount <= 0:
            continue
        results.append({"symbol": symbol, "type": tx_type, "amount": amount, "price": price, "date": date})
    return results


# ── Public API ────────────────────────────────────────────────────────────────

SUPPORTED_BROKERS = ("coinbase", "robinhood", "fidelity", "kraken", "schwab")


def parse_broker_csv(content: str, broker: str) -> list[dict]:
    broker = broker.strip().lower()
    if broker not in SUPPORTED_BROKERS:
        raise ValueError(
            f"Unsupported broker '{broker}'. Supported: {', '.join(SUPPORTED_BROKERS)}."
        )
    if not content or not content.strip():
        raise ValueError("CSV file is empty.")
    try:
        _headers, rows = _csv_rows(content)
    except Exception as e:
        raise ValueError(f"Could not parse CSV file: {e}")
    if not rows:
        raise ValueError("CSV file contains no data rows.")

    parsers = {
        "coinbase":  _parse_coinbase,
        "robinhood": _parse_robinhood,
        "fidelity":  _parse_fidelity,
        "kraken":    _parse_kraken,
        "schwab":    _parse_schwab,
    }
    try:
        transactions = parsers[broker](rows)
    except Exception as e:
        raise ValueError(f"Error parsing {broker} CSV: {e}")

    validated = []
    for i, tx in enumerate(transactions):
        missing = [f for f in ("symbol", "type", "amount", "price", "date") if f not in tx]
        if missing:
            print(f"⚠️  Row {i} missing fields {missing} — skipped")
            continue
        if tx["type"] not in ("buy", "sell"):
            continue
        validated.append(tx)
    return validated
