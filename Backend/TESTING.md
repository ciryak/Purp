# Backend tests

## Requisitos

Instale as dependências de teste no ambiente:

```bash
pip install pytest pytest-asyncio httpx
```

> Se você já usa um `requirements` de desenvolvimento, inclua esses pacotes nele.

## Executar todos os testes do backend

No diretório do repositório:

```bash
pytest Backend/test_main.py -q
```

## O que os testes cobrem

- Autenticação (registro/login, duplicidade, endpoint protegido)
- Assets (crypto/stock, média de preço, limite do plano free, vendas)
- Alerts (limite free e simulação de trigger)
- Stripe webhooks (upgrade/downgrade/idempotência)
- Tax (export Form 8949 CSV, loss harvesting vazio, HIFO)

## Detalhes técnicos da suíte

- Banco em memória SQLite por teste (isolamento).
- `httpx.AsyncClient` para chamadas HTTP assíncronas.
- Mocks para integrações externas (asset data e envio de email).
