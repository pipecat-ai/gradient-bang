#!/bin/bash
set -e

# Universe generation defaults
WORLD_SECTOR_COUNT=${WORLD_SECTOR_COUNT:-5000}
WORLD_SEED=${WORLD_SEED:-1234}

echo "==> Starting Gradient Bang Server"

# Check if world data exists
if [ ! -f "${WORLD_DATA_DIR}/universe_structure.json" ]; then
    echo "World data not found at ${WORLD_DATA_DIR}"
    echo "Attempting to generate universe (sectors: ${WORLD_SECTOR_COUNT}, seed: ${WORLD_SEED})..."
    
    if uv run universe-bang ${WORLD_SECTOR_COUNT} ${WORLD_SEED}; then
        echo "Universe generation completed successfully"
    else
        echo "WARNING: Universe generation failed (exit code: $?)"
        echo "Server will start anyway. Generate manually with: uv run universe-bang ${WORLD_SECTOR_COUNT} ${WORLD_SEED}"
    fi
else
    echo "World data found at ${WORLD_DATA_DIR}"
fi

# Always start the server (to support manual universe-bang via ssh)
echo "Starting game server..."
exec uv run game-server
