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


## Local dev setup

> [!NOTE]
> Docker must be available and running on your system

### Start Supabase locally

This may take some time on first run as required images are downloaded.

```bash
npx supabase start --workdir deployment/ 
```

#### Create `.env.supabase` in project root

Grab the required API keys to create an .env.supabase file for your local Supabase stack configuration:

```bash
tok=$(openssl rand -hex 32)
npx supabase status -o env --workdir deployment | awk -F= -v tok="$tok" '
  $1=="API_URL"           {v=$2; gsub(/"/,"",v); print "SUPABASE_URL=" v}
  $1=="ANON_KEY"          {v=$2; gsub(/"/,"",v); print "SUPABASE_ANON_KEY=" v}
  $1=="SERVICE_ROLE_KEY"  {v=$2; gsub(/"/,"",v); print "SUPABASE_SERVICE_ROLE_KEY=" v}
  END {
    print "POSTGRES_POOLER_URL=postgresql://postgres:postgres@db:5432/postgres"
    print "EDGE_API_TOKEN=" tok
  }
'  > .env.supabase
```

### Combat cron for local dev

- Run the helper after `supabase start` (and after any manual reset) to keep combat rounds auto-resolving:

```bash
scripts/supabase-reset-with-cron.sh
```

See `docs/combat_tick_cron_setup.md` for local/production seeding details and verification queries.

### Optional: run Supabase tests

```bash
set -a && source .env.supabase && set +a && USE_SUPABASE_TESTS=1 uv run pytest tests/integration -v
```

### Generate world data / sector map

Run the universe bang script with number of sectors to chart and random seed

```bash
uv run universe-bang 5000 1234
```

This will create a `world-data` folder in the root of your project

### Copy world data to local Supabase database

```bash
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
```

## Create user account and character

Run Supabase edge functions process (leave running)

```bash
npx supabase functions serve --no-verify-jwt --workdir deployment --env-file .env.supabase
```

### Create user account:

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

### Verify Email:

Open Inbucket (local email viewer) and click confirmation link. Note: In local dev, the redirect URL will not be found.

```bash
open http://127.0.0.1:54324
```

### Login and obtain access token:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "secret123"
  }'
```

**Grab the `access_token` for the next steps!**

### Test Character Creation

Create a character (replace `YOUR_ACCESS_TOKEN` with the token from step 3):

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/user_character_create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "name": "SpaceTrader"
  }'
```

### Run the Pipecat agent and game client

Install Python dependencies:

```bash
uv sync --all-groups
```

Run agent process:

```bash
set -a && source .env.supabase && set +a

uv run bot
```

### Run web client

With both your Supabase functions and Pipecat bot running, in a new terminal window:

```bash
cd client/

pnpm i
pnpm run dev
```

## Deployment 

If you want to run your own game world in the cloud, you will need a Supabase project. 

### Create a new Supabase project

> [!NOTE]
> You can create a Supabase project via the [Supabase Dashboard](https://app.supabase.com) or using the comman line below.


```bash
npx supabase login

npx supabase projects create gb-game-server \
  --db-password <some-secure-password> \
  --region us-west-1 \
  --org-id <my-supabase-org-slug> \
  --size small
```

Push config from [/deployment/supabase](/deployment/supabase/) template:

```bash
npx supabase link --workdir deployment
npx supabase config push --workdir deployment
```

### Create `.env.cloud` environment

Generate it in one step (prompts for project ref and DB password).

Note, this will create a POSTGRES_POOLER_URL that requires IPv6 routing from your machine. If you cannot use IPv6, you will need to click on the "<connect>" button that's in the top bar of your Supabase project dashboard and look up the "Method: Session Pooler" connection string. Change your POSTGRES_POOLER_URL to the Session Pooler format.

```bash
printf "Project ref (from Supabase dashboard URL): "; read PROJECT_REF
printf "DB password (from Settings → Database): "; read -s DB_PASS; echo
EDGE_API_TOKEN=$(openssl rand -hex 32)
npx supabase projects api-keys --project-ref "$PROJECT_REF" --workdir deployment \
| awk -v tok="$EDGE_API_TOKEN" -v pw="$DB_PASS" -v pr="$PROJECT_REF" '
  /anon[[:space:]]*\|/         {anon=$3}
  /service_role[[:space:]]*\|/ {srv=$3}
  END {
    print "SUPABASE_URL=https://" pr ".supabase.co";
    print "SUPABASE_ANON_KEY=" anon;
    print "SUPABASE_SERVICE_ROLE_KEY=" srv;
    print "POSTGRES_POOLER_URL=postgres://postgres:" pw "@db." pr ".supabase.co:6543/postgres";
    print "EDGE_API_TOKEN=" tok;
  }' > .env.cloud
```

Load environment variables, so the next steps will work:

```bash
set -a && source .env.cloud && set +a
```

### Push database structure

Apply all SQL migrations to the linked project

```bash 
npx supabase migration up --workdir deployment/ --db-url "$POSTGRES_POOLER_URL"
```

### Combat round resolution cron config (cloud)

Populate `app_runtime_config` with the Supabase URL and edge token (run after migrations).

```bash
scripts/setup-production-combat-tick.sh
```

Verify:

```bash
psql "$POSTGRES_POOLER_URL" -c "SELECT key, updated_at FROM app_runtime_config WHERE key IN ('supabase_url','edge_api_token');"
```

### Deploy edge functions

Deploy edge functions to your Supabase project. You will see warnings about decorator flags. You can ignore them.

```bash
npx supabase functions deploy --workdir deployment/
```

Add required secrets. Ignore the warnings about the SUPABASE_ variables. They are set automatically in the project.

```bash
npx supabase secrets set --env-file .env.cloud
```

Note: we will need to add `BOT_START_START_URL` and `BOT_START_API_KEY` later

### Optional: run tests against your Supabase cloud project

```bash
set -a && source .env.cloud && set +a && USE_SUPABASE_TESTS=1 uv run pytest tests/integration -v
```

#### Add world data

If you don't already have a universe, create it like this:

```bash
uv run universe-bang 5000 1234
```

Now load it into your Supabase project:

```bash
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
```


### Deploy bot to Pipecat Cloud

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
POSTGRES_POOLER_URL=...
EDGE_API_TOKEN=...
# Add these for bot integration
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
- **Production secrets to set**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_POOLER_URL`, `EDGE_API_TOKEN` (+ bot envs if used).
- **Combat cron**: ensure `app_runtime_config` has `supabase_url` and `edge_api_token` set to the live values (use `scripts/setup-production-combat-tick.sh`).

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
