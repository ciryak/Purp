"""
gateways/gemini.py
Google Gemini AI client setup and all AI analysis functions.
"""
import os
from google import genai

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "") or os.getenv("GOOGLE_API_KEY", "")
_gemini_client = None
_gemini_status = "missing_api_key"

try:
    if GEMINI_API_KEY and "YOUR_KEY" not in GEMINI_API_KEY and len(GEMINI_API_KEY) > 10:
        _gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        _gemini_status = "ok"
        print("[OK] Gemini client initialized")
    else:
        print("[WARN] GEMINI_API_KEY/GOOGLE_API_KEY not set - AI features disabled")
except Exception as e:
    _gemini_status = f"init_error: {e}"
    print(f"[WARN] Gemini init error: {e}")
    _gemini_client = None


def get_ai_status() -> dict:
    return {
        "enabled":        _gemini_client is not None,
        "provider":       "gemini",
        "status":         _gemini_status,
        "api_key_source": "GEMINI_API_KEY/GOOGLE_API_KEY",
    }


def _extract_gemini_text(res) -> str:
    try:
        if hasattr(res, "text") and res.text:
            return res.text
        if hasattr(res, "candidates") and res.candidates:
            for cand in res.candidates:
                if hasattr(cand, "content") and cand.content:
                    for part in cand.content.parts:
                        if hasattr(part, "text") and part.text:
                            return part.text
    except Exception:
        pass
    return ""


def get_ai_analysis(symbol: str, change: float) -> str:
    if not _gemini_client:
        return "⚠️ Gemini API not configured. Add GEMINI_API_KEY to your environment."

    direction = "subiu" if change > 0 else "caiu" if change < 0 else "ficou estável"
    pct = abs(change)
    prompt = (
        "Você é um analista de investimentos conciso. O ativo {symbol} {direction} {pct:.2f}% nas últimas 24h. "
        "Forneça uma análise curta (2-3 frases) que inclua: (1) possível contexto de mercado ou setor que explique o movimento, "
        "(2) um comentário sobre o que observar a seguir (ex.: suporte, resistência, notícias). "
        "Não invente notícias específicas; seja genérico mas útil. Não dê recomendações de compra ou venda. "
        "Responda em português do Brasil, de forma direta e profissional."
    ).format(symbol=symbol, direction=direction, pct=pct)

    try:
        res = _gemini_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        return _extract_gemini_text(res) or "Análise temporariamente indisponível."
    except Exception as e:
        print(f"[ERROR] Gemini error for {symbol}: {e}")
        return "Análise por IA temporariamente indisponível."


def get_portfolio_ai_analysis(portfolio_change: float, assets: list[dict]) -> str:
    if not _gemini_client:
        return "⚠️ Gemini API not configured. Add GEMINI_API_KEY to your environment."

    direction = "subiu" if portfolio_change > 0 else "caiu" if portfolio_change < 0 else "ficou estável"
    pct = abs(portfolio_change)
    lines = "\n".join(
        f"- {a.get('symbol')} ({a.get('type', 'asset')}): alocação {a.get('allocation_pct', 0):.1f}%, variação 24h {a.get('change_pct', 0):+.2f}%"
        for a in (assets or [])[:10]
    )
    prompt = (
        "Você é um gestor de portfólio. O portfólio do usuário {direction} {pct:.2f}% hoje. "
        "Carteira (até 10 ativos):\n{lines}\n\n"
        "Forneça uma análise em 2-4 frases: (1) comente o comportamento geral do portfólio e qual ativo mais contribuiu; "
        "(2) dê 1-2 dicas genéricas de alocação ou diversificação (sem recomendar ativos específicos). "
        "Seja objetivo e acionável. Responda em português do Brasil."
    ).format(direction=direction, pct=pct, lines=lines or "Nenhum ativo.")

    try:
        res = _gemini_client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )
        return _extract_gemini_text(res) or "Análise de portfólio temporariamente indisponível."
    except Exception as e:
        print(f"[ERROR] Gemini portfolio error: {e}")
        return "Análise de portfólio temporariamente indisponível."
