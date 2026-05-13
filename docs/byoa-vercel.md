# BYOA: Vercel Function Reference

> Reference implementation only. The proper template repo (with `vercel.json`, `package.json`, "Deploy to Vercel" button, etc.) ships later — this doc exists so we have a concrete code reference for the operator-hosted wake forwarder pattern described in [byoa.md](byoa.md#how-wake-works).

## What this function does

When wake_agent POSTs a wake to the operator's URL, this function:

1. **Authenticates** the inbound request against `BYOA_WAKE_SECRET` — the **per-ship** bearer the operator stored against their ship via `ship_byoa_configure set { wake_secret }` and also pasted into this Vercel project's env. wake_agent fetches the decrypted per-ship value from `ship_instances.byoa_wake_secret_enc` at dispatch time and signs the POST with it.
2. **Reads operator config** from its own `process.env` — which is the operator's Vercel project env, automatically inherited by Vercel Functions. This is where `TASK_LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `BYOA_PROMPT`, etc. live.
3. **Merges operator config + per-session wake bits** into the env blob the sandbox will see.
4. **Calls `Sandbox.create()`** on the operator's Vercel project (auth is automatic when running on Vercel via `VERCEL_OIDC_TOKEN`), points the sandbox at the BYOA runtime tarball, and runs `uv run byoa` detached.
5. **Returns 202 with the sandbox ID** so wake_agent can log it.

Everything operator-private stays on the operator's Vercel project. Our wake_agent never sees their keys.

## Example function — `app/api/wake/route.ts` (Next.js App Router)

```typescript
import { Sandbox } from '@vercel/sandbox';

// Pin to the gradient-bang BYOA runtime tarball this function will fetch.
// Override per-deploy via VERCEL project env if you've forked the runtime.
const DEFAULT_TARBALL_URL =
  'https://github.com/<your-org>/gradient-bang/releases/latest/download/byoa-runtime.tar.gz';

// Keys to forward from operator's project env into the sandbox. Allowlist
// (not denylist) so unrelated Vercel system vars don't leak in.
const OPERATOR_ENV_KEYS = [
  'BYOA_PROMPT',
  'BYOA_PROMPT_FILE',
  'TASK_LLM_PROVIDER',
  'TASK_LLM_MODEL',
  'TASK_LLM_THINKING_BUDGET',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MINIMAX_API_KEY',
  'BYOA_TOOL_CALL_TIMEOUT_SECONDS',
  'BYOA_AGENT_IDLE_TEARDOWN_SECONDS',
] as const;

function pickOperatorEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OPERATOR_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length > 0) out[key] = value;
  }
  return out;
}

type WakePayload = {
  request_id?: string;
  ship_id: string;
  task_id: string;
  channel: string;
  env?: Record<string, string>;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(req: Request): Promise<Response> {
  // 1. Bearer auth — must match BYOA_WAKE_SECRET set on this Vercel project
  //    AND on wake_agent's edge-function env (game-server side).
  const wakeSecret = (process.env.BYOA_WAKE_SECRET ?? '').trim();
  if (!wakeSecret) {
    return json(500, { success: false, error: 'BYOA_WAKE_SECRET not configured' });
  }
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${wakeSecret}`) {
    return json(401, { success: false, error: 'unauthorized' });
  }

  // 2. Parse + validate wake payload.
  let payload: WakePayload;
  try {
    payload = await req.json();
  } catch (err) {
    return json(400, {
      success: false,
      error: 'invalid_json',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const { ship_id, task_id, channel, env: wakeEnv = {}, request_id } = payload;
  if (!ship_id || !task_id || !channel) {
    return json(400, { success: false, error: 'missing_required_fields' });
  }

  // 3. Build the sandbox env: operator config from project env first, then
  //    per-session bits from the wake POST. Wake bits win on overlap.
  const sandboxEnv: Record<string, string> = {
    ...pickOperatorEnv(),
    ...wakeEnv,
  };

  // 4. Create the sandbox + kick off the harness detached.
  const tarballUrl = process.env.BYOA_RUNTIME_TARBALL_URL ?? DEFAULT_TARBALL_URL;
  try {
    const sandbox = await Sandbox.create({
      source: { type: 'tarball', url: tarballUrl },
      runtime: 'python3.13',
      env: sandboxEnv,
      timeout: 30 * 60 * 1000, // 30 min — leave headroom for long tasks
    });

    // Install deps once, then run the harness in the background.
    await sandbox.runCommand('uv', ['sync', '--no-dev']);
    await sandbox.runCommand({
      cmd: 'uv',
      args: ['run', 'byoa'],
      detached: true,
    });

    return json(202, {
      success: true,
      status: 'accepted',
      sandbox_id: sandbox.sandboxId,
      task_id,
      request_id: request_id ?? null,
    });
  } catch (err) {
    return json(500, {
      success: false,
      error: 'sandbox_create_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
```

## Required project env on the operator's Vercel project

| Key | Required | What it does |
|---|---|---|
| `BYOA_WAKE_SECRET` | yes | The per-ship bearer. Generate fresh (`openssl rand -hex 32`); set this value here AND send the same value to us via `ship_byoa_configure set { wake_secret }`. Per-ship (not shared across operators) so a leak only compromises that one ship. |
| `TASK_LLM_PROVIDER` | yes (one of) | `google` / `anthropic` / `openai` / `minimax`. |
| `TASK_LLM_MODEL` | yes | Provider-specific model id. |
| `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MINIMAX_API_KEY` | yes (matching `TASK_LLM_PROVIDER`) | The operator's own LLM credential. Never leaves their Vercel project. |
| `BYOA_PROMPT` | optional | Inline operator prompt (≤ 8 KB). Wins over `BYOA_PROMPT_FILE`. |
| `BYOA_PROMPT_FILE` | optional | Path inside the tarball, e.g. `./prompt.md` if you baked one in. |
| `TASK_LLM_THINKING_BUDGET` | optional | Default `4096`. |
| `BYOA_TOOL_CALL_TIMEOUT_SECONDS` | optional | Default `30.0`. |
| `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` | optional | Default `300.0`. |
| `BYOA_RUNTIME_TARBALL_URL` | optional | Override the runtime tarball URL (Mode B / eject). Defaults to whatever `DEFAULT_TARBALL_URL` is hardcoded above. |

Vercel auth (`VERCEL_OIDC_TOKEN`) is automatic when the function runs on Vercel — no extra env needed for the SDK.

## What the operator does, end-to-end

1. Click "Deploy to Vercel" on the future template repo. (For now: manually create a Next.js project, drop this file in `app/api/wake/route.ts`, `npm i @vercel/sandbox`, deploy.)
2. Generate a per-ship wake bearer: `openssl rand -hex 32`. You'll use this value twice in the next two steps.
3. Set the required project env above via the Vercel dashboard or `vercel env add` — including `BYOA_WAKE_SECRET` set to the value from step 2.
4. Note the deployment URL: `https://<their-project>.vercel.app/api/wake`.
5. Run `/byoa-setup prod` to claim a ship and mint a BYOA token.
6. Point the ship at the function and hand us the same bearer:
   ```bash
   curl -X POST "$SUPABASE_URL/functions/v1/ship_byoa_configure" \
     -H "Authorization: Bearer $ANON_KEY" \
     -H "X-API-Token: $YOUR_USER_JWT" \
     -d '{
       "character_id": "<your character UUID>",
       "ship_id": "<corp ship UUID>",
       "action": "set",
       "source_url": "https://<their-project>.vercel.app/api/wake",
       "wake_secret": "<value from step 2>"
     }'
   ```
   We encrypt the bearer at rest with `byoa_operator_secret()` (pgcrypto); it never appears in any client-readable column or response.
7. Start a task through the bot. wake_agent decrypts the per-ship bearer, POSTs to your function with `Authorization: Bearer <bearer>`; your function spawns the sandbox.

## What's missing from this reference (deferred to the template repo)

- `package.json` with `@vercel/sandbox` pinned, `next` (or framework of choice), build scripts.
- `vercel.json` for routing / function config if non-default.
- A `prompt.md` baked into the runtime (or a deploy step that pushes the operator's prompt to project env as `BYOA_PROMPT`).
- "Deploy to Vercel" button URL with the right `env=` query string to prompt the operator for required vars.
- Logging / observability beyond the bare 202.
- A retry / cancellation story for sandbox-create failures.
- Tests.

These all land in `gradient-bang-byoa-template` when we build it.
