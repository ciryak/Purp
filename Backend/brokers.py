"""
Purp — Broker API integrations.
Fetch portfolio and transactions from Coinbase, Binance and Kraken via API.
Robinhood and Fidelity: CSV import only (no public API).
"""
import os
import time
import hmac
import hashlib
import base64
import urllib.parse
import requests
from typing import Any

# ── Coinbase Advanced Trade API ─────────────────────────────────────────────
# https://docs.cloud.coinbase.com/advanced-trade-api/docs/rest-api-auth

COINBASE_BASE = "https://api.coinbase.com"


def _coinbase_sign(secret: str, timestamp: str, method: str, path: str, body: str = "") -> str:
    message = f"{timestamp}{method}{path}{body}"
    sig = hmac.new(
        base64.b64decode(secret),
        message.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.b64encode(sig).decode("utf-8")


def fetch_coinbase_holdings(api_key: str, api_secret: str) -> dict[str, Any]:
    """Fetch accounts (holdings) from Coinbase Advanced Trade API."""
    path = "/api/v3/brokerage/accounts"
    timestamp = str(int(time.time()))
    signature = _coinbase_sign(api_secret, timestamp, "GET", path, "")

    headers = {
        "CB-2F-TIMESTAMP": timestamp,
        "CB-2F-SIGNATURE": signature,
        "CB-2F-API-KEY": api_key,
        "Accept": "application/json",
    }
    try:
        r = requests.get(
            f"{COINBASE_BASE}{path}",
            headers=headers,
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        accounts = data.get("accounts") or []
        holdings = []
        for acc in accounts:
            currency = (acc.get("currency") or {}).get("symbol") or ""
            balance = float(acc.get("balance") or 0)
            if not currency or balance <= 0:
                continue
            holdings.append({
                "symbol": currency,
                "amount": balance,
                "type": "crypto",
                "source": "coinbase",
            })
        return {"ok": True, "holdings": holdings, "transactions": []}
    except requests.exceptions.HTTPError as e:
        body = e.response.text if e.response else ""
        return {"ok": False, "error": f"Coinbase API: {e.response.status_code if e.response else 'error'} — {body[:200]}", "holdings": [], "transactions": []}
    except Exception as e:
        return {"ok": False, "error": str(e), "holdings": [], "transactions": []}


# ── Kraken REST API ─────────────────────────────────────────────────────────
# https://docs.kraken.com/rest/

KRAKEN_BASE = "https://api.kraken.com"


def _kraken_sign(urlpath: str, data: dict, secret_b64: str) -> str:
    postdata = "&".join(f"{k}={v}" for k, v in sorted(data.items()))
    encoded = (str(data["nonce"]) + postdata).encode("utf-8")
    message = urlpath.encode("utf-8") + hashlib.sha256(encoded).digest()
    mac = hmac.new(base64.b64decode(secret_b64), message, hashlib.sha512)
    return base64.b64encode(mac.digest()).decode("utf-8")


def _kraken_asset_to_symbol(asset: str) -> str:
    """Convert Kraken asset (e.g. XXBT, XETH) to common symbol (BTC, ETH)."""
    s = (asset or "").strip()
    mapping = {
        "XXBT": "BTC", "XBT": "BTC",
        "XETH": "ETH",
        "XLTC": "LTC", "XXRP": "XRP", "XXLM": "XLM",
        "XXDG": "DOGE", "ZUSD": "USD", "ZEUR": "EUR",
    }
    if s in mapping:
        return mapping[s]
    if s.startswith("X") and len(s) == 4:
        return s[1:] if s[1] != "X" else s[2:]
    if s.startswith("Z") and len(s) == 4:
        return s[1:]
    return s


def fetch_kraken_holdings(api_key: str, api_secret: str) -> dict[str, Any]:
    """Fetch balance from Kraken private API."""
    urlpath = "/0/private/Balance"
    data = {"nonce": str(int(time.time() * 1000))}
    signature = _kraken_sign(urlpath, data, api_secret)
    headers = {
        "API-Key": api_key,
        "API-Sign": signature,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    try:
        r = requests.post(
            f"{KRAKEN_BASE}{urlpath}",
            headers=headers,
            data=data,
            timeout=15,
        )
        r.raise_for_status()
        j = r.json()
        if j.get("error"):
            return {"ok": False, "error": "; ".join(j["error"]), "holdings": [], "transactions": []}
        result = j.get("result") or {}
        holdings = []
        for asset, balance_str in result.items():
            balance = float(balance_str or 0)
            if balance <= 0:
                continue
            symbol = _kraken_asset_to_symbol(asset)
            if symbol in ("USD", "EUR", "USDT"):
                continue  # skip fiat for portfolio assets
            holdings.append({
                "symbol": symbol,
                "amount": balance,
                "type": "crypto",
                "source": "kraken",
            })
        return {"ok": True, "holdings": holdings, "transactions": []}
    except requests.exceptions.HTTPError as e:
        body = e.response.text if e.response else ""
        return {"ok": False, "error": f"Kraken API: {e.response.status_code if e.response else 'error'} — {body[:200]}", "holdings": [], "transactions": []}
    except Exception as e:
        return {"ok": False, "error": str(e), "holdings": [], "transactions": []}


# ── Binance Spot API ────────────────────────────────────────────────────────
# https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints

BINANCE_BASE = "https://api.binance.com"


def fetch_binance_holdings(api_key: str, api_secret: str) -> dict[str, Any]:
    """Fetch account balances from Binance Spot API (GET /api/v3/account)."""
    timestamp = int(time.time() * 1000)
    params = {"timestamp": timestamp, "omitZeroBalances": "true"}
    query = urllib.parse.urlencode(params)
    signature = hmac.new(
        api_secret.encode("utf-8"),
        query.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    url = f"{BINANCE_BASE}/api/v3/account?{query}&signature={signature}"
    headers = {"X-MBX-APIKEY": api_key}
    try:
        r = requests.get(url, headers=headers, timeout=15)
        r.raise_for_status()
        data = r.json()
        balances = data.get("balances") or []
        holdings = []
        fiat = {"USD", "EUR", "BUSD", "USDT", "USDC", "TUSD", "FDUSD", "DAI"}
        for b in balances:
            asset = (b.get("asset") or "").strip()
            free = float(b.get("free") or 0)
            locked = float(b.get("locked") or 0)
            total = free + locked
            if not asset or total <= 0:
                continue
            if asset in fiat:
                continue
            holdings.append({
                "symbol": asset,
                "amount": total,
                "type": "crypto",
                "source": "binance",
            })
        return {"ok": True, "holdings": holdings, "transactions": []}
    except requests.exceptions.HTTPError as e:
        body = e.response.text if e.response else ""
        return {"ok": False, "error": f"Binance API: {e.response.status_code if e.response else 'error'} — {body[:200]}", "holdings": [], "transactions": []}
    except Exception as e:
        return {"ok": False, "error": str(e), "holdings": [], "transactions": []}


# ── Dispatcher ──────────────────────────────────────────────────────────────

BROKERS_WITH_API = ("coinbase", "binance", "kraken")
BROKERS_CSV_ONLY = ("robinhood", "fidelity")


def fetch_broker_data(broker: str, api_key: str = "", api_secret: str = "") -> dict[str, Any]:
    """
    Fetch holdings (and optionally transactions) from broker.
    - coinbase, binance, kraken: require api_key and api_secret; return holdings.
    - robinhood, fidelity: return use_csv=True (no API).
    """
    broker = (broker or "").strip().lower()
    if broker in BROKERS_CSV_ONLY:
        return {"ok": True, "use_csv": True, "holdings": [], "transactions": [], "message": "Use CSV import for this broker."}
    if broker == "coinbase":
        if not api_key or not api_secret:
            return {"ok": False, "error": "Coinbase requires API key and secret.", "holdings": [], "transactions": []}
        return fetch_coinbase_holdings(api_key, api_secret)
    if broker == "binance":
        if not api_key or not api_secret:
            return {"ok": False, "error": "Binance requires API key and secret.", "holdings": [], "transactions": []}
        return fetch_binance_holdings(api_key, api_secret)
    if broker == "kraken":
        if not api_key or not api_secret:
            return {"ok": False, "error": "Kraken requires API key and secret.", "holdings": [], "transactions": []}
        return fetch_kraken_holdings(api_key, api_secret)
    return {"ok": False, "error": f"Unknown broker: {broker}", "holdings": [], "transactions": []}
