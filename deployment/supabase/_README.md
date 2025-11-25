# Supabase Getting Started Guide

This guide walks you through setting up Gradient Bang with Supabase, from creating a new project to running NPCs in the cloud.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Create a Supabase Project](#create-a-supabase-project)
3. [Local Development Setup](#local-development-setup)
4. [Environment Configuration](#environment-configuration)
5. [Generate Universe & Test Locally](#generate-universe--test-locally)
6. [Deploy to Supabase Cloud](#deploy-to-supabase-cloud)
7. [Two-Environment Strategy (Test vs Prod)](#two-environment-strategy-test-vs-prod)
8. [Running in the Cloud](#running-in-the-cloud)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Supabase Account**: Sign up at [https://supabase.com](https://supabase.com)
- **Supabase CLI**: Install with `npm install -g supabase`
- **uv**: Python package manager (already in this repo)
- **Docker**: Required for local Supabase stack
- **Node.js 18+**: For edge function deployment

---

## Create a Supabase Project

### 1. Create New Project via Dashboard

1. Go to [https://app.supabase.com](https://app.supabase.com)
2. Click **"New Project"**
3. Choose your organization (or create one)
4. Fill in project details:
   - **Name**: `gradient-bang-test` (or `gradient-bang-prod` for production)
   - **Database Password**: Generate a strong password (save it!)
   - **Region**: Choose closest to your users
   - **Pricing Plan**: Free tier works for testing

5. Click **"Create new project"** (takes ~2 minutes)

### 2. Get Your Project Credentials

Once the project is created:

1. Go to **Settings → API** in the left sidebar
2. Copy these values (you'll need them later):
   - **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - **anon/public key** (under "Project API keys")
   - **service_role key** (click "Reveal" to see it)

3. Go to **Settings → Database**
4. Copy the **Connection string** (Direct connection, PostgreSQL)

### 3. Enable Required Features

#### Enable IPv4 Add-on (Required for direct database access)

1. Go to **Settings → Add-ons**
2. Find **"IPv4 Address"**
3. Click **"Enable"** (Free tier: 1 IPv4 address included)

This allows the universe generation script to connect directly to PostgreSQL.

---

## Local Development Setup

### 1. Install Python Package (Post-Merge Requirement)

**IMPORTANT**: The codebase uses a `src/gradientbang/` package structure. After cloning or merging, you must install the package:

```bash
cd /path/to/gb-supa
uv pip install -e .
```

This installs the `gradientbang` package in editable mode, making imports work correctly.

### 2. Start Local Supabase Stack

```bash
# Initialize Supabase in the project (first time only)
npx supabase init  # Creates supabase/ directory if not present

# Start local Supabase services (PostgreSQL, Auth, Edge Functions, etc.)
npx supabase start
```

**Expected output:**
```
Started supabase local development setup.

         API URL: http://127.0.0.1:54321
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Anon key: eyJhbGci...
Service_role key: eyJhbGci...
```

**Important**: Keep this terminal running! Local Supabase runs in Docker containers.

### 3. Verify Local Stack

Open [http://127.0.0.1:54323](http://127.0.0.1:54323) in your browser to access **Supabase Studio** (local database UI).

### 4. Verify Python Package Installation

```bash
# Test that gradientbang package is importable
uv run python -c "from gradientbang.utils import api_client; print('✓ Package installed correctly')"
```

If this fails with `ModuleNotFoundError`, run `uv pip install -e .` from the project root.

---

## Environment Configuration

Gradient Bang uses environment variables to switch between local and cloud Supabase. **This is how we prevent tests from destroying production data.**

### 1. Create `.env.supabase` (Local Development)

This file is already in the repo. Verify it looks like this:

```bash
# Local Supabase Configuration (from npx supabase start output)
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  # from npx supabase start
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...  # from npx supabase start
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# Edge function API token (local development)
EDGE_API_TOKEN=local-dev-token
EDGE_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1
EDGE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long
```

### 2. Create `.env.cloud.test` (Cloud Test Environment)

```bash
# Supabase Cloud Test Environment
# Project: gradient-bang-test
SUPABASE_URL=https://xxxxx.supabase.co  # From Step 2 above
SUPABASE_ANON_KEY=eyJhbGci...           # From Settings → API
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...   # From Settings → API (click Reveal)
SUPABASE_DB_URL=postgresql://postgres.xxxxx:5432/postgres?sslmode=require  # From Settings → Database

# Edge function configuration
EDGE_API_TOKEN=your-random-token-here  # Generate: openssl rand -hex 32
EDGE_FUNCTIONS_URL=${SUPABASE_URL}/functions/v1
EDGE_JWT_SECRET=your-jwt-secret-here   # Generate: openssl rand -hex 32
```

### 3. Create `.env.cloud.prod` (Cloud Production Environment)

**⚠️ CRITICAL**: This is your production environment. Tests MUST NEVER run against this.

```bash
# Supabase Cloud Production Environment
# Project: gradient-bang-prod
SUPABASE_URL=https://yyyyy.supabase.co  # Different project!
SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
SUPABASE_DB_URL=postgresql://postgres.yyyyy:5432/postgres?sslmode=require

EDGE_API_TOKEN=different-random-token
EDGE_FUNCTIONS_URL=${SUPABASE_URL}/functions/v1
EDGE_JWT_SECRET=different-jwt-secret
```

### 4. Add to `.gitignore`

**NEVER commit credentials to git!** Verify these patterns are in `.gitignore`:

```bash
.env
.env.local
.env.*.local
.env.cloud*
```

The repo includes `.env.supabase` because it only contains local development credentials that are always the same.

---

## Generate Universe & Test Locally

### 1. Load Local Environment

```bash
# From project root
set -a && source .env.supabase && set +a
```

### 2. Apply Database Migrations

```bash
npx supabase db reset  # Resets local DB and applies all migrations
```

### 3. Deploy Edge Functions Locally

```bash
npx supabase functions serve --env-file .env.supabase --no-verify-jwt
```

**Keep this terminal running** - edge functions need to be served.

### 4. Generate Universe (In a New Terminal)

```bash
# Load environment
set -a && source .env.supabase && set +a

# Generate a 100-sector universe with seed 42
cd scripts
uv run python universe-bang.py 100 42
```

**Expected output:**
```
Generating spatial universe with 100 sectors...
Random seed: 42
Placed 100 sectors across 5 regions
Placed 39 ports including mega port at sector 0
Generated universe with 100 sectors
Files created: world-data/universe_structure.json, world-data/sector_contents.json
```

### 5. Run Tests Locally

```bash
# Load environment
set -a && source .env.supabase && set +a

# Run full integration test suite against LOCAL Supabase
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/ -v
```

**Expected output:**
```
343 passed, 58 skipped in ~26 minutes
```

**✅ SUCCESS**: If tests pass, your local Supabase setup is working!

---

## Deploy to Supabase Cloud

### 1. Link to Cloud Project

```bash
# Link to your TEST project
npx supabase link --project-ref xxxxx  # Get ref from project URL
```

The project ref is in your URL: `https://xxxxx.supabase.co` → `xxxxx` is the ref.

### 2. Push Database Migrations

```bash
npx supabase db push
```

This applies all migrations in `supabase/migrations/` to the cloud database.

**Expected output:**
```
Applying migration 20251116050000_drop_events_unique_constraint.sql...
Applying migration 20251117000000_create_admin_infrastructure.sql...
...
Finished supabase db push.
```

### 3. Deploy Edge Functions

```bash
# Deploy all edge functions
npx supabase functions deploy --no-verify-jwt

# Or deploy individually:
npx supabase functions deploy join --no-verify-jwt
npx supabase functions deploy test_reset --no-verify-jwt
# ... etc for each function
```

### 4. Generate Universe in Cloud

```bash
# Load CLOUD environment (TEST)
set -a && source .env.cloud.test && set +a

# Generate universe
cd scripts
uv run python universe-bang.py 100 42
```

The script detects `SUPABASE_URL` and connects to the cloud database directly.

### 5. Create a Character

```bash
# Still in cloud environment
set -a && source .env.cloud.test && set +a

# Create a character
uv run python scripts/character_create.py TraderJ
```

**Expected output:**
```
✓ Supabase character created successfully.
  Name: TraderJ
  Character ID: 9e8593dd-c2b8-5226-ad75-c10714ce373d
```

---

## Two-Environment Strategy (Test vs Prod)

### The Problem

**Tests reset the database**. The `test_reset` edge function and test fixtures clear all characters, combat sessions, and events. **Running tests against production would be catastrophic.**

### The Solution: Environment Isolation

We use **naming conventions** and **environment variable patterns** to prevent accidents.

#### Project Naming

- **Test**: `gradient-bang-test`
- **Prod**: `gradient-bang-prod`

Use completely separate Supabase projects. Never share credentials.

#### Environment File Naming

```
.env.supabase         → Local development (tests OK)
.env.cloud.test       → Cloud test environment (tests OK)
.env.cloud.prod       → Cloud production (tests NEVER)
```

#### Safety Checks in Code

**In `tests/edge/conftest.py`:**

```python
# Fixture automatically checks environment before running
def pytest_configure(config):
    if "SUPABASE_URL" in os.environ:
        url = os.getenv("SUPABASE_URL", "")
        if "prod" in url.lower():
            raise RuntimeError(
                "🚨 DANGER: Attempting to run tests against production!\n"
                "Tests reset the database and will destroy all data.\n"
                "Unset SUPABASE_URL or use .env.cloud.test instead."
            )
```

**This check prevents running tests against any URL containing "prod".**

#### Environment Loading Patterns

**✅ SAFE - Local tests:**
```bash
set -a && source .env.supabase && set +a
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/
```

**✅ SAFE - Cloud test environment:**
```bash
set -a && source .env.cloud.test && set +a
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/
```

**❌ UNSAFE - This will error:**
```bash
set -a && source .env.cloud.prod && set +a
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/  # ← Blocks with safety check
```

**✅ SAFE - Production NPCs (no tests):**
```bash
set -a && source .env.cloud.prod && set +a
uv run python npc/run_npc.py character-id "task"  # ← OK, doesn't reset DB
```

### Migration Workflow

**When making schema changes:**

1. **Develop locally**:
   ```bash
   # Create migration
   npx supabase migration new add_new_feature
   # Edit the migration file
   # Test locally
   npx supabase db reset
   USE_SUPABASE_TESTS=1 uv run pytest tests/integration/
   ```

2. **Deploy to TEST cloud**:
   ```bash
   set -a && source .env.cloud.test && set +a
   npx supabase link --project-ref test-project-ref
   npx supabase db push
   # Run tests against cloud test
   USE_SUPABASE_TESTS=1 uv run pytest tests/integration/
   ```

3. **Deploy to PROD cloud** (only after test succeeds):
   ```bash
   set -a && source .env.cloud.prod && set +a
   npx supabase link --project-ref prod-project-ref
   npx supabase db push  # ← No tests! Just migrations
   ```

---

## Running in the Cloud

### 1. Run an NPC Task

```bash
# Load environment (test or prod)
set -a && source .env.cloud.test && set +a

# Also load Google API key for Gemini
set -a && source .env && set +a

# Run NPC with a task
uv run python npc/run_npc.py 9e8593dd-c2b8-5226-ad75-c10714ce373d \
  --server "$SUPABASE_URL" \
  "Move to sector 5 and find a port"
```

**Expected output:**
```
CONNECT server=https://xxxxx.supabase.co
JOINED target=9e8593dd-c2b8-5226-ad75-c10714ce373d
TASK_START task="Move to sector 5 and find a port"
[STEP] 1 - my_status()
[STEP] 2 - plot_course(to_sector=5)
[STEP] 3 - move(to_sector=1)
...
TASK_COMPLETE status=success
```

### 2. Run Voice Bot (Pipecat)

```bash
# Load environment
set -a && source .env.cloud.prod && set +a
set -a && source .env && set +a

# Set character for voice bot
export PIPECAT_CHARACTER_ID=9e8593dd-c2b8-5226-ad75-c10714ce373d
export PIPECAT_CHARACTER_NAME=TraderJ

# Run bot
uv run python pipecat_server/bot.py
```

The bot automatically detects `SUPABASE_URL` and uses the Supabase client.

### 3. Query Events

```bash
# Load environment
set -a && source .env.cloud.test && set +a

# Query events for a character
uv run python -c "
import asyncio
from gradientbang.utils.supabase_client import AsyncGameClient
from datetime import datetime, timezone, timedelta

async def query():
    client = AsyncGameClient(
        character_id='9e8593dd-c2b8-5226-ad75-c10714ce373d',
        base_url='$SUPABASE_URL'
    )
    end = datetime.now(timezone.utc)
    start = end - timedelta(hours=1)
    result = await client.event_query(
        start=start.isoformat(),
        end=end.isoformat(),
        character_id='9e8593dd-c2b8-5226-ad75-c10714ce373d'
    )
    print(f\"Found {result['count']} events\")
    await client.close()

asyncio.run(query())
"
```

---

## Troubleshooting

### "ModuleNotFoundError: No module named 'gradientbang'"

**Cause**: The package hasn't been installed in editable mode after cloning/merging.

**Fix**:
```bash
cd /path/to/gb-supa
uv pip install -e .

# Verify installation
uv run python -c "from gradientbang.utils import api_client; print('✓ Package installed')"
```

**Why this happens**: After merging main (PR #64 - repo reorganization), the codebase uses a `src/gradientbang/` package structure. Python needs the package installed to resolve imports like `from gradientbang.utils import ...`.

### "SUPABASE_SERVICE_ROLE_KEY is required"

**Cause**: Environment not loaded or incorrect.

**Fix**:
```bash
# Verify environment is loaded
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_ROLE_KEY

# Reload if empty
set -a && source .env.cloud.test && set +a
```

### "relation does not exist" errors

**Cause**: Migrations not applied to the database.

**Fix**:
```bash
# Local:
npx supabase db reset

# Cloud:
npx supabase link --project-ref xxxxx
npx supabase db push
```

### "Edge functions are running without EDGE_API_TOKEN"

**Cause**: Edge functions not started with `--env-file`.

**Fix**:
```bash
# Local:
npx supabase functions serve --env-file .env.supabase --no-verify-jwt

# Cloud: Set secrets in Supabase dashboard
# Settings → Edge Functions → Add secret
# Key: EDGE_API_TOKEN
# Value: (from .env.cloud.test or .env.cloud.prod)
```

### Tests fail with "test_reset edge function is missing"

**Cause**: Edge function not deployed.

**Fix**:
```bash
# Local:
npx supabase functions serve --env-file .env.supabase --no-verify-jwt

# Cloud:
npx supabase functions deploy test_reset --no-verify-jwt
```

### NPC connects to localhost instead of cloud

**Cause**: `SUPABASE_URL` not set or `--server` flag not used.

**Fix**:
```bash
# Verify SUPABASE_URL is set
echo $SUPABASE_URL  # Should show https://xxxxx.supabase.co

# Or use --server flag explicitly
uv run python npc/run_npc.py character-id --server "$SUPABASE_URL" "task"
```

### Tests accidentally run against prod (safety check fails)

**Expected behavior!** This is intentional.

**Output**:
```
🚨 DANGER: Attempting to run tests against production!
Tests reset the database and will destroy all data.
Unset SUPABASE_URL or use .env.cloud.test instead.
```

**Fix**: Use the correct environment file:
```bash
# Unset current environment
unset SUPABASE_URL

# Load test environment
set -a && source .env.cloud.test && set +a
```

---

## Quick Reference

### Local Development Checklist

```bash
# 1. Start Supabase
npx supabase start

# 2. Load environment
set -a && source .env.supabase && set +a

# 3. Reset database
npx supabase db reset

# 4. Serve edge functions (in separate terminal)
npx supabase functions serve --env-file .env.supabase --no-verify-jwt

# 5. Generate universe
cd scripts && uv run python universe-bang.py 100 42

# 6. Run tests
USE_SUPABASE_TESTS=1 uv run pytest tests/integration/ -v
```

### Cloud Deployment Checklist

```bash
# 1. Link project
npx supabase link --project-ref xxxxx

# 2. Push migrations
npx supabase db push

# 3. Deploy functions
npx supabase functions deploy --no-verify-jwt

# 4. Load environment
set -a && source .env.cloud.test && set +a

# 5. Generate universe
cd scripts && uv run python universe-bang.py 100 42

# 6. Create characters
uv run python scripts/character_create.py CharacterName
```

### Environment File Summary

| File | Purpose | Tests OK? | Universe Gen? | NPCs? |
|------|---------|-----------|---------------|-------|
| `.env.supabase` | Local dev | ✅ Yes | ✅ Yes | ✅ Yes |
| `.env.cloud.test` | Cloud test | ✅ Yes | ✅ Yes | ✅ Yes |
| `.env.cloud.prod` | Cloud prod | ❌ **NEVER** | ✅ Yes | ✅ Yes |

---

## Next Steps

- **Explore the codebase**: See `CLAUDE.md` for development guidelines
- **Combat system**: Read `docs/combat_tests_analysis.md`
- **Event system**: Read `docs/event_system_implementation_summary.md`
- **NPCs**: See `npc/README.md` for NPC development
- **Voice bots**: See `pipecat_server/README.md` for voice AI setup

---

**Questions or issues?** Check [docs/runbooks/supabase.md](runbooks/supabase.md) or ask in the project repo.