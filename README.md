# Gradient Bang

<img width="640" src="docs/image.png" style="margin-bottom:20px;" />

Gradient Bang is an online multiplayer universe where you explore, trade, battle, and collaborate with other players and with LLMs. Everything in the game is an AI agent, including the ship you command.

The projects demonstrates the full capabilities of realtime agentic workflows, such as multi-tasking, advanced tool calling and low latency voice.

➡️ [Join the play test](https://www.gradient-bang.com)

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quickstart](#quickstart)
3. [Running a game server](#running-game-server)
4. [Running the bot](#running-the-bot)
5. [Deployment](#deployment)

## Prerequisites

- **uv**: Python package manager
- **[Supabase Account](https://supabase.com/)**: Game server functions, auth and database
- **Docker**: Required for local Supabase stack and agent deployment
- **Node.js 18+**: For edge function deployment and client
- (Optional) **[Pipecat Cloud Account](https://docs.pipecat.ai/deployment/pipecat-cloud/introduction)**: Production agent hosting
- (Optional) - **[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)**: If you cannot use `npx`, install the CLI globally instead


## Quickstart

### 1. Create a new Supabase project

> [!NOTE]
> You can do this via the [Supabase Dashboard](https://app.supabase.com) if preferred


```bash
npx supabase login

npx supabase projects create gb-game-server \
  --db-password some-secure-password \
  --region us-west-1 \
  --org-id my-org \
  --size small
```

Push config from [/deployment/supabase](/deployment/supabase/) template:

```bash
npx supabase config push --workdir deployment
```

### 2. Local dev setup

> [!NOTE]
> Docker must be available and running on your system

#### Start Supabase locally

This may take some time on first run as required images are downloaded.

```bash
npx supabase start --workdir deployment/ 
```

#### Create `.env.supabase` in project root

Grab the required API keys:

```bash
npx supabase status -o env \
  --override-name auth.anon_key=SUPABASE_ANON_KEY \
  --override-name auth.service_role_key=SUPABASE_SERVICE_KEY \
  --workdir deployment
```

Copy the following into `.env.supabase`:

```bash
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=eyJhbG...
SUPABASE_SERVICE_ROLE_KEY=eyJhbG...

# Edge function configuration
EDGE_API_TOKEN=your-random-token-here  # Generate: openssl rand -hex 32
EDGE_FUNCTIONS_URL=${SUPABASE_URL}/functions/v1
```

#### Optional: Run tests to validate setup

```bash
set -a && source .env.supabase && set +a

USE_SUPABASE_TESTS=1 uv run pytest tests/integration/ -v --supabase-dir deployment
```
If you run tests, be sure to clear database after

```bash
npx supabase db reset --workdir deployment
```

### 3. Generate world data / sector map

Run the universe bang script with number of sectors to chart and random seed

```bash
uv run universe-bang 5000 1234
```

This will create a `world-data` folder in the root of your project

#### Copy world data to local Supabase database

```bash
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
```

### 4. Create user account and character

Run Supabase edge functions process (leave running)

```bash
npx supabase functions serve --no-verify-jwt --workdir deployment --env-file .env.supabase
```

#### Create user account:

Option 1: Manually via Studio dashboard: http://127.0.0.1:54323/project/default/auth/users

Option 2: Via terminal:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "secret123"
  }'
```

#### Verify Email:

Open Inbucket (local email viewer) and click confirmation link. Note: In local dev, the redirect URL will not be found.

```bash
open http://127.0.0.1:54324
```

#### Login and obtain access token:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "secret123"
  }'
```

**Grab the `access_token` for the next steps!**

#### Test Character Creation

Create a character (replace `YOUR_ACCESS_TOKEN` with the token from step 3):

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/user_character_create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "name": "SpaceTrader"
  }'
```

### 5. Run the Pipecat agent and game client

Install Python dependencies:

```bash
uv sync --all-groups
```

Run agent process:

```bash
uv run bot
```

#### Run web client

With both your Supabase functions and Pipecat bot running, in a new terminal window:

```bash
cd client/

pnpm i
pnpm run dev
```