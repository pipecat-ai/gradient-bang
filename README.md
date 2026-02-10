# Gradient Bang

<img width="640" src="docs/image.png" style="margin-bottom:20px;" />

Gradient Bang is an online multiplayer universe where you explore, trade, battle, and collaborate with other players and with LLMs. Everything in the game is an AI agent, including the ship you command.

The projects demonstrates the full capabilities of realtime agentic workflows, such as multi-tasking, advanced tool calling and low latency voice.

➡️ [Join the play test](https://www.gradient-bang.com)

## Table of Contents

[ todo ]

## Initial setup

If you want to work on Gradient Bang, the first step is getting the entire app running locally. There are four components to run:

- **Supabase** is the "game server". We use its PostrgreSQL database (with some important PL/pgSQL functions) for storage, and [Subabase Edge Functions](https://supabase.com/docs/guides/functions) for the API. Supabase provides a [CLI tool](https://supabase.com/docs/guides/local-development) to run their stack locally for development.
- The **edge functions** dev server serves the functions in the `deployment/supabase/functions` folder.
- The **client** is the game UI, built in React and deployed to Vercel using `turbo`.
- The **bot** is a Pipecat bot, deployed to Pipecat Cloud.

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

Copy the `env.bot.example` file and add your keys:

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

### Run web client

If you're running everything else, the client should run out of the box without an env.

```bash
cd client/

pnpm i─
pnpm run dev
```

You can create a `.env` in the `client/app` directory to configure the client:

```bash
cd app/
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

## Things you need to run for local (and local-adjacent) development

To review, in order to run the full stack locally, you need to be running **Supabase**, **edge functions**, the **client**, and the **bot**.

```bash
# to start Supabase (this runs in the background, so you don't have the leave the terminal open)
npx supabase start --workdir deployment # and don't forget to "npx supabase stop --workdir deployment" when you're done!)

# Keep these open in different terminal windows:
npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase
uv run bot
cd client && pnpm run dev
```

### Bonus: local-adjacent development

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

open `client/app/vite.config.js`, and add the `host` and `allowedHosts` lines so the `server` object at the bottom of the file looks like this:

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
camera briefcase

```bash
set -a && source .env.cloud && set +a
```

### Push database structure

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

Deploy edge functions to your Supabase project. You will see warnings about decorator flags. You can ignore them.

```bash
npx supabase functions deploy --workdir deployment/ --no-verify-jwt
```

Add required secrets. Ignore the warnings about the SUPABASE\_ variables. They are set automatically in the project.

```bash
npx supabase secrets set --env-file .env.cloud
```

Note: we will need to add `BOT_START_START_URL` and `BOT_START_API_KEY` later

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

Create `.env.bot` for Pipecat Cloud:

```bash
DEEPGRAM_API_KEY=...
CARTESIA_API_KEY=...
GOOGLE_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...

SUPABASE_URL=https://{SUPABASE_PROJECT_ID}.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
EDGE_API_TOKEN=...

BOT_USE_KRISP=1

# Optional: LLM provider configuration (defaults shown)
# Supported providers: google, anthropic, openai
VOICE_LLM_PROVIDER=google
VOICE_LLM_MODEL=gemini-2.5-flash
TASK_LLM_PROVIDER=google
TASK_LLM_MODEL=gemini-2.5-flash-preview-09-2025
TASK_LLM_THINKING_BUDGET=2048

# Optional:
TOKEN_USAGE_LOG=logs/token_usage.csv
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

---

### Chad's junk drawer

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

This creates `world-data/universe.json` containing:

- Sector positions and warp connections (hex grid with Delaunay triangulation)
- **Federation Space (fedspace)**: ~200 safe sectors in the graph center where combat is disabled
- **4 Mega-ports**: Special stations in fedspace offering warp recharge, banking, and fighter purchase
- Ports with trade goods (quantum foam, retro-organics, neuro-symbolics)

#### Generate universe map visualization

```bash
uv run -m gradientbang.scripts.universe_svg
```

This creates `artifacts/universe-map.svg` showing sectors, warps, fedspace (highlighted), and mega-ports.

### Copy world data to local Supabase database

```bash

```

### Verify Email:

Open Inbucket (local email viewer) and click confirmation link. Note: In local dev, the redirect URL will not be found.

````bash
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
````

**Grab the `access_token` for the next steps!**

### Test Character Creation

> [!NOTE]
> Character creation can be done via the web client (see below)

Create a character (replace `YOUR_ACCESS_TOKEN` with the token from step 3):

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/user_character_create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "name": "SpaceTrader"
  }'
```

The response includes the `character_id` (UUID) which you'll need for running the NPC agent.

### Looking Up Character IDs

To find the character ID for an existing character by name:

```bash
set -a && source .env.supabase && set +a
uv run character-lookup "SpaceTrader"
```

This outputs the character UUID, which is used with `npc-run` and other scripts.

### Running the NPC Task Agent

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

```bash
# local
scripts/reset-world.sh --env .env.supabase 1000 42
# live
scripts/reset-world.sh --env .env.cloud 1000 42
```
