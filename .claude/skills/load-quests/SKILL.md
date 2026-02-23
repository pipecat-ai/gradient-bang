# Load Quest Data

Loads quest definitions from JSON files in `quest-data/` into Supabase.

## Parameters

Ask the user for:
- **Mode**: `upsert` (default) or `force` (deletes all existing quest data first)
- **Dry run**: whether to validate only without writing (default: no)

## Steps

### 1. Source environment variables

```bash
set -a && source .env.supabase && set +a
```

### 2. Run the quest loader

Upsert mode (default — updates existing quests, inserts new ones):
```bash
uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/
```

Force mode (wipes all quest definitions and reloads from scratch):
```bash
uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/ --force
```

Dry run (validate JSON files without writing to database):
```bash
uv run -m gradientbang.scripts.load_quests_to_supabase --from-json quest-data/ --dry-run
```

### 3. Verify

Confirm the output shows "Success!" and check the stats summary for expected quest/step/subscription counts.

## Important notes

- Each `.json` file in `quest-data/` represents one quest chain. The loader picks up all `*.json` files in the directory.
- The loader upserts by quest `code`, so it's safe to re-run after editing quest data.
- `--force` deletes ALL quest definitions (cascades to steps and subscriptions) before reloading. Player quest progress (`player_quests`, `player_quest_steps`) is NOT affected — but orphaned progress rows will reference deleted step IDs.
- If you get a PostgREST schema cache error, run: `docker exec supabase_db_gb-world-server psql -U postgres -d postgres -c "NOTIFY pgrst, 'reload schema'"` then retry.
