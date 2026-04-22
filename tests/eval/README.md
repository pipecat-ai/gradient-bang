# Eval

Voice agent evaluation using [Cekura](https://cekura.com).

## Overview

Cekura runs automated voice calls against the bot, simulating player interactions (e.g. navigating, trading, combat). Each evaluator runs as a specific eval character with a deterministic starting state, so results are repeatable.

The flow:

1. **Seed** the database with eval-specific characters (known starting states)
2. **Run evals** on Cekura — each eval calls the bot as a specific character
3. **Re-seed** the affected character(s) between runs to reset game state

## Directory structure

```
tests/eval/
├── README.md
├── EVALUATORS.md                    # Auto-generated evaluator catalog
├── generate_evaluators_md.py        # Regenerates EVALUATORS.md from Cekura
└── webhook_server/
    ├── seed_add_eval_users.sql      # Auth users (run first, idempotent)
    ├── seed_eval_characters.sql     # Master seed (includes all below)
    └── seeds/                       # Per-character SQL seed scripts
        ├── _shared_players.sql
        ├── alpha_sparrow.sql
        ├── beta_kestrel.sql
        ├── gamma_explorer.sql
        ├── delta_fleet.sql
        ├── epsilon_corp.sql
        ├── phi_trader.sql
        └── orion_vale.sql
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
slots 0..4) are provisioned via
[`seed_add_eval_users.sql`](webhook_server/seed_add_eval_users.sql); slot-5+
overflow users are created inline by the per-character seed scripts.

| User                                 | Email                                | Characters                                                   | Created by                                                                                          |
|--------------------------------------|--------------------------------------|--------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| a0000000-0000-4aaa-8000-000000000001 | alpha-eval-base@gradientbang.com     | Alpha Sparrow Eval0..4                                       | [seed_add_eval_users.sql](webhook_server/seed_add_eval_users.sql)                                   |
| b0000000-0000-4aaa-8000-000000000002 | beta-eval-base@gradientbang.com      | Beta Kestrel Eval0..4                                        | [seed_add_eval_users.sql](webhook_server/seed_add_eval_users.sql)                                   |
| c0000000-0000-4aaa-8000-000000000003 | gamma-eval-base@gradientbang.com     | Gamma Explorer Eval0..4                                      | [seed_add_eval_users.sql](webhook_server/seed_add_eval_users.sql)                                   |
| d0000000-0000-4aaa-8000-000000000004 | delta-eval-base@gradientbang.com     | Delta Fleet Eval0..4                                         | [seed_add_eval_users.sql](webhook_server/seed_add_eval_users.sql)                                   |
| e0000000-0000-4aaa-8000-000000000005 | epsilon-eval-base@gradientbang.com   | Epsilon Corp Eval0..4                                        | [seed_add_eval_users.sql](webhook_server/seed_add_eval_users.sql)                                   |
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

Cekura agent slug: `gb-bot-eval-orion-vale`.

### Usage

Seed the base auth users (first-time setup, idempotent):

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seed_add_eval_users.sql
```

Seed **all** eval characters:

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seed_eval_characters.sql
```

Reset a **single** character back to its starting state:

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seeds/alpha_sparrow.sql
```

The per-character scripts are useful after an eval run mutates game state — re-run the relevant seed to reset that character without touching the others.

## Evaluator catalog

[`EVALUATORS.md`](EVALUATORS.md) is an auto-generated catalog of every Cekura evaluator across the eval folders. Regenerate with:

```bash
python3 tests/eval/generate_evaluators_md.py
```

Requires `CEKURA_API_KEY` in the environment.
