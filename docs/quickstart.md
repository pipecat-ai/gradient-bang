# Quickstart

## Local Dev

> [!NOTE]
> Ensure you are authenticated with Supabase first: `npx supabase login`

- All commands assume `--workdir deployment/`. You can update that by setting `GB_WORKDIR`

### Start game server 

```bash
uv sync --group cli
uv run gb start
```

This command will (if supabase not already running):

1. Download and run the Supabase containers (same as `npx supabase start --workdir deployment/`)
2. Health check that Supabase is running ok
3. Create a `.env.local` (if absent) in the root directory with the necessary env vars (and source them)
4. Check and seed the combat cron if not present
5. Migrate the database
6. If no world data exists already, prompt you to create it

#### Check status

Shows current status of the Gradient Bang project environment

```bash
uv run gb status
```

#### Run tests

```bash
uv run gb test
```

### Stopping the game server

```bash
uv run gb stop
```

### Resets and migrations

#### Reset database

```bash
uv run gb reset
```

#### Updating local env

```bash
uv run gb env local --update
uv run gb env show
```

### Worldworld Data