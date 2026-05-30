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

This single command installs dependencies, starts Supabase, generates environment files, creates universe data, and walks you through providing API keys. See [Initial setup](#initial-setup) below for the manual equivalent.

Many of the steps described in this README also have corresponding Claude Code skills — look for the `/skill-name` callouts. See the full [Claude Code skills reference](#claude-code-skills-reference) at the bottom.

## Table of Contents

- [Initial setup](#initial-setup)
- [Running locally](#running-locally)
- [Event delivery modes](#event-delivery-modes)
- [Deployment](#deployment)
- [Environment variables](#environment-variables)
- [Auth & secrets quick guide](#auth--secrets-quick-guide)
- [Claude Code skills reference](#claude-code-skills-reference)

## Initial setup

If you want to work on Gradient Bang, the first step is getting the entire app running locally. There are four components to run:

- **Supabase** is the "game server". We use its PostgreSQL database (with some important PL/pgSQL functions) for storage, and [Supabase Edge Functions](https://supabase.com/docs/guides/functions) for the API. Supabase provides a [CLI tool](https://supabase.com/docs/guides/local-development) to run their stack locally for development.
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

Next, generate a universe and load it into your local database. `universe-bang` writes `tmp/world-data/universe.json` and validates the generated graph before saving it.

```bash
uv run universe-bang 5000 1234

# Load .env.supabase to env (if not done already)
set -a && source .env.supabase && set +a

uv run -m gradientbang.scripts.load_universe_to_supabase --from-json tmp/world-data/ --dry-run
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json tmp/world-data/
```

### Step 2: Edge functions

> **Claude Code:** `/character-create` can handle user registration and character creation interactively.

From here forward, you'll need the Supabase edge functions process running:

```bash
npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase

# or shorthand (Python wrapper around the about)

uv run functions
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
uv sync
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

### Running the NPC task agent

> **Claude Code:** `/npc <character_name>` resolves the name and launches the agent in the background.

Run autonomous tasks with a character using the text-based task agent:

```bash
set -a && source .env.supabase && set +a
uv run npc-run <character-id> "Explore and find 5 new sectors"
```

### Database reset that preserves user accounts

> **Claude Code:** `/reset-world` handles this interactively with environment, sector count, and seed options.

```bash
# local
scripts/reset-world.sh --env .env.supabase 1000 42
# live
scripts/reset-world.sh --env .env.cloud 1000 42
```

Local resets also create/update the restricted BYOA bus login used by `uv run byoa`: `postgresql://byoa_login:byoa_dev_password@127.0.0.1:54322/postgres`.

---

## Event delivery modes

The bot's `AsyncGameClient` receives game events via one of two Supabase event-delivery adapters, picked when event delivery starts based on `EVENT_TRANSPORT`.

### `pubsub` (default)

Direct Postgres reads against a temporary pgmq queue created for the live bot session. The bot calls SECURITY DEFINER functions (`event_session_register` / `event_session_subscribe` / `event_session_archive` / `event_session_unregister`) that:

1. Verify the trusted bot's `EDGE_API_TOKEN` against `public.app_runtime_config.edge_api_token`.
2. Create one random `evs_*` queue before bootstrap RPCs run.
3. Keep the session alive with heartbeat while the bot is online.
4. Return up to N pending messages from that session queue via `pgmq.read`.

The pubsub hot path does not call an edge function per poll. `record_event_with_recipients` still writes durable rows to `events`, then fans out only to active, non-expired `event_sessions`. Offline characters do not receive pgmq copies.

Cleanup is database-owned. A clean bot shutdown calls `event_session_unregister()` and drops the queue immediately. If the bot crashes or is left dangling, heartbeats stop, the session expires, publish ignores it, and the scheduled `event-session-cleanup` pg_cron job drops the queue in bounded batches.

**Setup for local pubsub:**

1. Apply the pubsub migrations; `record_event_with_recipients` writes to active session queues automatically.
2. In `.env.bot`:

   ```
   EVENT_TRANSPORT=pubsub
   PGMQ_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
   EVENT_SESSION_EMPTY_POLL_INTERVAL_SECONDS=1.0
   EVENT_SESSION_HEARTBEAT_SECONDS=15
   EVENT_SESSION_TTL_SECONDS=60
   ```

   Use a session-mode admin Postgres URL. Local Supabase uses `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

3. Make sure `EDGE_API_TOKEN` is present in the bot environment and matches `public.app_runtime_config.edge_api_token` in the target database.

Migration `20260515020000_session_scoped_event_pubsub.sql` adds `event_sessions`, session read/archive/heartbeat wrappers, scheduled cleanup, and session-scoped gameplay event fanout.

### `polling`

HTTP polling against the `events_since` edge function, authenticated by `EDGE_API_TOKEN`. Works in any environment without per-character credentials. Set `EVENT_TRANSPORT=polling` to opt out of pubsub.

### Why two modes?

Polling remains the fallback. Pubsub is the default direct-Postgres path for online sessions. Both modes deliver events through the same client sinks.

---

## Subagent bus transport

Independent of `EVENT_TRANSPORT`: the bot's internal subagent bus (how the player runtime, Orchestrator, and TaskAgent talk to each other) is also transport-pluggable, chosen at startup by `SUBAGENT_BUS_TRANSPORT`. This is the wire BYOA agents ride on; see [docs/byoa.md](docs/byoa.md) for the operator-facing guide.

### `local` (default)

In-process `AsyncQueueBus` from `pipecat.bus`. No env changes needed.

### `pgmq`

Distributed bus over Postgres via upstream `PgmqBus` + `IsolatedPgmqBackend`. The bot mints a fresh UUID-128 channel (`gb_<32hex>`) per voice session and forwards it to BYOA over HTTPS at wake time. Required for BYOA.

```bash
# .env.bot
SUBAGENT_BUS_TRANSPORT=pgmq
SUBAGENT_BUS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

On managed Postgres, prefer the session-mode pooler (port 5432 on Supabase).

BYOA processes never see this DSN. They use the restricted `BYOA_BUS_DATABASE_URL` injected by `wake_agent`, which can only call `public.bus_*` SECURITY DEFINER wrappers gated by per-channel peer registration. Channels are unguessable UUIDs transported wake → BYOA over HTTPS; knowledge of the channel name is the bus capability.

Cleanup is database-owned. A clean bus shutdown calls `bus_leave()` and drops the peer queue immediately. If a bot or BYOA process crashes, the old `gb_<32hex>` channel is abandoned and future sessions mint a fresh channel; the scheduled `subagent-bus-cleanup` pg_cron job drops any remaining `q_*` peer queues older than 48 hours in bounded batches.

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

The `tests/unit/` directory includes unit tests for the bot's agent layer — EventRelay routing, voice runtime tool registration, TaskAgent construction, and runtime integration tests that wire real objects together with mock external boundaries.

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

Populate `app_runtime_config` with the Supabase URL and edge token (run after migrations). The script requires `--env <file>`; production additionally requires `--allow-production`.

```bash
# dev
scripts/setup-production-combat-tick.sh --env .env.cloud.dev

# production (manual; will prompt to type 'MODIFY PRODUCTION')
scripts/setup-production-combat-tick.sh --env .env.cloud --allow-production
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

#### Add Universe Data

Generate the universe JSON locally. The output path is `tmp/world-data/universe.json`.

```bash
uv run universe-bang 5000 1234
```

Validate and load it into the Supabase project referenced by your current environment:

```bash
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json tmp/world-data/ --dry-run
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json tmp/world-data/
```

Load quest definitions (or use `/load-quests`):

```bash
uv run -m gradientbang.scripts.load_quests_to_supabase
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

| Variable                      | Required | Default                                  | Description                                                                                                                                                                                         |
| ----------------------------- | -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                | Yes      | —                                        | Supabase project URL                                                                                                                                                                                |
| `SUPABASE_ANON_KEY`           | Yes      | —                                        | Public Supabase anon JWT key                                                                                                                                                                        |
| `SUPABASE_SERVICE_ROLE_KEY`   | Yes      | —                                        | Service role key (bypasses RLS)                                                                                                                                                                     |
| `POSTGRES_POOLER_URL`         | Yes      | —                                        | PgBouncer pooled Postgres connection string                                                                                                                                                         |
| `EDGE_API_TOKEN`              | Yes      | —                                        | Trusted-backend credential. Edge functions receive it as `X-Edge-Auth`; SQL pubsub readers verify it against `app_runtime_config.edge_api_token`.                                                    |
| `BOT_START_URL`               | No       | `http://host.docker.internal:7860/start` | URL of the bot's `/start` endpoint for creating voice chat sessions                                                                                                                                 |
| `BOT_START_API_KEY`           | No       | —                                        | Bearer token for authenticating requests to the bot start endpoint                                                                                                                                  |
| `MOVE_DELAY_SCALE`            | No       | `1.0`                                    | Multiplier to scale movement delays (set to `0.25` for faster local dev)                                                                                                                            |
| `MOVE_DELAY_SECONDS_PER_TURN` | No       | `0.667`                                  | Base movement delay in seconds per warp turn                                                                                                                                                        |
| `COMBAT_TICK_BATCH_SIZE`      | No       | `20`                                     | Max combat encounters processed per tick                                                                                                                                                            |
| `COMBAT_ROUND_TIMEOUT`        | No       | `30`                                     | Seconds before a combat round auto-resolves                                                                                                                                                         |
| `SHIELD_REGEN_PER_ROUND`      | No       | `10`                                     | Shields regenerated per combat round                                                                                                                                                                |
| `SALVAGE_TTL_SECONDS`         | No       | `900`                                    | TTL for salvage debris (seconds)                                                                                                                                                                    |
| `CHARACTER_SPAWN_MP_DISTANCE` | No       | `8`                                      | Graph distance (hops) from nearest mega port for new character spawns (min `2`)                                                                                                                     |
| `CHARACTER_STARTING_CREDITS`  | No       | `12000`                                  | Credits granted to a new character's starting ship                                                                                                                                                  |
| `CHARACTER_SKIP_AUTO_QUESTS`  | No       | `false`                                  | Set to `true` to skip auto-assigned quests (e.g. tutorial) on new character creation                                                                                                                |
| `CORPORATION_SHIP_OWNER_CAP`  | No       | `5`                                      | Active non-BYOA corporation ships a single character may personally own in one corporation. BYOA-claimed and destroyed ships do not count; unclaiming BYOA can fail if it would exceed the cap.      |
| `EDGE_ADMIN_PASSWORD`         | No       | —                                        | Admin password for admin-only endpoints                                                                                                                                                             |
| `EDGE_ADMIN_PASSWORD_HASH`    | No       | —                                        | SHA-256 hash of admin password (alternative to plaintext)                                                                                                                                           |

### Bot (`.env.bot`)

#### API keys

| Variable            | Required | Description                                                                   |
| ------------------- | -------- | ----------------------------------------------------------------------------- |
| `DEEPGRAM_API_KEY`  | Yes      | [Deepgram](https://console.deepgram.com) API key for speech-to-text           |
| `GRADIUM_API_KEY`   | Yes*     | [Gradium](https://gradium.ai) API key for text-to-speech when `TTS_PROVIDER=gradium` |
| `CARTESIA_API_KEY`  | Yes*     | [Cartesia](https://play.cartesia.ai) API key for text-to-speech when `TTS_PROVIDER=cartesia` |
| `GOOGLE_API_KEY`    | Yes      | [Google AI Studio](https://aistudio.google.com/apikey) key for Gemini LLM     |
| `ANTHROPIC_API_KEY` | No       | [Anthropic](https://console.anthropic.com) key for Claude LLM                 |
| `OPENAI_API_KEY`    | No       | [OpenAI](https://platform.openai.com) key (when using OpenAI as LLM provider) |

*Exactly one TTS key is required for the selected `TTS_PROVIDER`; Gradium is the default.

#### Supabase & connectivity

| Variable                    | Required | Default   | Description                                                                                                                                                                                                                                                       |
| --------------------------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Yes      | —         | Supabase project URL                                                                                                                                                                                                                                              |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | —         | Service role key for DB access                                                                                                                                                                                                                                    |
| `EDGE_API_TOKEN`            | Yes      | —         | Trusted-backend credential sent as `X-Edge-Auth` and verified by SQL pubsub session wrappers. Required outside local auth-bypass test/dev setups.                                                                                                                   |
| `DAILY_API_KEY`             | No       | —         | [Daily](https://www.daily.co/) API key (required for Daily transport)                                                                                                                                                                                             |
| `LOCAL_API_POSTGRES_URL`    | No       | —         | Session pooler connection string to run edge functions locally inside the bot, bypassing Supabase network overhead                                                                                                                                                |
| `EVENT_TRANSPORT`           | No       | `pubsub`  | Event-delivery transport: `pubsub` (direct Postgres reads from a temporary session pgmq queue, default) or `polling` (HTTP via `events_since`). See [Event delivery modes](#event-delivery-modes).                                                                   |
| `PGMQ_URL`                  | No       | —         | Session-mode Postgres URL with admin credentials. Required when `EVENT_TRANSPORT=pubsub`.                                                                                                                                                                          |
| `EVENT_SESSION_HEARTBEAT_SECONDS` | No | `15` | Seconds between pubsub session heartbeats. |
| `EVENT_SESSION_TTL_SECONDS` | No | `60` | Session expiry window extended by each heartbeat. Publish ignores sessions past this expiry. |
| `EVENT_SESSION_HARD_TTL_SECONDS` | No | `21600` | Maximum lifetime for one pubsub event session, even if heartbeats continue. |
| `EVENT_SESSION_VISIBILITY_TIMEOUT_SECONDS` | No | `10` | pgmq visibility timeout for messages read from the session queue. |
| `EVENT_SESSION_EMPTY_POLL_INTERVAL_SECONDS` | No | `1.0` | Client-side pause after a session pgmq read returns no rows. When rows are available, the reader drains immediately without waiting. |
| `EVENT_SESSION_BATCH_QTY` | No | `100` | Maximum messages read per session pgmq poll. |
| `EVENT_SESSION_BOOTSTRAP_DRAIN_TIMEOUT_SECONDS` | No | `2.0` | Maximum time spent draining startup-window messages before agent activation. |
| `SUBAGENT_BUS_CLEANUP_MAX_AGE` | No | `48 hours` | Documented cleanup age; the migration schedules `subagent-bus-cleanup` hourly and drops bus peer queues older than this. |
| `SUBAGENT_BUS_CLEANUP_BATCH_SIZE` | No | `100` | Documented cleanup batch size; the scheduled job drops up to 100 orphaned bus peer queues per run. |

#### TTS configuration

| Variable       | Required | Default   | Description                                             |
| -------------- | -------- | --------- | ------------------------------------------------------- |
| `TTS_PROVIDER` | No       | `gradium` | Text-to-speech provider (`gradium` or `cartesia`)       |

#### LLM configuration

| Variable                               | Required | Default            | Description                                                                                                                                |
| -------------------------------------- | -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `VOICE_LLM_PROVIDER`                   | No       | `google`           | Voice LLM provider (`google`, `anthropic`, `openai`, `minimax`)                                                                            |
| `VOICE_LLM_MODEL`                      | No       | provider default   | Voice LLM model name                                                                                                                       |
| `VOICE_LLM_THINKING_BUDGET`            | No       | `0`                | Token budget for voice agent extended thinking                                                                                             |
| `VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS` | No       | `20`               | Voice agent tool call timeout (seconds)                                                                                                    |
| `TASK_LLM_PROVIDER`                    | No       | `google`           | Task agent LLM provider (`google`, `anthropic`, `openai`, `minimax`)                                                                       |
| `TASK_LLM_MODEL`                       | No       | provider default   | Task agent LLM model name                                                                                                                  |
| `TASK_LLM_THINKING_BUDGET`             | No       | `4096`             | Token budget for task agent extended thinking                                                                                              |
| `TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS`  | No       | `20`               | Task agent tool call timeout (seconds)                                                                                                     |
| `TASK_AGENT_TIMEOUT`                   | No       | —                  | Max task agent lifetime in seconds; cancelled on expiry (e.g. `1800` for 30 min)                                                           |
| `TASK_AGENT_EVENT_DRAIN_GRACE_SECONDS` | No       | `1.0`              | Delay before event-triggered task-agent inference so already-delivered sibling events drain through the ordered mailbox. Set `0` to disable. |
| `UI_AGENT_LLM_PROVIDER`                | No       | `google`           | UI agent LLM provider                                                                                                                      |
| `UI_AGENT_LLM_MODEL`                   | No       | `gemini-2.5-flash` | UI agent LLM model name                                                                                                                    |
| `UI_AGENT_LLM_THINKING_BUDGET`         | No       | `0`                | Token budget for UI agent thinking                                                                                                         |
| `CONTEXT_SUMMARIZATION_MESSAGE_LIMIT`  | No       | `200`   | Max unsummarized messages before context summarization                           |

#### UI agent tuning

| Variable                             | Default | Description                              |
| ------------------------------------ | ------- | ---------------------------------------- |
| `UI_AGENT_STATUS_TIMEOUT_SECS`       | `10`    | Status query timeout (seconds)           |
| `UI_AGENT_PORTS_LIST_TIMEOUT_SECS`   | `15`    | Ports list timeout (seconds)             |
| `UI_AGENT_SHIPS_LIST_TIMEOUT_SECS`   | `15`    | Ships list timeout (seconds)             |
| `UI_AGENT_COURSE_PLOT_TIMEOUT_SECS`  | `25`    | Course plot timeout (seconds)            |
| `UI_AGENT_PORTS_LIST_STALE_SECS`     | `60`    | Ports list staleness threshold (seconds) |
| `UI_AGENT_INTENT_REQUEST_DELAY_SECS` | `2.0`   | Intent request delay (seconds)           |
| `UI_AGENT_SHIPS_CACHE_TTL_SECS`      | `60`    | Ships list cache TTL (seconds)           |

#### Testing & debug

| Variable                      | Default | Description                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_IDLE_REPORT_ENABLED`     | `1`     | Enable idle task status reports (`0` to disable — processor stays in pipeline as a passthrough)                                                                                                                                                                                                                                                                            |
| `BOT_IDLE_REPORT_TIME`        | `9.0`   | Seconds of silence before the bot gives a one-sentence task status update                                                                                                                                                                                                                                                                                                  |
| `BOT_IDLE_REPORT_COOLDOWN`    | `45.0`  | Minimum seconds between consecutive idle reports                                                                                                                                                                                                                                                                                                                           |
| `BOT_NEW_PLAYER_ONBOARDING`   | `1`     | Enable new-player onboarding prompt injection and mega-port route seeding for players with no known mega-port (`0` to disable for evals/tests)                                                                                                                                                                                                                             |
| `BOT_USE_KRISP`               | `0`     | Enable Krisp noise cancellation (`1` for production, `0` for local dev)                                                                                                                                                                                                                                                                                                    |
| `BOT_TEST_CHARACTER_ID`       | —       | Hardcoded character ID for testing. Pair with `BOT_TEST_ACCESS_TOKEN` when invoking `/start` directly (e.g. ladle, curl) — the bot needs both: the character to bind to, and a JWT for that character's owner.                                                                                                                                                             |
| `BOT_TEST_CHARACTER_NAME`     | —       | Hardcoded character name for testing                                                                                                                                                                                                                                                                                                                                       |
| `BOT_TEST_NPC_CHARACTER_NAME` | —       | Hardcoded NPC name for testing                                                                                                                                                                                                                                                                                                                                             |
| `BOT_TEST_ACCESS_TOKEN`       | —       | Dev-only Supabase Auth `access_token` for invoking `/start` directly (ladle, curl, scripts). The bot's `/start` always requires an access_token — production gets it from the proxy edge function; dev sets this env (or passes `access_token` in the body). Use the `/character-create` skill to mint a fresh one alongside `BOT_TEST_CHARACTER_ID`. JWT lifetime is 24h. |
| `LOG_LEVEL`                   | `INFO`  | Logging level (`DEBUG`, `INFO`, `WARNING`, etc.)                                                                                                                                                                                                                                                                                                                           |
| `TOKEN_USAGE_LOG`             | —       | Path for token usage metrics CSV                                                                                                                                                                                                                                                                                                                                           |

#### Optional integrations

| Variable                | Default        | Description                                                    |
| ----------------------- | -------------- | -------------------------------------------------------------- |
| `WANDB_API_KEY`         | —              | [Weights & Biases](https://wandb.ai) API key for Weave tracing |
| `WEAVE_PROJECT`         | `gradientbang` | Weave project name                                             |
| `SMART_TURN_S3_BUCKET`  | —              | S3 bucket for smart turn audio                                 |
| `AWS_ACCESS_KEY_ID`     | —              | AWS access key (for S3 smart turn)                             |
| `AWS_SECRET_ACCESS_KEY` | —              | AWS secret key (for S3 smart turn)                             |
| `AWS_REGION`            | `us-east-1`    | AWS region                                                     |

---

## Auth & secrets quick guide

- **Gateway check (Supabase)**: default `verify_jwt=true` requires `Authorization: Bearer $SUPABASE_ANON_KEY` (or a user access token). Keep this on in production; optional `--no-verify-jwt` only for local.
- **App gate (gameplay)**: every gameplay edge function expects `X-Edge-Auth: $EDGE_API_TOKEN`, except explicit local auth-bypass test/dev setups. `X-API-Token: <user-access-token>` is optional user context for bot sessions.
  - **Bot context**: `X-Edge-Auth` plus a Supabase Auth `access_token` in `X-API-Token`. Edge functions use `canActOnCharacter()` so the caller can only operate on characters they own directly or via corp membership.
  - **Admin context**: `X-Edge-Auth` only. Used by NPCs, the combat-tick cron job, internal `pg_net` invocations, and dev tooling. Bypasses per-character checks by design.
- **BYOA configuration**: `ship_byoa_configure` is authenticated by the caller's Supabase Auth JWT, not `EDGE_API_TOKEN`. Ship lookups for claim/unclaim flows must happen inside that JWT security boundary so operators only see and mutate ships their character is allowed to access.
- **Bot/client calls**: send `apikey: $SUPABASE_ANON_KEY`, `Authorization: Bearer $SUPABASE_ANON_KEY` (gateway), `X-Edge-Auth: $EDGE_API_TOKEN`, and, for user-bound bot sessions, `X-API-Token: <user-access-token>`.
- **Production secrets to set**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_POOLER_URL`, `EDGE_API_TOKEN` (required on every bot, NPC, and cron caller — the trusted-backend gate verifies it on every gameplay edge call).
- **Combat cron**: ensure `app_runtime_config` has `supabase_url` and `edge_api_token` set to the live values (use `scripts/setup-production-combat-tick.sh --env <env-file>`; prod requires `--allow-production`).

---

## Claude Code skills reference

This project includes a set of [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skills (slash commands) that automate common development and testing workflows. Run them inside Claude Code with `/skill-name`.

| Skill               | Description                                                                                                                               | Arguments                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/init`             | Full project setup from a fresh clone. Installs deps, starts Supabase, creates env files, generates universe data, and prompts for API keys. | None — interactive prompts for API keys                                          |
| `/migrate`          | Applies pending Supabase database migrations. Reviews SQL before applying, never resets or drops data.                                    | `local`, `dev`, or `prod`                                                        |
| `/reset-world`      | Resets game database, generates a fresh universe, loads quests, and seeds combat cron config.                                             | Environment (`local`/`cloud`), sector count (default `5000`), seed (optional)    |
| `/load-quests`      | Loads quest definitions from `GRADIENTBANG_QUEST_DATA_DIR` (`data/quests` by default) into Supabase.                                      | Mode (`upsert`/`force`), dry run (yes/no)                                        |
| `/character-create` | Creates a new game character via the `user_character_create` edge function.                                                               | Email, password, character name (all prompted)                                   |
| `/byoa-link`        | Onboards a BYOA operator: claims a corp ship, generates a per-ship wake secret, and writes `.env.byoa`.                                   | Environment (`local`/`prod`)                                                     |
| `/byoa-unlink`      | Releases a BYOA-claimed corp ship — calls `ship_byoa_configure { action: "clear" }` to null the owner server-side. Can fail if unclaiming would put the purchaser over `CORPORATION_SHIP_OWNER_CAP`. | Environment (`local`/`prod`), optional `--ship-id`, `--clear-env`                |
| `/npc <name>`       | Runs an autonomous AI task agent as a game character in the background.                                                                   | Character name (arg or prompted), task description (prompted)                    |
| `/combat <target>`  | Initiates a combat encounter for testing. Shows sector context before starting.                                                           | Character name or ship UUID                                                      |
| `/destroy-ship`     | Destroys a ship for testing — soft-delete, event emission, pseudo-character cleanup.                                                      | Ship UUID (prompted)                                                             |
| `/restore-ship`     | Restores a destroyed ship to full health — clears destroyed flag, restocks stats, recreates pseudo-character.                             | Ship UUID (prompted)                                                             |
| `/deploy <env>`     | Full deployment: deploys edge functions then bot to Pipecat Cloud.                                                                        | `dev` or `prod`                                                                  |
| `/deploy-functions` | Deploys all Supabase edge functions.                                                                                                      | `dev` or `prod`                                                                  |
| `/deploy-bot`       | Deploys the bot to Pipecat Cloud via cloud build.                                                                                         | `dev` or `prod`                                                                  |
| `/newspaper`        | Generates _Gradient News & Observer_ visual assets — banners, full front pages, prompt experiments — by dispatching to the right script.  | Asset type (`banner`, `front-page`, `prompt-experiment`) plus type-specific args |

### `/newspaper` — generating newspaper assets

The newspaper system uses a shared retro-digital aesthetic across multiple asset types. `/newspaper` is the single entry point that routes to the right underlying script. All outputs land under `artifacts/` (gitignored).

**Banners** — single wide masthead-style image (e.g. recruitment header, special-edition broadside):

```
/newspaper banner Call to arms recruiting pilots to test the combat rework. CTA: #gradient-bang
```

The skill drafts kicker / headline / subhead / body / CTA in the newspaper's voice, confirms the copy with you, then renders a 2048×1024 PNG via `news-banner` (~2 minutes per render). Override the shape with `--size 2880x1024` for a Discord-style banner.

**Front pages** — full ten-section newspaper from real game events:

```
/news-front-page 24h
```

`/newspaper front-page` simply forwards to `/news-front-page` — use that directly. It pulls events from the configured Supabase environment, mines storylines, writes the front-page Markdown, and renders a 2160×3840 PNG.

**Prompt experiments** — sweep prompt variants for front-page rendering. See `news-front-page-prompt-experiment --help`.
