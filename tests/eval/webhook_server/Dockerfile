FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN pip install uv && uv sync --frozen --no-dev

COPY main.py ./
COPY seeds/ ./seeds/

EXPOSE 8883

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8883"]
