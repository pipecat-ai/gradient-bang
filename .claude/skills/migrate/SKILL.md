# Run Database Migration

Applies pending Supabase migrations to the local or production database. This skill is strictly additive — it only applies new migrations and NEVER resets, truncates, or drops existing data.

## Safety rules — READ BEFORE PROCEEDING

**You MUST follow every rule below. No exceptions.**

1. **NEVER** run `supabase db reset`, `supabase db reset --linked`, or any command that drops/recreates the database.
2. **NEVER** run `DROP TABLE`, `DROP SCHEMA`, `TRUNCATE`, or `DELETE FROM` against any table unless it is explicitly part of the migration SQL the user has already reviewed.
3. **NEVER** pass `--linked` to `db reset`. There is no safe use of `db reset` in this skill.
4. **NEVER** modify or overwrite an existing migration file. Migrations that have already been applied are immutable.
5. **ALWAYS** show the user the exact SQL that will run before applying it.
6. **ALWAYS** confirm with the user before applying migrations to **production**.
7. **NEVER** rely on `--linked` for remote targets. The currently linked project may belong to a different environment than the one the user asked for. Always target the database explicitly via `--db-url "$POSTGRES_POOLER_URL"` (sourced from the env file for the requested environment).
8. If anything looks destructive or risky, **STOP and ask the user** before continuing.

## Parameters

The user specifies the environment as an argument: `/migrate local`, `/migrate dev`, or `/migrate prod`. If not provided, ask which environment.

- `local` → env file: `.env.supabase`
- `dev` → env file: `.env.cloud.dev`
- `prod` → env file: `.env.cloud`

## Steps

### 1. Source environment variables

```bash
set -a && source <env-file> && set +a
```

### 2. Check for pending migrations

List which migrations have already been applied and which are pending.

For **local**:
```bash
npx supabase migration list --workdir deployment --local
```

For **dev** or **prod**, target the env's database directly via `--db-url` — never rely on `--linked`:
```bash
npx supabase migration list --workdir deployment --db-url "$POSTGRES_POOLER_URL"
```

`POSTGRES_POOLER_URL` comes from the env file sourced in step 1; it embeds the password and project host, so this command is unambiguous about which database it hits regardless of what `supabase link` last pointed at.

Show the user the list of pending (not yet applied) migrations.

### 3. Review migration SQL

For each pending migration, read the file from `deployment/supabase/migrations/` and display its contents to the user. Summarise what the migration does. Flag anything that looks destructive (drops, truncates, deletes) and ask the user to confirm.

### 4. Apply the migrations

For **local** — apply pending migrations to the running local Supabase instance:
```bash
npx supabase migration up --workdir deployment --local
```

For **dev** or **prod** — push pending migrations directly to the env's database via `--db-url`:
```bash
npx supabase db push --workdir deployment --db-url "$POSTGRES_POOLER_URL" --include-all
```

Do NOT use `--linked` for remote pushes. Targeting `--db-url` from the just-sourced env file guarantees the push lands on the env the user asked for, even if `supabase link` was last run against a different project.

**Production only:** Before running `db push`, ask the user for explicit confirmation one more time. Show them exactly which migrations will be applied.

### 5. Verify

After applying, re-run the migration list command from step 2 and confirm all migrations now show as applied. Report the result to the user.

## Creating a new migration

If the user wants to create a new migration (not just apply existing ones):

1. Generate a timestamped migration file:
```bash
npx supabase migration new <migration_name> --workdir deployment
```

2. Open the newly created file for the user to write the SQL.
3. After the SQL is written, follow steps 2–5 above to review and apply it.

## Important notes

- Migrations live in `deployment/supabase/migrations/` and follow the naming convention `YYYYMMDDhhmmss_description.sql`.
- For local development, Supabase must already be running (`npx supabase start --workdir deployment/`).
- Each cloud env file (`.env.cloud.dev`, `.env.cloud`) defines `POSTGRES_POOLER_URL` for its project. The skill targets that URL via `--db-url`, so there is no `supabase link` step and no risk of pushing to the wrong project because the link points elsewhere. If a future env file is missing this var, surface that to the user instead of falling back to `--linked`.
- All command output should be redirected to files when it may be verbose. Do NOT use `tee`.
- This skill is **only** for schema migrations. For seeding runtime config (e.g. combat cron), use the `reset-world` or `deploy` skills instead.
