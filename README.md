# Gradient Bang

<img width="640" src="docs/image.png" style="margin-bottom:20px;" />

Gradient Bang is an online multiplayer universe where you explore, trade, battle, and collaborate with other players and with LLMs. Everything in the game is an AI agent, including the ship you command.

The projects demonstrates the full capabilities of realtime agentic workflows, such as multi-tasking, advanced tool calling and low latency voice.

➡️ [Join the play test](https://www.gradient-bang.com)

## Quick start (Claude Code)

If you have [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed, the fastest way to get set up from a fresh clone is:

```
/init
```

This single command installs dependencies, starts Supabase, generates environment files, creates world data, and walks you through providing API keys. See [Initial setup](#initial-setup) below for the manual equivalent.

Many of the steps described in this README also have corresponding Claude Code skills — look for the `/skill-name` callouts. See the full [Claude Code skills reference](#claude-code-skills-reference) at the bottom.

## Table of Contents

- [Initial setup](#initial-setup)
- [Running locally](#running-locally)
- [Deployment](#deployment)
- [Environment variables](#environment-variables)
- [Auth & secrets quick guide](#auth--secrets-quick-guide)
- [Claude Code skills reference](#claude-code-skills-reference)

## Initial setup

If you want to work on Gradient Bang, the first step is getting the entire app running locally. There are four components to run:

- **Supabase** is the "game server". We use its PostrgreSQL database (with some important PL/pgSQL functions) for storage, and [Subabase Edge Functions](https://supabase.com/docs/guides/functions) for the API. Supabase provides a [CLI tool](https://supabase.com/docs/guides/local-development) to run their stack locally for development.
- The **edge functions** dev server serves the functions in the `deployment/supabase/functions` folder.
- The **client** is the game UI, built in React and deployed to Vercel using `turbo`.
- The **bot** is a Pipecat bot, deployed to [Pipecat Cloud](https://docs.pipecat.ai/deployment/pipecat-cloud/introduction).

### Prerequisites

- **uv**: Python package manager
- **[Supabase Account](https://supabase.com/)**: Game server functions, auth and database
- **Docker**: Required for local Supabase stack and agent deployment
- **Node.js 18+**: For edge function deployment and client
- (Optional) **[Pipecat Cloud Account](https://docs.pipecat.ai/deployment/pipecat-cloud/introduction)**: Production agent hosting
- (Optional) - **[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)**: If you cannot use `npx`, install the CLI globally instead

### Step 1: Set up Supabase

First, run `supabase start`. Supabase is several services in a trenchcoat. This command downloads and runs all of the various Docker images. When you run this, you'll see a bunch of services listening on different ports that we'll use later.

```bash
npx supabase start --workdir deployment/
```

Next, grab the required API keys to create an .env.supabase file for your local Supabase stack configuration:

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

Next, run this helper after `supabase start` (and after any manual database reset). It sets up some important PL/pgSQL functions to keep combat rounds auto-resolving:

```bash
scripts/supabase-reset-with-cron.sh
```

Next, run the universe bang script with number of sectors to chart and a random seed. This creates world data. Then, load that data into your local database.

```bash
uv run universe-bang 5000 1234

# Load .env.supabase to env (if not done already)
set -a && source .env.supabase && set +a

uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
```

### Step 2: Edge functions

> **Claude Code:** `/character-create` can handle user registration and character creation interactively.

From here forward, you'll need the Supabase edge functions process running:

```bash
npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase
```

You'll need to create a user account in your database in order log in. We don't have a UI for that right now, so you can do it one of two ways.

Option 1: Your local Supabase has a Studio dashboard: http://127.0.0.1:54323/project/default/auth/users

Click the "Add user" green button on the right, then click "Create new user". Type a username and password, and leave "Auto Confirm User?" checked.

Option 2: Via terminal:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "secret123"
  }'
```

### Step 3: Run the Pipecat bot and game client

Install Python dependencies:

```bash
uv sync --all-groups
```

Copy the `env.bot.example` file and add your keys (see [Bot environment variables](#bot-env-bot) for the full list):

_Note: Keep `BOT_USE_KRISP` to `0` in local dev ([see here](https://docs.pipecat.ai/deployment/pipecat-cloud/guides/krisp-viva#local-development))_

```bash
cp env.bot.example .env.bot
```

Finally, run the bot process:

```bash
# The simple way for local dev and SmallWebRTCTransport
uv run bot
# Add "-t daily --host 0.0.0.0" to use the Daily transport and listen on all interfaces (for use with Tailscale, for example)
uv run bot -t daily --host 0.0.0.0
```

#### Local pooler mode

By default the bot calls Supabase Edge Functions over HTTP for all game server operations. This adds latency (500ms avg, up to 10s on cold starts). If you set `LOCAL_API_POSTGRES_URL` in `.env.bot` to a Supabase session pooler connection string, the bot runs the equivalent function logic locally against Postgres directly, bypassing the edge function network hop entirely. This is especially useful in production where the bot container and database are co-located.

### Step 4: Run web client

If you're running everything else, the client should run out of the box without an env.

```bash
cd client/
pnpm i
pnpm run dev
```

You can create a `.env` in the `client/app` directory to configure the client:

```bash
cd client/app/
cp env.example .env.local
```

That should be everything you need. You should be able to open http://localhost:5173, sign in with the username and password you set up, create a character, and start talking!

On my Linux box running the `ufw` firewall, I had to add a firewall rule to allow Supabase's docker containers to talk to themselves:

```bash
# Run one of these to fix it:
# Allow from all Docker networks
sudo ufw allow from 172.16.0.0/12 to any port 7860 proto tcp

# Or more restrictive — just the Supabase bridge network
sudo ufw allow from 172.18.0.0/16 to any port 7860 proto tcp
```

---

## Running locally

To review, in order to run the full stack locally, you need to be running **Supabase**, **edge functions**, the **client**, and the **bot**.

```bash
# to start Supabase (this runs in the background, so you don't have the leave the terminal open)
npx supabase start --workdir deployment # and don't forget to "npx supabase stop --workdir deployment" when you're done!)

# Keep these open in different terminal windows:
npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase
uv run bot
cd client && pnpm run dev
```

### Looking up character IDs

To find the character ID for an existing character by name:

```bash
set -a && source .env.supabase && set +a
uv run character-lookup "SpaceTrader"
```

### Running the NPC task agent

> **Claude Code:** `/npc <character_name>` resolves the name and launches the agent in the background.

Run autonomous tasks with a character using the text-based task agent:

```bash
set -a && source .env.supabase && set +a
uv run npc-run <character-id> "Explore and find 5 new sectors"
```

Example with a looked-up character:

```bash
set -a && source .env.supabase && set +a
uv run npc-run $(uv run character-lookup "SpaceTrader") "Check my status and move to an adjacent sector"
```

### Database reset that preserves user accounts

> **Claude Code:** `/reset-world` handles this interactively with environment, sector count, and seed options.

```bash
# local
scripts/reset-world.sh --env .env.supabase 1000 42
# live
scripts/reset-world.sh --env .env.cloud 1000 42
```

### Generate universe map visualization

```bash
uv run -m gradientbang.scripts.universe_svg
```

This creates `artifacts/universe-map.svg` showing sectors, warps, fedspace (highlighted), and mega-ports.

### Local-adjacent development (Tailscale)

If you want to be able to run your Gradient Bang stack on one computer and access it on another, the easiest way is to use [Tailscale](https://tailscale.com/). You can use `tailscale serve` along with a few config changes to make it available on your Tailnet. The `systemd` folder includes another service, `gradient-bang-tailscale.service`, that runs a few `tailscale serve` commands that are designed to work with a few environment changes. In the snippet below, `apollo` is the name of your machine, and `seahorse-peacock` is your Tailscale DNS name. [Follow these directions](https://tailscale.com/docs/how-to/set-up-https-certificates) to set up HTTPS for your Tailnet, then run `tailscale cert` on this machine. (While you're in your Tailscale dashboard, you can go to the DNS section to get a fun name like seahorse-peacock instead of the random hex if you want).

Make these changes to your environment files:

```bash
# .env.supabase
DAILY_API_KEY=7df... # Your Daily API key, because you'll want to run the Daily transport
SUPABASE_URL=https://apollo.seahorse-peacock.ts.net:8443/edge

# .env.bot
SUPABASE_URL=https://apollo.seahorse-peacock.ts.net:8443/edge
DAILY_API_KEY=7df...

# client/app/.env.local
VITE_SERVER_URL=https://apollo.seahorse-peacock.ts.net:8443/edge/functions/v1
VITE_PIPECAT_TRANSPORT=daily
VITE_BOT_URL=https://apollo.seahorse-peacock.ts.net:8443/bot
```

Open `client/app/vite.config.js`, and add the `host` and `allowedHosts` lines so the `server` object at the bottom of the file looks like this:

```js
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      // Watch the starfield dist for changes
      ignored: ["!**/node_modules/@gradient-bang/**"],
    },
  },
```

Then run a few `tailscale serve` commands, along with the other services.

```bash
# Run these if you're not using gradient-bang-tailscale.service, which runs them for you
tailscale serve --bg --https 443 http://localhost:5173
tailscale serve --bg --https 8443 --set-path=edge http://localhost:54321
tailscale serve --bg --https 8443 --set-path=bot http://localhost:7860

# To turn them all off:
tailscale serve reset

# to start Supabase (this runs in the background, so you don't have the leave the terminal open)
npx supabase start --workdir deployment # and don't forget to "npx supabase stop --workdir deployment" when you're done!)

# Keep these open in different terminal windows:
npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase
# add the transport and host options to the bot
uv run bot -t daily --host 0.0.0.0
cd client && pnpm run dev
```

On Linux, I use `systemd` to manage all of those. There's a `systemd` folder that includes files for all four of those components, and a `gradient-bang.target` file that lets me do this:

```bash
# Start working
systemctl --user start gradient-bang.target

# Restart everything, because sometimes you can't be too careful
systemctl --user restart gradient-bang.target

# Give me my computer back, please
systemctl --user stop gradient-bang.target
```

But _actually_, I created an alias to make that even easier:

```bash
gb() {
  systemctl --user "$@" gradient-bang.target
}

# Now I can just do this to start:
gb start
```

---

## Running tests

### Edge function tests (Deno)

Integration tests for the game server (edge functions) live in `deployment/supabase/functions/tests/`.

**Dependencies:** Docker, Node.js / npx (Deno is installed automatically by the Supabase CLI).

No `.env` file is needed — the test runner creates its own isolated Supabase stack on ephemeral ports and extracts credentials automatically.

```bash
bash deployment/supabase/functions/tests/run_tests.sh
```

The runner starts an isolated Supabase instance, runs the tests with coverage, prints a coverage report, and tears everything down automatically.

### Python tests (pytest)

Python tests live in `tests/` and use pytest markers to categorize them.

```bash
# Run all unit tests (no server needed)
uv run pytest -m unit -v

# Run only LLM behavior tests (context summarization, etc.)
uv run pytest -m llm -v
```

Available markers: `unit`, `llm`, `integration`, `stress`, `live_api`.

### Unit tests

The `tests/unit/` directory includes unit tests for the bot's agent layer — EventRelay routing, VoiceAgent tool registration, TaskAgent construction, and EventRelay↔VoiceAgent integration tests that wire real objects together with mock external boundaries.

```bash
# Run all unit tests
uv run pytest -m unit -v

# Run only the relay↔voice integration tests
uv run pytest tests/unit/test_voice_relay_integration.py -v
```

### Python integration tests (requires DB)

Python integration tests need a seeded Supabase database. An all-in-one script handles the lifecycle: it spins up an isolated Supabase instance on different ports (54421+), seeds it via `test_reset`, runs `pytest -m integration`, and tears everything down. The dev database is never touched.

```bash
# Run all integration tests
bash scripts/run-integration-tests.sh

# Pass extra pytest args
bash scripts/run-integration-tests.sh -v -k "test_movement"
```

Integration tests are automatically skipped when running `uv run pytest` directly (without the script).

---

## Deployment

If you want to run your own game world in the cloud, you will need a Supabase project.

### Create a new Supabase project

> [!NOTE]
> You can create a Supabase project via the [Supabase Dashboard](https://app.supabase.com) or using the command line below.

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

> **Claude Code:** `/migrate` applies pending migrations safely with review and confirmation steps.

#### Optional: reset remote database

```bash
npx supabase link --workdir deployment
npx supabase db reset --linked --workdir deployment
npx supabase db push --workdir deployment
```

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

> **Claude Code:** `/deploy-functions` deploys all edge functions to production or local.

Deploy edge functions to your Supabase project. You will see warnings about decorator flags. You can ignore them.

```bash
npx supabase functions deploy --workdir deployment/ --no-verify-jwt
```

Add required secrets. Ignore the warnings about the SUPABASE\_ variables. They are set automatically in the project.

```bash
npx supabase secrets set --env-file .env.cloud
```

Note: we will need to add `BOT_START_URL` and `BOT_START_API_KEY` later.

#### Add world data

If you don't already have a universe, create it like this:

```bash
uv run universe-bang 5000 1234
```

Now load it into your Supabase project:

```bash
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
```

Load quest definitions (or use `/load-quests`):

```bash
uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/
```

### Deploy bot to Pipecat Cloud

> **Claude Code:** `/deploy-bot` handles the full build, push, and deploy flow interactively.

Create `.env.bot` for Pipecat Cloud (see [Bot environment variables](#bot-env-bot) for the full list):

```bash
cp env.bot.example .env.bot
# Fill in your API keys and Supabase credentials
```

Create a new secret set on Pipecat Cloud:

```bash
pipecat cloud secrets set gb-bot-secrets --file .env.bot
```

Build and deploy bot:

```bash
docker build -f deployment/Dockerfile.bot -t gb-bot:latest .
docker push gb-bot:latest

cd deployment/
pipecat cloud deploy
# ... or if public
# pipecat cloud deploy --no-credentials
```

#### Update edge functions with bot start URL

Create and note down a Public API Key:

```bash
pipecat cloud organizations keys create
```

Add bot integration vars to `.env.cloud`:

```bash
BOT_START_URL=https://api.pipecat.daily.co/v1/public/{AGENT_NAME}/start
BOT_START_API_KEY=...
```

Apply to edge functions:

```bash
npx supabase secrets set --env-file .env.cloud
```

#### Point client to your production environment

```bash
# client/app/.env
VITE_SERVER_URL=https://{SUPABASE_PROJECT_ID}.supabase.co/functions/v1
VITE_PIPECAT_TRANSPORT=daily
```

```bash
cd client/
pnpm run dev
```

---

## Environment variables

### Edge functions (`.env.supabase` / `.env.cloud`)

| Variable                      | Required | Default                                  | Description                                                                                                              |
| ----------------------------- | -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SUPABASE_URL`                | Yes      | —                                        | Supabase project URL                                                                                                     |
| `SUPABASE_ANON_KEY`           | Yes      | —                                        | Public Supabase anon JWT key                                                                                             |
| `SUPABASE_SERVICE_ROLE_KEY`   | Yes      | —                                        | Service role key (bypasses RLS)                                                                                          |
| `POSTGRES_POOLER_URL`         | Yes      | —                                        | PgBouncer pooled Postgres connection string                                                                              |
| `EDGE_API_TOKEN`              | Yes      | —                                        | Token for authenticating internal requests via `X-API-Token` header. When unset, token validation is skipped (local dev) |
| `BOT_START_URL`               | No       | `http://host.docker.internal:7860/start` | URL of the bot's `/start` endpoint for creating voice chat sessions                                                      |
| `BOT_START_API_KEY`           | No       | —                                        | Bearer token for authenticating requests to the bot start endpoint                                                       |
| `MOVE_DELAY_SCALE`            | No       | `1.0`                                    | Multiplier to scale movement delays (set to `0.25` for faster local dev)                                                 |
| `MOVE_DELAY_SECONDS_PER_TURN` | No       | `0.667`                                  | Base movement delay in seconds per warp turn                                                                             |
| `COMBAT_TICK_BATCH_SIZE`      | No       | `20`                                     | Max combat encounters processed per tick                                                                                 |
| `COMBAT_ROUND_TIMEOUT`        | No       | `30`                                     | Seconds before a combat round auto-resolves                                                                              |
| `SHIELD_REGEN_PER_ROUND`      | No       | `10`                                     | Shields regenerated per combat round                                                                                     |
| `SALVAGE_TTL_SECONDS`         | No       | `900`                                    | TTL for salvage debris (seconds)                                                                                         |
| `EDGE_ADMIN_PASSWORD`         | No       | —                                        | Admin password for admin-only endpoints                                                                                  |
| `EDGE_ADMIN_PASSWORD_HASH`    | No       | —                                        | SHA-256 hash of admin password (alternative to plaintext)                                                                |

### Bot (`.env.bot`)

#### API keys

| Variable | Required | Description |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | Yes | [Deepgram](https://console.deepgram.com) API key for speech-to-text |
| `CARTESIA_API_KEY` | Yes | [Cartesia](https://play.cartesia.ai) API key for text-to-speech |
| `GOOGLE_API_KEY` | Yes | [Google AI Studio](https://aistudio.google.com/apikey) key for Gemini LLM |
| `ANTHROPIC_API_KEY` | No | [Anthropic](https://console.anthropic.com) key for Claude LLM |
| `OPENAI_API_KEY` | No | [OpenAI](https://platform.openai.com) key (when using OpenAI as LLM provider) |

#### Supabase & connectivity

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Service role key for DB access |
| `EDGE_API_TOKEN` | Yes | — | Token for authenticating edge function calls |
| `DAILY_API_KEY` | No | — | [Daily](https://www.daily.co/) API key (required for Daily transport) |
| `LOCAL_API_POSTGRES_URL` | No | — | Session pooler connection string to run edge functions locally inside the bot, bypassing Supabase network overhead |

#### LLM configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VOICE_LLM_PROVIDER` | Yes | — | Voice LLM provider (`google`, `anthropic`, `openai`) |
| `VOICE_LLM_MODEL` | Yes | — | Voice LLM model name |
| `VOICE_LLM_THINKING_BUDGET` | No | `0` | Token budget for voice agent extended thinking |
| `VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS` | No | `20` | Voice agent tool call timeout (seconds) |
| `TASK_LLM_PROVIDER` | Yes | — | Task agent LLM provider |
| `TASK_LLM_MODEL` | Yes | — | Task agent LLM model name |
| `TASK_LLM_THINKING_BUDGET` | No | `4096` | Token budget for task agent extended thinking |
| `TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS` | No | `20` | Task agent tool call timeout (seconds) |
| `TASK_AGENT_TIMEOUT` | No | — | Max task agent lifetime in seconds; cancelled on expiry (e.g. `1800` for 30 min) |
| `UI_AGENT_LLM_PROVIDER` | Yes | — | UI agent LLM provider |
| `UI_AGENT_LLM_MODEL` | Yes | — | UI agent LLM model name |
| `UI_AGENT_LLM_THINKING_BUDGET` | No | `0` | Token budget for UI agent thinking |
| `CONTEXT_SUMMARIZATION_MESSAGE_LIMIT` | No | `200` | Max unsummarized messages before context summarization |

#### UI agent tuning

| Variable | Default | Description |
| --- | --- | --- |
| `UI_AGENT_STATUS_TIMEOUT_SECS` | `10` | Status query timeout (seconds) |
| `UI_AGENT_PORTS_LIST_TIMEOUT_SECS` | `15` | Ports list timeout (seconds) |
| `UI_AGENT_SHIPS_LIST_TIMEOUT_SECS` | `15` | Ships list timeout (seconds) |
| `UI_AGENT_COURSE_PLOT_TIMEOUT_SECS` | `25` | Course plot timeout (seconds) |
| `UI_AGENT_PORTS_LIST_STALE_SECS` | `60` | Ports list staleness threshold (seconds) |
| `UI_AGENT_INTENT_REQUEST_DELAY_SECS` | `2.0` | Intent request delay (seconds) |
| `UI_AGENT_SHIPS_CACHE_TTL_SECS` | `60` | Ships list cache TTL (seconds) |

#### Testing & debug

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_USE_KRISP` | `0` | Enable Krisp noise cancellation (`1` for production, `0` for local dev) |
| `BOT_TEST_CHARACTER_ID` | — | Hardcoded character ID for testing |
| `BOT_TEST_CHARACTER_NAME` | — | Hardcoded character name for testing |
| `BOT_TEST_NPC_CHARACTER_NAME` | — | Hardcoded NPC name for testing |
| `LOG_LEVEL` | `INFO` | Logging level (`DEBUG`, `INFO`, `WARNING`, etc.) |
| `TOKEN_USAGE_LOG` | — | Path for token usage metrics CSV |

#### Optional integrations

| Variable | Default | Description |
| --- | --- | --- |
| `WANDB_API_KEY` | — | [Weights & Biases](https://wandb.ai) API key for Weave tracing |
| `WEAVE_PROJECT` | `gradientbang` | Weave project name |
| `SMART_TURN_S3_BUCKET` | — | S3 bucket for smart turn audio |
| `AWS_ACCESS_KEY_ID` | — | AWS access key (for S3 smart turn) |
| `AWS_SECRET_ACCESS_KEY` | — | AWS secret key (for S3 smart turn) |
| `AWS_REGION` | `us-east-1` | AWS region |

---

## Auth & secrets quick guide

- **Gateway check (Supabase)**: default `verify_jwt=true` requires `Authorization: Bearer $SUPABASE_ANON_KEY` (or a user access token). Keep this on in production; optional `--no-verify-jwt` only for local.
- **App gate (gameplay)**: every gameplay edge function expects `X-API-Token: $EDGE_API_TOKEN` and uses `SUPABASE_SERVICE_ROLE_KEY` internally for DB access.
- **Bot/client calls**: send both headers. The anon key can be public; the gameplay token must stay secret.
- **Production secrets to set**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_POOLER_URL`, `EDGE_API_TOKEN` (+ bot envs if used).
- **Combat cron**: ensure `app_runtime_config` has `supabase_url` and `edge_api_token` set to the live values (use `scripts/setup-production-combat-tick.sh`).

---

## Claude Code skills reference

This project includes a set of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills (slash commands) that automate common development and testing workflows. Run them inside Claude Code with `/skill-name`.

| Skill               | Description                                                                                                                               | Arguments                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/init`             | Full project setup from a fresh clone. Installs deps, starts Supabase, creates env files, generates world data, and prompts for API keys. | None — interactive prompts for API keys                                        |
| `/migrate`          | Applies pending Supabase database migrations. Reviews SQL before applying, never resets or drops data.                                    | `local` or `production` (prompted)                                             |
| `/reset-world`      | Resets game database, generates a fresh universe, loads quests, and seeds combat cron config.                                             | Environment (`local`/`cloud`), sector count (default `5000`), seed (optional)  |
| `/load-quests`      | Loads quest definitions from `quest-data/` JSON files into Supabase.                                                                      | Mode (`upsert`/`force`), dry run (yes/no)                                      |
| `/character-create` | Creates a new game character via the `user_character_create` edge function.                                                               | Email, password, character name (all prompted)                                 |
| `/npc <name>`       | Runs an autonomous AI task agent as a game character in the background.                                                                   | Character name (arg or prompted), task description (prompted)                  |
| `/combat <target>`  | Initiates a combat encounter for testing. Shows sector context before starting.                                                           | Character name or ship UUID                                                    |
| `/destroy-ship`     | Destroys a ship for testing — soft-delete, event emission, pseudo-character cleanup.                                                      | Ship UUID (prompted)                                                           |
| `/restore-ship`     | Restores a destroyed ship to full health — clears destroyed flag, restocks stats, recreates pseudo-character.                             | Ship UUID (prompted)                                                           |
| `/deploy-functions` | Deploys all Supabase edge functions.                                                                                                      | Environment (`production`/`local`)                                             |
| `/deploy-bot`       | Builds the bot Docker image, pushes to registry, and optionally deploys to Pipecat Cloud.                                                 | Image tag (from `pcc-deploy.toml` or custom), platform (`linux/arm64` default) |
