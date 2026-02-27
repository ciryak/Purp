FROM python:3.11-slim

# Evita prompts interativos durante apt
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Dependências do sistema (psycopg2-binary precisa de libpq)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Instala dependências Python primeiro (cache layer)
COPY requirements-Docker.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements-Docker.txt

# Copia o código
COPY main.py .
COPY models.py .
COPY services.py .
COPY brokers.py .
COPY static/ static/

# Copia as novas camadas de arquitetura
COPY gateways/ gateways/
COPY domain/ domain/
COPY infrastructure/ infrastructure/

# Diretório persistente para SQLite (montado como volume no Railway/Docker)
RUN mkdir -p /data
VOLUME ["/data"]

# Fallback: usa SQLite em /data se DATABASE_URL não estiver definida
# (Railway injeta DATABASE_URL apontando para Postgres automaticamente)
ENV DATABASE_URL=sqlite:////data/database.db

# Porta exposta
EXPOSE 8080

# Health check interno do Docker
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"

# Comando de start — usa $PORT do Railway ou 8080 como fallback
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
