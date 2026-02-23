# Deploy Supabase Functions

Deploys all Supabase edge functions to production.

## Parameters

Ask the user for:
- **Environment**: `production` (uses `.env.cloud`) or `local` (uses `.env.supabase`)

## Steps

### 1. Source environment variables

For production:
```bash
set -a && source .env.cloud && set +a
```

For local:
```bash
set -a && source .env.supabase && set +a
```

### 2. Deploy functions

```bash
npx supabase functions deploy --workdir deployment/ --no-verify-jwt
```

### 3. Verify

Confirm the output shows all functions deployed successfully. Report any errors to the user.

## Important notes

- This deploys ALL edge functions in `deployment/supabase/functions/`.
- The `--no-verify-jwt` flag disables JWT verification on deployed functions.
- Make sure the Supabase project is linked before deploying (`npx supabase link --project-ref <ref> --workdir deployment`).
