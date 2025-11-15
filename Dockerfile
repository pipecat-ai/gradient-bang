ARG PYTHON_VERSION=3.12
FROM ghcr.io/astral-sh/uv:python${PYTHON_VERSION}-trixie-slim

# Set working directory
WORKDIR /app

RUN apt-get update

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy

# Copy dependency files for installation
COPY pyproject.toml uv.lock ./

# Copy source code
COPY LICENSE ./
COPY src/gradientbang/__init__.py src/gradientbang/
COPY src/gradientbang/game_server/ src/gradientbang/game_server/
COPY src/gradientbang/utils/ src/gradientbang/utils/
COPY src/gradientbang/scripts/ src/gradientbang/scripts/

# Place executables in the environment at the front of the path
ENV PATH="/app/.venv/bin:$PATH"

# Install the project's dependencies using the lockfile and settings
# --no-dev excludes dev dependencies; bot group is not included by default
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Create world-data directory
RUN mkdir -p world-data

# Generate universe data (baked into image for faster startup)
RUN uv run universe-bang 5000 1234

# Create non-root user
RUN useradd -m -u 1000 appuser

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
