"""
services.py — compatibility shim
=================================
This file re-exports all public symbols from the refactored module hierarchy so
that existing imports in main.py and any external tooling continue to work
without modification.

Actual implementations live in:
  infrastructure/  — cache (TTLCache) and asset resolution
  gateways/        — Binance, Yahoo Finance, CoinCap, Finnhub, Gemini
  domain/          — scoring, tax, alerts, digest, CSV parsers, dividends
"""

# ── Infrastructure ─────────────────────────────────────────────────────────────
from infrastructure.cache import price_cache, TTLCache
from infrastructure.asset_resolver import (
    get_asset_data,
    get_historical_data,
    search_symbols,
)

# ── Gateways ───────────────────────────────────────────────────────────────────
from gateways.gemini import (
    get_ai_analysis,
    get_portfolio_ai_analysis,
    get_ai_status,
)
from gateways.binance import (
    _load_binance_pairs,
    _is_binance_crypto,
    _is_likely_stock,
    _binance_price,
    _binance_klines,
    _binance_history,
    _binance_mini_ticker_batch,
    _COIN_META,
    _KNOWN_STOCKS,
    _coin_icon,
    _pct_from_series,
)

# ── Domain ─────────────────────────────────────────────────────────────────────
from domain.scoring import calculate_portfolio_score, calculate_rsi
from domain.tax import calculate_tax_loss_harvesting, calculate_cost_basis, generate_form_8949
from domain.alerts import check_advanced_alert, check_and_trigger_alerts
from domain.digest import generate_weekly_digest
from domain.csv_parsers import parse_broker_csv
from domain.dividends import get_dividend_data

__all__ = [
    # infrastructure
    "price_cache",
    "TTLCache",
    "get_asset_data",
    "get_historical_data",
    "search_symbols",
    # gateways — AI
    "get_ai_analysis",
    "get_portfolio_ai_analysis",
    "get_ai_status",
    # gateways — Binance internals (used by tests / other modules)
    "_load_binance_pairs",
    "_is_binance_crypto",
    "_is_likely_stock",
    "_binance_price",
    "_binance_klines",
    "_binance_history",
    "_binance_mini_ticker_batch",
    "_COIN_META",
    "_KNOWN_STOCKS",
    "_coin_icon",
    "_pct_from_series",
    # domain
    "calculate_portfolio_score",
    "calculate_rsi",
    "calculate_tax_loss_harvesting",
    "calculate_cost_basis",
    "generate_form_8949",
    "check_advanced_alert",
    "check_and_trigger_alerts",
    "generate_weekly_digest",
    "parse_broker_csv",
    "get_dividend_data",
]
