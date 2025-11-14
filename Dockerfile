# syntax=docker/dockerfile:1
FROM python:3.12-slim

# Install system dependencies and create non-root user
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 appuser

# Install uv
RUN pip install --no-cache-dir uv

# Set working directory
WORKDIR /app

# Enable bytecode compilation for faster startup
ENV UV_COMPILE_BYTECODE=1

# Use copy mode for better compatibility with Docker layers
ENV UV_LINK_MODE=copy

# Copy dependency files for installation
COPY pyproject.toml uv.lock ./

# Install dependencies first (cached layer, rarely changes)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Copy source code (changes frequently)
COPY LICENSE ./
COPY src/gradientbang/__init__.py src/gradientbang/
COPY src/gradientbang/game_server/ src/gradientbang/game_server/
COPY src/gradientbang/utils/ src/gradientbang/utils/
COPY src/gradientbang/scripts/ src/gradientbang/scripts/

# Install the project itself
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# Create world-data directory
RUN mkdir -p world-data

# Generate universe data (baked into image for faster startup)
RUN uv run universe-bang 5000 1234

# Change ownership to non-root user
RUN chown -R appuser:appuser /app

# Switch to non-root user for security
USER appuser

# Expose port
EXPOSE 8000

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    WORLD_DATA_DIR=/app/world-data \
    PORT=8000

# Add metadata labels
LABEL org.opencontainers.image.title="Gradient Bang Game Server" \
      org.opencontainers.image.description="FastAPI game server for Gradient Bang" \
      org.opencontainers.image.version="0.2.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/').read()"

# Graceful shutdown signal
STOPSIGNAL SIGTERM

# Run the server
CMD ["uv", "run", "game-server"]
