# Deploy Supabase Functions

Deploys all Supabase edge functions.

## Parameters

The user specifies the environment as an argument: `/deploy-functions dev`, `/deploy-functions eval`, or `/deploy-functions prod`. If not provided, ask which environment.

- `dev` → env file: `.env.cloud.dev`, project ref: `avkfgzsvgxrphythxnnx`
- `eval` → env file: `.env.cloud.eval`, project ref: `desbcemtpzwiwjxjqpxp`
- `prod` → env file: `.env.cloud`, project ref: `qglupzfoirojslnnxakb`

## Steps

### 1. Source environment variables and deploy

Always pass `--project-ref` explicitly to target the correct project. Do NOT rely on the linked project.

```bash
set -a && source <env-file> && set +a && npx supabase functions deploy --workdir deployment/ --no-verify-jwt --project-ref <project-ref>
```

### 2. Verify

Confirm the output shows all functions deployed to the correct project ref. Report any errors to the user.

## Important notes

- This deploys ALL edge functions in `deployment/supabase/functions/`.
- The `--no-verify-jwt` flag disables JWT verification on deployed functions.
- Always use `--project-ref` to avoid deploying to the wrong project. Never rely on the linked project.
