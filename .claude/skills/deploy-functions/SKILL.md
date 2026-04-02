# Deploy Supabase Functions

Deploys all Supabase edge functions.

## Parameters

The user specifies the environment as an argument: `/deploy-functions dev` or `/deploy-functions prod`. If not provided, ask which environment.

- `dev` → env file: `.env.cloud.dev`
- `prod` → env file: `.env.cloud`

## Steps

### 1. Source environment variables and deploy

```bash
set -a && source <env-file> && set +a && npx supabase functions deploy --workdir deployment/ --no-verify-jwt
```

### 2. Verify

Confirm the output shows all functions deployed successfully. Report any errors to the user.

## Important notes

- This deploys ALL edge functions in `deployment/supabase/functions/`.
- The `--no-verify-jwt` flag disables JWT verification on deployed functions.
- Make sure the Supabase project is linked before deploying (`npx supabase link --project-ref <ref> --workdir deployment`).
