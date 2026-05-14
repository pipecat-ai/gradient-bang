# BYOA: Bring Your Own Agent

BYOA lets an operator claim a corporation ship and run their own task agent for it.

The normal path is skill-driven:

- Local development: run `/byoa-link local`, start the local wake daemon, then trigger a task in the bot.
- Vercel: run `/byoa-link prod`, then `/byoa-deploy-vercel prod`. See [BYOA on Vercel](byoa-vercel.md).
- Custom agents: start with the same skills, then replace the prompt, wake function, or harness wiring only when needed.

## How it works

The game wakes an agent by sending an HTTP POST to a URL owned by the operator.

- Local dev: the URL points at `uv run byoa --serve` on your machine.
- Vercel: the URL points at your Vercel wake function.
- In both cases, the receiver starts `uv run byoa` with the task session env.

Operator secrets stay operator-side:

- Local secrets live in `.env.byoa`.
- Vercel secrets live in the operator's Vercel project env.
- The game stores only the ship claim, wake URL, and per-ship wake secret.

## Skills

| Skill | Use it for | Result |
|---|---|---|
| `/byoa-link local` | Local BYOA onboarding | Claims a ship, generates a wake secret, writes `.env.byoa`, and registers the wake secret. |
| `/byoa-link prod` | Production BYOA onboarding | Claims a ship, generates a wake secret, and prepares `.env.byoa` for deployment. |
| `/byoa-deploy-vercel prod` | Vercel deployment | Pushes env, deploys the wake function, health-checks it, and registers the wake URL. |
| `/byoa-link <env> --force` | Secret rotation or re-onboarding | Rewrites `.env.byoa` and updates the server-side wake secret. |
| `/byoa-unlink <env>` | Release a claimed ship | Calls `ship_byoa_configure { action: "clear" }` — nulls owner server-side, frees the ship for someone else to claim. Owner-only, idempotent. Operator-side infra (Vercel deploy, local daemon, `.env.byoa`) is left alone unless `--clear-env` is passed. |

## Local Quickstart

Prereqs:

- Local Supabase is running: `npx supabase start --workdir deployment`.
- Migrations and seed state are applied: `scripts/reset-world.sh`.
- You have a game account with a character in a corporation that owns a ship.

Setup:

- Run `/byoa-link local`.
- Follow the prompts to log in and choose a corporation ship.
- Let the skill write `.env.byoa`; it also registers the ship wake secret server-side.
- Add your LLM settings to `.env.byoa`:
  - `TASK_LLM_PROVIDER`
  - `TASK_LLM_MODEL`
  - The matching provider key, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
- Optional: create `prompt.md` and set `BYOA_PROMPT_FILE=./prompt.md`.

Run locally:

- Start the bot:

```bash
set -a && source .env.supabase && set +a
uv run bot --host 0.0.0.0
```

- In another terminal, start the BYOA wake daemon:

```bash
uv run byoa --serve
```

- Trigger a task on the claimed ship from the bot UI.
- Watch the daemon logs for the wake and spawned `uv run byoa` session.

Rotate local credentials:

- Run `/byoa-link local --force`.
- Restart `uv run byoa --serve` so it reads the updated `.env.byoa`.

## Prompting

Start by changing the prompt, not the harness.

Use either:

- `BYOA_PROMPT=...` for a short inline prompt.
- `BYOA_PROMPT_FILE=./prompt.md` for a markdown prompt file.

The prompt is appended to the base task-agent instructions. Keep it short and behavioral:

```markdown
Prefer profitable trade routes over combat.
If attacked, flee unless the enemy is already badly damaged.
Avoid spending fuel unless the route improves expected profit.
```

## Vercel

Production BYOA runs through the Vercel wake receiver in [deployment/vercel](../deployment/vercel/).

Use [BYOA on Vercel](byoa-vercel.md) for the quickstart. The short version is:

- Run `/byoa-link prod`.
- Fill in the LLM settings in `.env.byoa`.
- Link `deployment/vercel/` to a Vercel project once with `npx vercel link`.
- Run `/byoa-deploy-vercel prod`.
- Trigger a task in the bot.

## Customization

Prefer this order:

1. Prompt changes via `BYOA_PROMPT` or `BYOA_PROMPT_FILE`.
2. Vercel wake-function changes in [deployment/vercel/api/wake.ts](../deployment/vercel/api/wake.ts).
3. Harness hooks through `gradientbang.byoa.ByoaApp`; start from [byoa-example.py](byoa-example.py).
4. A fully custom runner using the TaskAgent and bus building blocks.

For most operators, the first two are enough. Eject from the default harness only when you need custom model routing, external memory, metrics, or non-standard task behavior.

## Useful Notes

- One ship can be claimed by one BYOA owner at a time.
- BYOA ships can only be issued tasks by their BYOA owner.
- A corp member can still force-cancel a running task.
- The wake secret is per ship; rotating it only affects that ship.
- Preview Vercel URLs are usually protected by Vercel SSO. Use the production alias for BYOA.
