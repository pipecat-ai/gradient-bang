---
name: maintenance
description: Toggle the server-side login killswitch on a Supabase environment. Usage `/maintenance <env> <on|off>` (e.g. `/maintenance prod on`). Sets or unsets the `MAINTENANCE_MODE` secret on the login edge function, which short-circuits new logins with HTTP 503 when enabled. Existing sessions keep working.
---

# Maintenance Mode

Toggle the `MAINTENANCE_MODE` secret on a Supabase project's edge functions. When enabled, the `login` edge function returns HTTP 503 before any rate-limiting or DB work, blocking all new sign-ins.

## Parameters

`/maintenance <env> <on|off>` — both arguments required. If either is missing, ask.

| env    | project ref            | project name |
|--------|------------------------|--------------|
| `prod` | `qglupzfoirojslnnxakb` | GB Prod      |
| `dev`  | `avkfgzsvgxrphythxnnx` | (dev)        |

## Steps

### 1. Confirm intent for `prod on`

If the user is turning maintenance **on** for **prod**, briefly state what will happen (all new logins blocked) and ask the user to confirm before running the command. For `prod off` or any `dev` action, proceed without confirmation.

### 2. Run the toggle

`on`:
```bash
npx supabase --workdir deployment secrets set MAINTENANCE_MODE=1 --project-ref <ref>
```

`off`:
```bash
npx supabase --workdir deployment secrets unset MAINTENANCE_MODE --project-ref <ref>
```

Secrets are read at runtime via `Deno.env.get()` in [deployment/supabase/functions/login/index.ts](deployment/supabase/functions/login/index.ts) — no redeploy needed.

### 3. Verify

```bash
npx supabase --workdir deployment secrets list --project-ref <ref> | grep MAINTENANCE_MODE
```

Report the final state to the user (on/off).

## Optional message

If the user supplies a custom message (e.g. `/maintenance prod on "back in 10 min"`), also set:
```bash
npx supabase --workdir deployment secrets set MAINTENANCE_MESSAGE="<message>" --project-ref <ref>
```

When turning off, also unset `MAINTENANCE_MESSAGE` **only if it's currently set** (unsetting a non-existent secret errors):
```bash
npx supabase --workdir deployment secrets list --project-ref <ref> | grep -q MAINTENANCE_MESSAGE && npx supabase --workdir deployment secrets unset MAINTENANCE_MESSAGE --project-ref <ref>
```

## Notes

- Always pass `--project-ref` explicitly; never rely on a linked project.
- This only controls the **server-side login killswitch**. The client-side `VITE_MAINTENANCE_MODE` flag in Vercel is separate, requires a rebuild to take effect, and hides the entire app (not just login). Don't touch it from this skill.
