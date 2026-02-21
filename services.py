import os
import yfinance as yf
from google import genai
import requests
import pandas as pd
from datetime import datetime
from dotenv import load dotenv

_cg_symbol_cache: dict[str, dict | None] = {}

GEMINI_API_KEY = os.getenv('GEMINI_API_KEY', '')
client = None

try:
    if GEMINI_API_KEY and "SUA_CHAVE" not in GEMINI_API_KEY:
        client = genai.Client(api_key=GEMINI_API_KEY)
except Exception as e:
    print(f"⚠️ Erro ao inicializar Gemini: {e}")
    client = None

def _cg_headers():
    return {"User-Agent": "Purp/1.0"}

def _cg_find_coin_id_by_symbol(symbol: str) -> dict | None:
    """Resolve símbolo para coin id do CoinGecko com tratamento de erro."""
    s = (symbol or "").strip().lower()
    if not s:
        return None

    if s in ("btc", "bitcoin"):
        return {"id": "bitcoin", "symbol": "btc", "name": "Bitcoin", "thumb": ""}
    if s in ("eth", "ethereum"):
        return {"id": "ethereum", "symbol": "eth", "name": "Ethereum", "thumb": ""}

    if s in _cg_symbol_cache:
        return _cg_symbol_cache[s]

    try:
        cg = requests.get(
            f"https://api.coingecko.com/api/v3/search?query={s}",
            headers=_cg_headers(),
            timeout=5
        )
        cg.raise_for_status()
        data = cg.json()
        coins = data.get("coins", []) or []

        if not coins:
            _cg_symbol_cache[s] = None
            return None

        candidates = [c for c in coins if (c.get("symbol") or "").lower() == s]
        if not candidates:
            _cg_symbol_cache[s] = None
            return None

        def rank_key(c):
            r = c.get("market_cap_rank")
            return (999999 if r is None else int(r))

        best = sorted(candidates, key=rank_key)[0]
        found = {
            "id": best.get("id"),
            "symbol": (best.get("symbol") or "").lower(),
            "name": best.get("name") or "",
            "thumb": best.get("thumb") or "",
        }
        if found["id"]:
            _cg_symbol_cache[s] = found
            return found
        else:
            _cg_symbol_cache[s] = None
            return None
    except requests.exceptions.RequestException as e:
        print(f"❌ Erro ao buscar coin {s} no CoinGecko: {e}")
        _cg_symbol_cache[s] = None
        return None
    except ValueError:
        print(f"❌ Erro ao parsear JSON de {s}")
        _cg_symbol_cache[s] = None
        return None

def _cg_simple_price(coin_id: str) -> tuple[float | None, float | None]:
    """Retorna (usd_price, usd_24h_change_percent) com validação."""
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={
                "ids": coin_id,
                "vs_currencies": "usd",
                "include_24hr_change": "true",
            },
            headers=_cg_headers(),
            timeout=5
        )
        r.raise_for_status()
        data = r.json()
        
        if coin_id not in data:
            return (None, None)
            
        p = data[coin_id].get("usd")
        ch = data[coin_id].get("usd_24h_change")
        return (float(p) if p is not None else None, float(ch) if ch is not None else None)
    except Exception as e:
        print(f"❌ Erro ao buscar preço de {coin_id}: {e}")
        return (None, None)

def _cg_market_chart(coin_id: str, days: int):
    """Retorna (dates, prices) com tratamento robusto."""
    try:
        r = requests.get(
            f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart",
            params={"vs_currency": "usd", "days": str(days)},
            headers=_cg_headers(),
            timeout=8
        )
        r.raise_for_status()
        data = r.json()
        prices = data.get("prices", []) or []
        
        if not prices:
            return ([], [])

        dates = []
        vals = []
        is_intraday = days <= 5
        date_fmt = "%H:%M" if is_intraday else "%d/%m"
        
        for ms, price in prices:
            try:
                dt = datetime.fromtimestamp(ms / 1000.0)
                dates.append(dt.strftime(date_fmt))
                vals.append(float(price))
            except (ValueError, OSError):
                continue

        return (dates, vals)
    except Exception as e:
        print(f"❌ Erro ao buscar chart de {coin_id}: {e}")
        return ([], [])

def get_asset_data(symbol: str):
    """Busca dados de ativo com fallback e validação melhorada."""
    if not symbol:
        return None
        
    symbol = (symbol or "").upper().strip()
    base_sym = symbol.replace("-USD", "").strip()

    # 1) Tenta CoinGecko primeiro
    if base_sym and not base_sym.startswith("^"):
        try:
            cg_coin = _cg_find_coin_id_by_symbol(base_sym)
            if cg_coin and cg_coin.get("id"):
                usd_price, ch24 = _cg_simple_price(cg_coin["id"])
                _, spark = _cg_market_chart(cg_coin["id"], days=1)
                
                if usd_price is None or usd_price <= 0:
                    print(f"⚠️ Preço inválido para {base_sym}")
                    return None

                icon = cg_coin.get("thumb") or ""
                
                return {
                    "symbol": base_sym,
                    "real_symbol": base_sym,
                    "current_price": float(usd_price),
                    "history": (spark[-30:] if spark else [float(usd_price)]),
                    "type": "crypto",
                    "percent_change": float(ch24) if ch24 is not None else 0.0,
                    "icon": icon
                }
        except Exception as e:
            print(f"⚠️ Erro ao processar crypto {base_sym}: {e}")

    # 2) Fallback: Yahoo Finance
    try:
        ticker = yf.Ticker(symbol)
        history = ticker.history(period="1d", interval="15m")
        
        if history.empty:
            symbol = f"{symbol}-USD"
            ticker = yf.Ticker(symbol)
            history = ticker.history(period="1d", interval="15m")
            
        if history.empty:
            print(f"⚠️ Sem dados para {symbol}")
            return None

        info = ticker.info or {}
        current = float(history['Close'].iloc[-1])
        start = float(history['Open'].iloc[0])
        
        if start <= 0:
            return None
            
        change = ((current - start) / start) * 100
        
        is_crypto = 'CRYPTOCURRENCY' in info.get('quoteType', '') or '-USD' in symbol
        asset_type = 'crypto' if is_crypto else 'stock'

        icon = info.get('logo_url', '') or info.get('image', '') or ''

        return {
            "symbol": symbol.replace("-USD", ""),
            "real_symbol": symbol,
            "current_price": current,
            "history": history['Close'].tolist(),
            "type": asset_type,
            "percent_change": change,
            "icon": icon
        }
    except Exception as e:
        print(f"❌ Erro Yahoo Finance para {symbol}: {e}")
        return None

def get_historical_data(symbol: str, period: str):
    """Histórico com melhor tratamento de erro."""
    try:
        if not symbol or symbol == "PORTFOLIO":
            return {"dates": [], "prices": []}

        sym = (symbol or "").upper().strip()
        base_sym = sym.replace("-USD", "").strip()
        
        if base_sym and not base_sym.startswith("^"):
            try:
                cg_coin = _cg_find_coin_id_by_symbol(base_sym)
                if cg_coin and cg_coin.get("id"):
                    days_map = {
                        "1d": 1, "5d": 5, "1mo": 30, "3mo": 90,
                        "6mo": 180, "1y": 365, "2y": 730, "5y": 1825,
                    }
                    days = days_map.get(period, 30)
                    dates, prices = _cg_market_chart(cg_coin["id"], days=days)
                    return {"dates": dates, "prices": prices}
            except Exception as e:
                print(f"⚠️ Erro ao buscar histórico crypto {base_sym}: {e}")
        
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period=period)
        
        if hist.empty:
            ticker = yf.Ticker(f"{symbol}-USD")
            hist = ticker.history(period=period)

        if hist.empty:
            return {"dates": [], "prices": []}

        is_intraday = period in ['1d', '5d']
        date_fmt = '%H:%M' if is_intraday else '%d/%m'
        
        dates = [d.strftime(date_fmt) for d in hist.index]
        prices = hist['Close'].tolist()

        return {"dates": dates, "prices": prices}
    except Exception as e:
        print(f"❌ Erro ao buscar histórico: {e}")
        return {"dates": [], "prices": []}

def search_symbols(query: str):
    """Busca melhorada com deduplicação."""
    results = []
    seen_symbols = set()

    # CoinGecko
    try:
        cg = requests.get(
            f"https://api.coingecko.com/api/v3/search?query={query}",
            timeout=3
        ).json()
        for coin in cg.get('coins', [])[:4]:
            sym = coin.get('symbol', '').upper()
            if sym and sym not in seen_symbols:
                results.append({
                    "symbol": sym,
                    "name": coin.get('name', ''),
                    "type": "CRYPTO",
                    "icon": coin.get('thumb', '')
                })
                seen_symbols.add(sym)
    except Exception as e:
        print(f"⚠️ Erro CoinGecko search: {e}")

    # Yahoo
    try:
        yf_res = requests.get(
            f"https://query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=5",
            headers={'User-Agent': 'Mozilla/5.0'},
            timeout=3
        ).json()
        
        for q in yf_res.get('quotes', []):
            sym = q.get('symbol', '').upper()
            if sym and sym not in seen_symbols and 'coin' not in q.get('shortname', '').lower():
                results.append({
                    "symbol": sym,
                    "name": q.get('shortname', sym),
                    "type": "STOCK",
                    "icon": ""
                })
                seen_symbols.add(sym)
    except Exception as e:
        print(f"⚠️ Erro Yahoo search: {e}")
    
    return results[:10]

def get_ai_analysis(symbol: str, change: float):
    """IA com tratamento de erro robusto."""
    if not client:
        return "❌ Erro: API do Gemini não configurada. Defina GEMINI_API_KEY."
    
    try:
        direction = "subiu" if change > 0 else "caiu" if change < 0 else "estável"

        prompt = (
            f"Analise em 1-2 frases curtas em português o ativo {symbol} "
            f"que {direction} {abs(change):.2f}% nas últimas 24h. "
            "Cite possíveis razões de mercado, sem inventar notícias específicas."
        )

        res = client.models.generate_content(
            model="gemini-1.5-flash",
            contents=prompt,
        )
        return _gemini_text(res) or "Análise indisponível no momento"
    except Exception as e:
        print(f"❌ Erro IA {symbol}: {e}")
        return f"Análise IA temporariamente indisponível ({str(e)[:30]})"

def get_portfolio_ai_analysis(portfolio_change: float, assets: list[dict]):
    """IA de portfólio com fallback."""
    if not client:
        return "❌ Erro: API do Gemini não configurada. Defina GEMINI_API_KEY."

    try:
        direction = "subiu" if portfolio_change > 0 else "caiu" if portfolio_change < 0 else "estável"

        assets_block = "\n".join([
            f"- {a.get('symbol')} ({a.get('type')}) {a.get('allocation_pct',0):.1f}% ({a.get('change_pct',0):+.2f}%)"
            for a in assets[:8]
        ])

        prompt = (
            f"Gestor de portfólio: sua carteira {direction} {abs(portfolio_change):.2f}% em 24h.\n"
            f"Posições:\n{assets_block}\n\n"
            "Em 2 frases: comente o comportamento e dê 1-2 dicas de alocação genéricas (sem recomendar ativos específicos)."
        )

        res = client.models.generate_content(
            model="gemini-1.5-flash",
            contents=prompt,
        )
        return _gemini_text(res) or "Análise de portfólio indisponível"
    except Exception as e:
        print(f"❌ Erro IA Portfolio: {e}")
        return f"Análise de portfólio temporariamente indisponível ({str(e)[:30]})"

def _gemini_text(res) -> str:
    """Extrai texto com segurança."""
    try:
        if hasattr(res, "text"):
            return res.text or ""
        if hasattr(res, "candidates") and res.candidates:
            c = res.candidates[0]
            if hasattr(c, "content") and c.content:
                for p in c.content.parts:
                    if hasattr(p, "text") and p.text:
                        return p.text
    except:
        pass
    return ""