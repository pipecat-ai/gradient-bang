# Eval

Voice agent evaluation using [Cekura](https://cekura.com).

## Overview

Cekura runs automated voice calls against the bot, simulating player interactions (e.g. navigating, trading, combat). After each call, Cekura sends a webhook event to our server so we can react to results — reset game state, log outcomes, etc.

The flow:

1. **Seed** the database with eval-specific characters (known starting states)
2. **Run evals** on Cekura — each eval calls the bot as a specific character
3. **Webhook fires** — Cekura POSTs `result.completed` to our webhook server
4. **Re-seed** the character to reset game state for the next run

## Directory structure

```
tests/eval/
├── README.md
└── webhook_server/
    ├── seed_eval_characters.sql       # Master seed (psql, includes all below)
    └── seeds/                         # Per-character SQL seed scripts (source of truth)
        ├── _shared_players.sql
        ├── alpha_sparrow.sql
        ├── beta_kestrel.sql
        ├── gamma_explorer.sql
        ├── delta_fleet.sql
        ├── epsilon_corp.sql
        ├── phi_trader.sql
        └── orion_vale.sql

deployment/supabase/functions/
└── eval_webhook/
    ├── index.ts                       # Edge function (Cekura webhook + seed-all)
    └── seeds/                         # Generated .ts files (from SQL sources above)
        ├── registry.ts
        ├── _shared_players.ts
        ├── ...
        └── orion_vale.ts

scripts/
└── sync-eval-seeds.sh                 # Regenerates .ts seeds from .sql sources
```

## Edge function (`eval_webhook`)

Supabase edge function that handles Cekura webhook events and eval database seeding. Replaces the previous Python/FastAPI webhook server.

### Production safety

The function is **disabled by default**. It requires `EVAL_WEBHOOK_ENABLED=true` to respond to any request. If the env var is missing or set to anything else, all requests return 403. This means the function is inert on production even if accidentally deployed.

### Routes

All requests are `POST` to the `eval_webhook` function endpoint.

| Payload | Auth | Description |
|---------|------|-------------|
| `{ "healthcheck": true }` | `X-API-Token` header | Health check |
| `{ "action": "seed_all" }` | `X-API-Token` header | Seed all eval characters |
| `{ "event_type": "result.completed", ... }` | `X-CEKURA-SECRET` header | Cekura webhook — resets one character family |

### Environment variables

Set in `.env.supabase` (local dev) or as Supabase secrets (deployed):

- `EVAL_WEBHOOK_ENABLED` — must be `"true"` for the function to respond (fail-closed guard)
- `CEKURA_WEBHOOK_SECRET` — shared secret for authenticating Cekura webhook requests

These are already configured for all edge functions and do not need to be set separately:

- `POSTGRES_POOLER_URL` — Postgres connection (used to execute seed SQL)
- `EDGE_API_TOKEN` — API token for `healthcheck` and `seed_all` auth

### Deploy

Deployed alongside all other edge functions:

```bash
npx supabase functions deploy --workdir deployment/ --no-verify-jwt
```

Set the Cekura webhook URL to:

```
https://<project-ref>.supabase.co/functions/v1/eval_webhook
```

### Syncing SQL seeds

The `.sql` files in `tests/eval/webhook_server/seeds/` are the source of truth. The edge function uses generated `.ts` copies (since edge functions have no filesystem). After editing any SQL seed, regenerate the TypeScript files:

```bash
bash scripts/sync-eval-seeds.sh
```

### Local dev

Seed all eval characters via the edge function:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/eval_webhook \
  -H "Content-Type: application/json" \
  -H "X-API-Token: $EDGE_API_TOKEN" \
  -d '{"action": "seed_all"}'
```

Or seed directly via psql (no edge function needed):

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seed_eval_characters.sql
```

## SQL seed scripts

Each eval character has a deterministic starting state (ship type, credits, map knowledge, etc.) so evals produce repeatable results. The seed scripts create these characters and can be re-run to reset them to their starting state — every script tears down existing data before re-inserting.

### Characters

| Character            | Ship(s)                            | Notes                                    | Cekura Agent                  | Character ID                         | User                  |
|----------------------|------------------------------------|------------------------------------------|-------------------------------|--------------------------------------|-----------------------|
| Alpha Sparrow Eval   | sparrow_scout                      | Fresh starter character                  | gb-bot-eval-sparrow-scout     | a0000000-0000-4000-8000-000000000001 | eval@gradientbang.com |
| Beta Kestrel Eval    | kestrel_courier                    | 10k ship credits, 5k megabank            | gb-bot-eval-kestrel-courier   | b0000000-0000-4000-8000-000000000002 | eval@gradientbang.com |
| Gamma Explorer Eval  | parhelion_seeker                   | 40 sectors visited, well-explored map    | gb-bot-eval-gamma-explorer    | c0000000-0000-4000-8000-000000000003 | eval@gradientbang.com |
| Delta Fleet Eval     | wayfarer_freighter, corsair_raider, kestrel_courier | Multi-ship owner, 50k megabank | gb-bot-eval-delta-fleet | d0000000-0000-4000-8000-000000000004 | eval@gradientbang.com |
| Epsilon Corp Eval    | sparrow_scout + corp pike_frigate  | Corporation member with corp-owned ship  | gb-bot-eval-epsilon-corp      | e0000000-0000-4000-8000-000000000005 | eval@gradientbang.com |
| Phi Trader Eval      | kestrel_courier + corp wayfarer_freighter + corp autonomous_light_hauler | Corp founder with personal + 2 corp ships, credit transfer evals | gb-bot-eval | f0000000-0000-4000-8000-000000000006 | eval2@gradientbang.com |
| Orion Vale Eval      | kestrel_courier + 2 corp ships     | Voice-agent-full world: peers (Starfall, Drifter NPC, Nova Prime, Moonshadow), 2 corps, mega-port at sector 305 | gb-bot-eval-orion-vale | 1a000000-0000-4000-8000-000000000001 | orion-eval@gradientbang.com |

NPC characters (e.g. Drifter in the Orion Vale world) are not linked to any eval user.

### Auth users

The `enforce_user_character_limit` trigger caps each user at 5 characters, so
eval characters are spread across multiple auth users. Base users (holding
slots 0..4) are provisioned via migration
[`20260420000000_add_eval_users.sql`](../../deployment/supabase/migrations/20260420000000_add_eval_users.sql);
slot-5+ overflow users are created inline by the per-character seed scripts.

| User                                 | Email                                | Characters                                                   | Created by                                                                                          |
|--------------------------------------|--------------------------------------|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| a0000000-0000-4aaa-8000-000000000001 | alpha-eval-base@gradientbang.com     | Alpha Sparrow Eval0..4                                       | migration 20260420000000                                                                            |
| b0000000-0000-4aaa-8000-000000000002 | beta-eval-base@gradientbang.com      | Beta Kestrel Eval0..4                                        | migration 20260420000000                                                                            |
| c0000000-0000-4aaa-8000-000000000003 | gamma-eval-base@gradientbang.com     | Gamma Explorer Eval0..4                                      | migration 20260420000000                                                                            |
| d0000000-0000-4aaa-8000-000000000004 | delta-eval-base@gradientbang.com     | Delta Fleet Eval0..4                                         | migration 20260420000000                                                                            |
| e0000000-0000-4aaa-8000-000000000005 | epsilon-eval-base@gradientbang.com   | Epsilon Corp Eval0..4                                        | migration 20260420000000                                                                            |
| cf73d883-41fd-4fc5-ba5d-b82241d26ca7 | eval2@gradientbang.com               | Phi Trader Eval0..4                                          | pre-existing                                                                                        |
| a0000000-5000-4aaa-8000-000000000001 | alpha-eval-5@gradientbang.com        | Alpha Sparrow Eval5                                          | [seeds/alpha_sparrow.sql](webhook_server/seeds/alpha_sparrow.sql)                                   |
| a0000000-6000-4aaa-8000-000000000001 | alpha-eval-6@gradientbang.com        | Alpha Sparrow Eval6                                          | [seeds/alpha_sparrow.sql](webhook_server/seeds/alpha_sparrow.sql)                                   |
| a0000000-7000-4aaa-8000-000000000001 | alpha-eval-7@gradientbang.com        | Alpha Sparrow Eval7                                          | [seeds/alpha_sparrow.sql](webhook_server/seeds/alpha_sparrow.sql)                                   |
| a0000000-8000-4aaa-8000-000000000001 | alpha-eval-8@gradientbang.com        | Alpha Sparrow Eval8                                          | [seeds/alpha_sparrow.sql](webhook_server/seeds/alpha_sparrow.sql)                                   |
| b0000000-5000-4aaa-8000-000000000002 | beta-eval-5@gradientbang.com         | Beta Kestrel Eval5                                           | [seeds/beta_kestrel.sql](webhook_server/seeds/beta_kestrel.sql)                                     |
| b0000000-6000-4aaa-8000-000000000002 | beta-eval-6@gradientbang.com         | Beta Kestrel Eval6                                           | [seeds/beta_kestrel.sql](webhook_server/seeds/beta_kestrel.sql)                                     |
| b0000000-7000-4aaa-8000-000000000002 | beta-eval-7@gradientbang.com         | Beta Kestrel Eval7                                           | [seeds/beta_kestrel.sql](webhook_server/seeds/beta_kestrel.sql)                                     |
| b0000000-8000-4aaa-8000-000000000002 | beta-eval-8@gradientbang.com         | Beta Kestrel Eval8                                           | [seeds/beta_kestrel.sql](webhook_server/seeds/beta_kestrel.sql)                                     |
| b0000000-9000-4aaa-8000-000000000002 | beta-eval-9@gradientbang.com         | Beta Kestrel Eval9                                           | [seeds/beta_kestrel.sql](webhook_server/seeds/beta_kestrel.sql)                                     |
| b0000000-a000-4aaa-8000-000000000002 | beta-eval-10@gradientbang.com        | Beta Kestrel Eval10                                          | [seeds/beta_kestrel.sql](webhook_server/seeds/beta_kestrel.sql)                                     |
| c0000000-5000-4aaa-8000-000000000003 | gamma-eval-5@gradientbang.com        | Gamma Explorer Eval5                                         | [seeds/gamma_explorer.sql](webhook_server/seeds/gamma_explorer.sql)                                 |
| c0000000-6000-4aaa-8000-000000000003 | gamma-eval-6@gradientbang.com        | Gamma Explorer Eval6                                         | [seeds/gamma_explorer.sql](webhook_server/seeds/gamma_explorer.sql)                                 |
| c0000000-7000-4aaa-8000-000000000003 | gamma-eval-7@gradientbang.com        | Gamma Explorer Eval7                                         | [seeds/gamma_explorer.sql](webhook_server/seeds/gamma_explorer.sql)                                 |
| c0000000-8000-4aaa-8000-000000000003 | gamma-eval-8@gradientbang.com        | Gamma Explorer Eval8                                         | [seeds/gamma_explorer.sql](webhook_server/seeds/gamma_explorer.sql)                                 |
| c0000000-9000-4aaa-8000-000000000003 | gamma-eval-9@gradientbang.com        | Gamma Explorer Eval9                                         | [seeds/gamma_explorer.sql](webhook_server/seeds/gamma_explorer.sql)                                 |
| c0000000-a000-4aaa-8000-000000000003 | gamma-eval-10@gradientbang.com       | Gamma Explorer Eval10                                        | [seeds/gamma_explorer.sql](webhook_server/seeds/gamma_explorer.sql)                                 |
| d0000000-5000-4aaa-8000-000000000004 | delta-eval-5@gradientbang.com        | Delta Fleet Eval5                                            | [seeds/delta_fleet.sql](webhook_server/seeds/delta_fleet.sql)                                       |
| d0000000-6000-4aaa-8000-000000000004 | delta-eval-6@gradientbang.com        | Delta Fleet Eval6                                            | [seeds/delta_fleet.sql](webhook_server/seeds/delta_fleet.sql)                                       |
| e0000000-5000-4aaa-8000-000000000005 | epsilon-eval-5@gradientbang.com      | Epsilon Corp Eval5                                           | [seeds/epsilon_corp.sql](webhook_server/seeds/epsilon_corp.sql)                                     |
| e0000000-6000-4aaa-8000-000000000005 | epsilon-eval-6@gradientbang.com      | Epsilon Corp Eval6                                           | [seeds/epsilon_corp.sql](webhook_server/seeds/epsilon_corp.sql)                                     |
| f0000000-5000-4aaa-8000-000000000006 | phi-eval-5@gradientbang.com          | Phi Trader Eval5                                             | [seeds/phi_trader.sql](webhook_server/seeds/phi_trader.sql)                                         |
| f0000000-6000-4aaa-8000-000000000006 | phi-eval-6@gradientbang.com          | Phi Trader Eval6                                             | [seeds/phi_trader.sql](webhook_server/seeds/phi_trader.sql)                                         |
| 1a000000-1a00-4aaa-8000-000000000001 | orion-eval@gradientbang.com          | Orion Vale Eval (slot 001) + clones 001, 003, 004           | [seeds/orion_vale.sql](webhook_server/seeds/orion_vale.sql)                                         |
| 1a000000-1a00-4aaa-8000-0000000000NN | orion-eval-NN@gradientbang.com       | Orion Vale clones 002..016 (one user per clone, NN = slot)  | [seeds/orion_vale.sql](webhook_server/seeds/orion_vale.sql)                                         |
| 352373e1-aa29-49c7-b929-2cba86ca4a3c | eval@gradientbang.com                | (none after 2026-04-20 — was the old shared eval user)       | pre-existing                                                                                        |

### Orion Vale — voice-agent-full eval world

[seeds/orion_vale.sql](webhook_server/seeds/orion_vale.sql) seeds a richer ecosystem than the other per-character scripts because its 21 Cekura scenarios exercise rules that require props: a hostile NPC in the commander's sector, a second corporation with its own founder, an extra corp member to kick, and a peer player to reference. Everything is owned by the `1a*` UUID namespace (Orion Vale's own hex-valid namespace, reserved entirely for this seed). Future multi-character eval worlds should claim `1b*`, `1c*`, etc.

Cekura agent slug: `gb-bot-eval-orion-vale` (webhook routing relies on this exact prefix).

### Usage

Seed **all** eval characters via the edge function:

```bash
curl -X POST http://127.0.0.1:54321/functions/v1/eval_webhook \
  -H "Content-Type: application/json" \
  -H "X-API-Token: $EDGE_API_TOKEN" \
  -d '{"action": "seed_all"}'
```

Or directly via psql:

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seed_eval_characters.sql
```

Reset a **single** character back to its starting state (via psql):

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seeds/alpha_sparrow.sql
```

The per-character scripts are useful after an eval run mutates game state — re-run the relevant seed to reset that character without touching the others.
