# Deploy Supabase Functions

Deploys all Supabase edge functions.

## Parameters

The user specifies the environment as an argument: `/deploy-functions dev`, `/deploy-functions eval`, or `/deploy-functions prod`. If not provided, ask which environment.

- `dev` → env file: `.env.cloud.dev`
- `eval` → env file: `.env.cloud.eval`
- `prod` → env file: `.env.cloud`

## Steps

### 1. Source env and resolve the project ref

```bash
set -a && source <env-file> && set +a
PROJECT_REF=$(echo "$SUPABASE_URL" | sed -E 's|https://([^.]+).*|\1|')
echo "Deploying to project: $PROJECT_REF"
```

`SUPABASE_URL` is defined in every cloud env file (`https://<ref>.supabase.co`). Extracting the ref from it pins the deploy to the env the user asked for, regardless of what `supabase link` last pointed at. **Never** rely on `--linked` for remote deploys — the linked project may belong to a different environment.

### 2. Deploy

```bash
npx supabase functions deploy --workdir deployment/ --no-verify-jwt --project-ref "$PROJECT_REF"
```

### 3. Verify

Confirm the output shows all functions deployed successfully (`Deployed Functions on project <ref>: ...`) and that the printed project ref matches the env you intended. Report any errors to the user.

## Important notes

- This deploys ALL edge functions in `deployment/supabase/functions/`.
- The `--no-verify-jwt` flag disables JWT verification on deployed functions.
- The skill is independent of `supabase link` — `--project-ref` is the source of truth.
