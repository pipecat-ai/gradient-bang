# Deploy

Full deployment: database preflight, edge functions, then bot.

## Parameters

The user specifies the environment as an argument: `/deploy dev`, `/deploy eval`, or `/deploy prod`. If not provided, ask which environment.

## Steps

### 0. Check version and offer release

Read the current version from `pyproject.toml` and the latest git tag. Report both to the user, e.g.:

```
Current version: 0.1.0
Latest tag: v0.1.0
```

Ask the user if they'd like to run `/release` first before deploying. If yes, run the release skill then continue. If no, proceed.

### 1. BYOA database role preflight

Before deploying code, verify the target database has the restricted BYOA
login role and that it inherits the `byoa_bus_client` permission role. This
keeps BYOA environments from deploying with wake configured but no usable
restricted bus login.

Resolve the env file from the deploy target:

- `dev` → `.env.cloud.dev`
- `eval` → `.env.cloud.eval`
- `prod` → `.env.cloud`

Then run:

```bash
set -a && source <env-file> && set +a
psql "$POSTGRES_POOLER_URL" -v ON_ERROR_STOP=1 -Atc "
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = 'byoa_login'
    ) THEN 'missing_login'
    WHEN NOT pg_has_role('byoa_login', 'byoa_bus_client', 'member')
      THEN 'missing_grant'
    ELSE 'ok'
  END;
"
```

Expected output is exactly:

```text
ok
```

If the output is `missing_login` or `missing_grant`, stop the deploy and tell
the user which condition failed. Do not fall back to the bot/service database
role for BYOA. The environment should be repaired by creating/updating the
restricted login and granting it `byoa_bus_client` before rerunning `/deploy`.

If `psql` is missing locally, stop and ask the user to install it or run the
preflight from an environment that has Postgres client tools.

### 2. Deploy edge functions

Run the `/deploy-functions` skill.

### 3. Deploy bot

Run the `/deploy-bot <env>` skill with the same environment.
