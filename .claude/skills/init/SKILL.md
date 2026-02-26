# Init — Full Project Setup from Scratch

Sets up the entire Gradient Bang local development environment from a fresh clone.

## Prerequisites

Before running this skill, the user must have:
- **Docker** running
- **uv** installed
- **Node.js 18+** installed
- **pnpm** installed

Verify these are available before proceeding. If any are missing, tell the user what to install and stop.

## Steps

### 1. Install Python dependencies

```bash
uv sync --all-groups
```

### 2. Start the local Supabase stack

This downloads and runs all Supabase Docker services. It can take a few minutes on first run.

```bash
npx supabase start --workdir deployment/
```

Redirect output to a file and monitor progress:
```bash
npx supabase start --workdir deployment/ > /tmp/supabase-start.log 2>&1
```

Wait for it to complete successfully. If it fails, show the user the log output.

### 3. Create `.env.supabase`

Only create this file if it does NOT already exist. If it exists, ask the user whether to overwrite it.

Generate the file by extracting keys from the running Supabase instance:

```bash
tok=$(openssl rand -hex 32)
npx supabase status -o env --workdir deployment | awk -F= -v tok="$tok" '
  $1=="API_URL"           {v=$2; gsub(/"/,"",v); print "SUPABASE_URL=" v}
  $1=="ANON_KEY"          {v=$2; gsub(/"/,"",v); print "SUPABASE_ANON_KEY=" v}
  $1=="SERVICE_ROLE_KEY"  {v=$2; gsub(/"/,"",v); print "SUPABASE_SERVICE_ROLE_KEY=" v}
  END {
    print "POSTGRES_POOLER_URL=postgresql://postgres:postgres@db:5432/postgres"
    print "EDGE_API_TOKEN=" tok
    print ""
    print "# Optional overrides"
    print "BOT_START_URL= # used in start function to specify bot start URL. #default: \"http://host.docker.internal:7860/start\""
    print "BOT_START_API_KEY= # used in start function to authenticate start request. #default: None"
    print ""
    print "MOVE_DELAY_SCALE=0.25"
  }
' > .env.supabase
```

Verify the file was created and contains non-empty values for `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`. If any are empty, something went wrong — show the user and stop.

### 4. Install combat cron

Source the env file, then run the cron setup script. This resets the database and seeds combat cron runtime config into `app_runtime_config`.

```bash
set -a && source .env.supabase && set +a
scripts/supabase-reset-with-cron.sh
```

Redirect output to a file:
```bash
scripts/supabase-reset-with-cron.sh > /tmp/supabase-reset-cron.log 2>&1
```

Check the log for the `[reset] Done.` message to confirm success.

### 5. Generate world data and load into Supabase

Generate a universe (5000 sectors, seed 1234) and load it plus quest definitions:

```bash
set -a && source .env.supabase && set +a
uv run universe-bang 5000 1234
uv run -m gradientbang.scripts.load_universe_to_supabase --from-json world-data/
uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/
```

Redirect output and check for errors. These commands can take a minute.

### 6. Open Supabase Studio

Open the local Supabase Studio dashboard in the browser:

```bash
open http://127.0.0.1:54323
```

### 7. Create `.env.bot` from example

Only create this file if it does NOT already exist. If it exists, ask the user whether to overwrite it.

Start by copying the example:
```bash
cp env.bot.example .env.bot
```

The `.env.bot` file needs values from two sources:

**Auto-populated from `.env.supabase`** (fill these in automatically):
- `SUPABASE_URL` — copy from `.env.supabase`
- `SUPABASE_SERVICE_ROLE_KEY` — copy from `.env.supabase`
- `EDGE_API_TOKEN` — copy from `.env.supabase`

**Required API keys — prompt the user for these:**
- `DEEPGRAM_API_KEY` — for speech-to-text (https://console.deepgram.com)
- `CARTESIA_API_KEY` — for text-to-speech (https://play.cartesia.ai)
- `GOOGLE_API_KEY` — for Gemini LLM, used by voice and UI agent (https://aistudio.google.com/apikey)
- `ANTHROPIC_API_KEY` — for Claude LLM, used by task agent (https://console.anthropic.com)

Use AskUserQuestion to collect these keys one prompt at a time. For each key, show the service name and where to get it. If the user provides a value, write it into `.env.bot`. If the user skips a key (empty response), leave it blank in the file and warn them which bot features won't work without it.

After filling in the keys, use `sed` or similar to update the values in `.env.bot`.

### 8. Summary

Print a summary of what was set up:
- Supabase is running (Studio at http://127.0.0.1:54323)
- `.env.supabase` created
- Combat cron installed
- World data loaded (5000 sectors)
- `.env.bot` created (list which API keys were provided vs skipped)

Then tell the user the next steps to start developing:
```
# Terminal 1: Edge functions
npx supabase functions serve --workdir deployment --no-verify-jwt --env-file .env.supabase

# Terminal 2: Bot
set -a && source .env.bot && set +a && uv run bot

# Terminal 3: Client
cd client && pnpm i && pnpm run dev

# Then open http://localhost:5173
```

## Important notes

- All long-running script output should be redirected to files. Do NOT use `tee`.
- If `.env.supabase` or `.env.bot` already exist, always ask before overwriting.
- The `supabase-reset-with-cron.sh` script runs `supabase db reset`, which wipes the database — this is expected for a fresh setup.
- The bot requires at minimum `GOOGLE_API_KEY` (voice LLM) or `ANTHROPIC_API_KEY` (task LLM) to be functional. Warn if neither is provided.
