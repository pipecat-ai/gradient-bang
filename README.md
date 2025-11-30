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
6. [Auth & secrets quick guide](#auth--secrets-quick-guide)

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
  --org-id my-supabase-org-slug \
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

> If you don’t plan to run the Supabase pytest suite, run the cron one-liner in the **Combat cron for local dev** section after this command to keep combat rounds auto-resolving.

#### Create `.env.supabase` in project root

Grab the required API keys to create an .env.supabase file for your local Supabase stack configuration:

```bash
tok=$(openssl rand -hex 32)
npx supabase status -o env --workdir deployment | awk -F= -v tok="$tok" '
  $1=="API_URL"           {v=$2; gsub(/"/,"",v); print "SUPABASE_URL=" v}
  $1=="ANON_KEY"          {v=$2; gsub(/"/,"",v); print "SUPABASE_ANON_KEY=" v}
  $1=="SERVICE_ROLE_KEY"  {v=$2; gsub(/"/,"",v); print "SUPABASE_SERVICE_ROLE_KEY=" v}
  $1=="FUNCTIONS_URL"     {v=$2; gsub(/"/,"",v); print "EDGE_FUNCTIONS_URL=" v}
  END {print "EDGE_API_TOKEN=" tok}
'  > .env.supabase
```

#### Combat cron for local dev

- Just run the helper script after `supabase start` (and after any manual reset) to keep combat rounds auto-resolving:

```bash
scripts/supabase-reset-with-cron.sh
```

  - Reads `.env.supabase` for `EDGE_API_TOKEN` and `SUPABASE_URL`.
  - Uses `SUPABASE_INTERNAL_URL` if you need a Linux bridge IP (e.g. `http://172.17.0.1:54321`).
- If you run tests with `USE_SUPABASE_TESTS=1`, fixtures also reapply the GUCs automatically.

#### Optional: Run tests to validate local Supabase stack configuration

To reset your local DB and keep combat cron configured, use the helper script:

```bash
scripts/supabase-reset-with-cron.sh
```

> Quick testing guide:
> - Local functions: start Supabase, run `supabase functions serve --env-file .env.supabase --no-verify-jwt`, then `USE_SUPABASE_TESTS=1 uv run pytest -m supabase --supabase-dir deployment`.
> - Cloud: export production `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `EDGE_API_TOKEN` and run the same pytest command; fixtures detect `supabase.co` and skip local stack.

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
set -a && source .env.supabase && set +a

uv run bot
```

#### Run web client

With both your Supabase functions and Pipecat bot running, in a new terminal window:

```bash
cd client/

pnpm i
pnpm run dev
```

## Deployment 

#### Link remote Supabase project

```bash
npx supabase link --workdir deployment/
```

#### Create `.env.cloud environment

Generate it in one step (prompts for project ref and DB password):

```bash
read -p "Project ref (from Supabase dashboard URL): " PROJECT_REF
read -s -p "DB password (from Settings → Database): " DB_PASS; echo
EDGE_API_TOKEN=$(openssl rand -hex 32)
npx supabase projects api-keys --project-ref "$PROJECT_REF" \
| awk -v tok="$EDGE_API_TOKEN" -v pw="$DB_PASS" -v pr="$PROJECT_REF" '
  /anon[[:space:]]*\|/         {anon=$3}
  /service_role[[:space:]]*\|/ {srv=$3}
  END {
    host=pr ".supabase.co";
    dbhost="db." host;
    print "SUPABASE_URL=https://" host;
    print "SUPABASE_ANON_KEY=" anon;
    print "SUPABASE_SERVICE_ROLE_KEY=" srv;
    print "SUPABASE_DB_URL=postgresql://postgres:" pw "@" dbhost ":5432/postgres";
    print "EDGE_API_TOKEN=" tok;
  }' > .env.cloud
```

Load env into terminal:

```bash
set -a && source .env.cloud && set +a

Production secrets checklist (must be set in Supabase Edge Function secrets):
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DB_URL` (needed for `supabase db push/diff/reset --linked`; copy the full password from the Dashboard → Settings → Database → Connection strings)
- `EDGE_API_TOKEN` (rotate periodically)
- Optional: `EDGE_FUNCTIONS_URL`, bot vars (`BOT_START_URL`, `BOT_START_API_KEY`).
```

#### Push database

```bash
npx supabase db push --workdir deployment/ --linked
```

Add world data

```bash
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
```

#### Deploy edge functions

```bash
npx supabase functions deploy --workdir deployment/
```

> Production: keep the default `verify_jwt=true` (gateway enforces `Authorization: Bearer $SUPABASE_ANON_KEY`) and also set `EDGE_API_TOKEN` in secrets; callers must send both headers. Use `--no-verify-jwt` only for local/dev convenience.

Add required secrets

```bash
npx supabase secrets set --env-file .env.cloud
```

Note: we will need to add `BOT_START_START_URL` and `BOT_START_API_KEY` later

#### Deploy bot to Pipecat Cloud

Create `.env.bot`

```bash
DEEPGRAM_API_KEY=...
CARTESIA_API_KEY=...
GOOGLE_API_KEY=...
SUPABASE_URL=https://{SUPABASE_PROJECT_ID}.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
# Optional:
TOKEN_USAGE_LOG=logs/token_usage.csv
BOT_USE_KRISP=1
```

Create a new secret set on Pipecat Cloud:

```bash
pipecat cloud secrets set gb-bot-secrets --file .env.bot
```

Build and deploy bot 

Note: create image pull credentials if publishing to a private repository

```bash
docker build -f deployment/Dockerfile.bot -t gb-bot:latest .
docker push gb-bot:latest

cd deployment/
pipecat cloud deploy 
# ... or if public
# pipecat cloud deploy --no-credentials
```

#### Update edge functions with API Key and Start URL

Create and note down Public API Key

```bash
pipecat cloud organizations keys create
```

Update `.env.cloud` with additional bot envs:

```bash
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_DB_URL=...
EDGE_API_TOKEN=...
EDGE_FUNCTIONS_URL=...
EDGE_JWT_SECRET=...
# Add these
BOT_START_URL=https://api.pipecat.daily.co/v1/public/{AGENT_NAME}/start
BOT_START_API_KEY=...
```

Apply to edge functions

```bash
npx supabase secrets set --env-file .env.cloud
```

## Auth & secrets quick guide

- **Gateway check (Supabase)**: default `verify_jwt=true` requires `Authorization: Bearer $SUPABASE_ANON_KEY` (or a user access token). Keep this on in production; optional `--no-verify-jwt` only for local.
- **App gate (gameplay)**: every gameplay edge function expects `X-API-Token: $EDGE_API_TOKEN` and uses `SUPABASE_SERVICE_ROLE_KEY` internally for DB access.
- **Bot/client calls**: send both headers. The anon key can be public; the gameplay token must stay secret.
- **Production secrets to set**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `EDGE_API_TOKEN` (+ `EDGE_FUNCTIONS_URL` if overriding, bot envs if used).
- **Combat cron**: ensure DB parameters `app.supabase_url` and `app.edge_api_token` are set to the live URL and the same `EDGE_API_TOKEN`.

#### Point client to your production environment

```bash
touch client/app/.env

VITE_SERVER_URL=https://{SUPABASE_PROJECT_ID}.supabase.co/functions/v1
VITE_PIPECAT_TRANSPORT=daily
```

Run the client

```bash
cd client/

pnpm run dev
```
