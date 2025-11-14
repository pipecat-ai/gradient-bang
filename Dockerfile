# syntax=docker/dockerfile:1
FROM python:3.12-slim

# Install uv
RUN pip install --no-cache-dir uv

# Set working directory
WORKDIR /app

# Copy dependency files first (for layer caching)
COPY pyproject.toml uv.lock ./


# Copy only necessary source code
COPY src/gradientbang/__init__.py src/gradientbang/
COPY src/gradientbang/game_server/ src/gradientbang/game_server/
COPY src/gradientbang/utils/ src/gradientbang/utils/
RUN touch src/gradientbang/utils/__init__.py
COPY src/gradientbang/scripts/scene_gen.py src/gradientbang/scripts/scene_gen.py
COPY src/gradientbang/scripts/universe_bang.py src/gradientbang/scripts/universe_bang.py
RUN touch src/gradientbang/scripts/__init__.py

COPY LICENSE ./

# Install dependencies
RUN uv sync --frozen --no-dev || uv sync --no-dev

# Create world-data directory
RUN mkdir -p world-data

# Generate universe data (optional - can be mounted instead)
# Uncomment to bake universe data into the image:
RUN uv run universe-bang 5000 1234

# Expose port
EXPOSE 8000

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    WORLD_DATA_DIR=/app/world-data \
    PORT=8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/').read()"

# Run the server
CMD ["uv", "run", "game-server"]