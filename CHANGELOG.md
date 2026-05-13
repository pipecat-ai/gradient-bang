# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **BYOA (Bring-Your-Own-Agent)** — corp members can claim one of their corp ships as BYOA via `ship_byoa_configure`. BYOA ships are owner-only in this version: only the BYOA owner can start normal tasks on that ship. See [docs/setup-byoa.md](docs/setup-byoa.md) for the operator-facing guide
- BYOA crash detection via the existing `BusByoaPresenceMessage` (10s cadence). When presence goes stale (~30s) the bot clears its in-memory ship lock and emits `task.cancel` so downstream consumers see the task ended
- `TASK_AGENT_TIMEOUT` (bot env, default 1800s = 30 min) is now a load-bearing per-task hard upper bound. When it fires the bot cancels the task and clears its local ship lock. Bot-controlled — BYOA operators cannot override it
- `current_task_actor` and `byoa` blocks on `list_user_ships` and `corporation_info` ship-list payloads, with all character IDs truncated to 12 hex chars (full UUIDs never sent in these payloads)
- `ByoaAgentConfig` (Python) + `BYOA_*` env overrides for agent-side RPC timeouts and concurrency
- Typed bus protocol for in-process agent communication — every game RPC, lifecycle event, corp query, and combat doctrine fetch flows through typed messages (`BusGameToolCallRequest`/`Response`, `BusCombatStrategyRequest`/`Response`, `BusCorporationQueryRequest`/`Response`, `BusTaskFinishNotification`) to VoiceAgent's broker rather than direct `AsyncGameClient` calls. External BYOA agents will implement the same protocol
- Universal `BusAgentHelloRequest` / `BusAgentHelloResponse` wake-up handshake before any task dispatch. Times out per `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` (default 30s); generous enough to absorb a Vercel-Sandbox-class cold start for future remote BYOA agents
- Idle teardown timer for warm corp-ship / BYOA agents — fires `BusEndAgentMessage` to self after `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` (default 300s) of no activity. Player-ship agents are reused across tasks, so excluded
- Subagent bus is now transport-pluggable via `SUBAGENT_BUS_TRANSPORT` (`local` default, `pgmq` opt-in). Local branch keeps the in-process `AsyncQueueBus` bit-for-bit identical to prior behavior; PGMQ branch builds upstream `PgmqBus` over a Postgres DSN. New `make_subagent_bus()` factory in [src/gradientbang/adapters/bus/](src/gradientbang/adapters/bus/) mirrors the existing `EventAdapter` factory; `bot.py` calls it from `AgentRunner(bus=...)` instead of relying on the implicit default
- `SUBAGENT_BUS_DATABASE_URL` (Postgres DSN) and `SUBAGENT_BUS_CHANNEL` are **both required** when `SUBAGENT_BUS_TRANSPORT=pgmq`. Channel has no default — `PgmqBus` broadcasts on publish to every peer queue sharing the channel prefix, so a default would cross-talk bus traffic between concurrent bots sharing a database. Set a per-deployment value (e.g. `gb_prod`, `gb_dev_jon`). The bot derives a per-session channel from this prefix and passes that channel through `wake_agent` for BYOA
- `_OwnedPgmqBus` subclass of upstream `PgmqBus` closes the asyncpg pool on `stop()` — upstream is explicit the caller owns the `PGMQueue` lifetime, so the factory's bus wrapper takes responsibility for clean teardown
- Custom bus messages round-trip cleanly through upstream `JSONMessageSerializer` (12 sample messages covering the typed request/response pairs, `BusTaskFinishNotification`, `BusGameEventMessage`, `BusSteerTaskMessage`, and the hello handshake). Precondition for PGMQ — guards against silent field drops if a non-JSON-safe field ever lands on a bus message
- `pipecat-ai-subagents>=0.5.0` from PyPI with the `[pgmq]` extra (`pgmq` + `asyncpg`); the prior `vendor/pipecat-subagents` git submodule and `[tool.uv.sources]` override are removed
- **BYOA restricted PGMQ bus** — external BYOA runners connect to the bot's per-session channel through `byoa_bus_*` SECURITY DEFINER wrappers. Each wrapper validates `BYOA_TOKEN`, channel, and ship id before touching PGMQ, so BYOA uses the restricted `BYOA_BUS_DATABASE_URL` instead of the bot/service DSN
- `wake_agent` is no longer a stub — dispatches process wake based on `WAKE_TARGET` (`http`, `noop`, with `vercel_sandbox` reserved) and injects the same runtime payload for every target: `BYOA_CHANNEL`, `BYOA_SHIP_ID`, `BYOA_BUS_DATABASE_URL`, and task metadata
- BYOA CLI now supports the production-parity local wake flow: `uv run byoa serve --prompt-file ./prompt.md` starts an HTTP wake provider, and `wake_agent` calls it with `Authorization: Bearer $EDGE_API_TOKEN`. The daemon spawns `uv run byoa run` children with the injected channel and restricted bus DSN. Direct `uv run byoa run --channel ... --bus-database-url ...` remains an emergency/manual fallback
- BYOA runners emit process presence over the subagent bus. VoiceAgent relays `byoa.presence` to the client, and the client shows BYOA online/offline state only for ships with a BYOA owner
- BYOA cold starts emit `task_status: "waking"` on the existing `task.start` event. The client shows fuel-colored `Waking` badges until the first `task_output` for that task, then flips back to the normal active state

### Changed

- `record_event_with_recipients` now owns pubsub delivery from SQL, so SQL-only quest events reach pgmq without JS dual-writes
- **Ship-task lock returned to per-bot, in-memory** (`VoiceAgent._locked_ships`). The earlier DB-persistent design (lock columns on `ship_instances` + heartbeat RPC + 30-min hard TTL) caused stuck-lock symptoms when a BYOA died mid-task — heartbeats run in the bot process, so a dead BYOA paired with a live bot kept the DB lock refreshed until the hard TTL. The bot is now the only authority; the BYOA presence heartbeat is the crash signal
- `task_lifecycle event_type=start` no longer acquires a server-side lock — it just emits the `task.start` event. Still returns `403 byoa_private_not_owner` when a non-BYOA-owner tries to start a task on a private BYOA ship
- `task_cancel` no longer touches a DB lock — emits the `task.cancel` event. `force: true` still lets any corp member emit a cancel event for a BYOA ship when the owner is unreachable
- `fetchActiveTaskIdsByShip` and new sibling `fetchActiveTasksByShip` derive "active task per ship" from recent `task.start` events without a matching `task.finish`/`task.cancel` (60-minute window). Hint-only — the bot's in-memory map is authoritative
- VoiceAgent: removed the per-bot heartbeat loop and `_ensure_heartbeat_task_running`/`_stop_heartbeat_task`. `_acquire_server_ship_lock` (name retained for back-compat) is now a thin wrapper that emits `task.start` and surfaces BYOA-owner 403 cleanly
- VoiceAgent shutdown still emits `task.cancel` for each held lock (so downstream consumers see the lifecycle ended) and clears `_locked_ships`. No DB-side release call any more
- TaskAgent no longer emits `task.start` — VoiceAgent owns that, eliminating the double-emit race
- TaskAgent drops `AsyncGameClient` entirely; the per-corp-ship dedicated client construction is gone. VoiceAgent's single player-bound client services every TaskAgent via per-call identity overrides — one `AsyncGameClient` per bot process
- Brokered RPCs propagate `task_id` via a `ContextVar` (`per_call_task_id`) instead of mutating shared client state, so concurrent broker handlers can't cross-tag each other's events
- `BusTaskFinishNotification` carries `actor_character_id` and the broker forwards it to `task_lifecycle(finish)` so private BYOA ship finishes authorise against the player, not the pseudo-character
- Broker hardening: envelope `character_id` / `actor_character_id` are authoritative — `msg.args` can't shadow them

### Removed

- DB columns `current_task_id`, `task_started_at`, `task_actor_character_id`, `task_last_heartbeat_at`, `byoa_session_channel`, `byoa_session_allocated_at` on `ship_instances` and their indexes
- RPCs `acquire_ship_task_lock`, `release_ship_task_lock`, `force_release_ship_task_lock`, `refresh_ship_task_heartbeats`
- `task_heartbeat` edge function (deleted)
- `BYOA_HEARTBEAT_INTERVAL_SECONDS`, `TASK_LOCK_HEARTBEAT_STALE_SECONDS`, `TASK_LOCK_HARD_TTL_MINUTES`, `BYOA_SERVER_LOCK_STALE_SECONDS`, `BYOA_SERVER_LOCK_HARD_TTL_MINUTES` env vars
- `ByoaAgentConfig.heartbeat_interval_seconds`, `server_lock_stale_seconds_expected`, `server_lock_hard_ttl_minutes_expected`, `validate_heartbeat_against_server`
- `AsyncGameClient.task_heartbeat` method

## [0.4.1] - 2026-05-11

### Changed

- `EVENT_TRANSPORT` now defaults to `pubsub` (was `polling`). The polling adapter is still selectable via `EVENT_TRANSPORT=polling`. Edge-function test runner and CI no longer run both transports in parallel by default — only pubsub runs; pass `TRANSPORT=polling` to `run_tests.sh` for a polling-only regression pass.

## [0.4.0] - 2026-05-06

### Added

- Per-character authentication on every gameplay edge function: the caller's Supabase Auth JWT is verified server-side and `canActOnCharacter()` enforces direct ownership or corp-ship access via corp membership.
- Optional pgmq-backed event delivery (`EVENT_TRANSPORT=pubsub`) — long-polls per-character queues via auth-gated SQL functions, eliminating the busy-poll loop. Polling remains the default; both modes are wire-compatible. Broadcast events (chat, gm/system) fan out to pubsub subscribers via Postgres LISTEN/NOTIFY
- Admin-only credential path: `combat_tick`, `test_reset`, and `eval_webhook` now strictly require an admin token. `corporation_info`'s member-only payload is gated behind ownership — non-members get the public view

### Changed

- Bumped to Pipecat 1.0 (`pipecat-ai` 1.1.0, `pipecatcloud` 0.6.0). Replaced the in-repo subagents framework fork with the published `pipecat-ai-subagents` 0.4.0
- Bot edge function calls now require BOTH the user JWT (`X-API-Token`) and `EDGE_API_TOKEN` (new `X-Edge-Auth` header). A bare user JWT is rejected with `admin_token_required`. Auth contexts are now `admin` (X-Edge-Auth only), `bot` (both headers), and `byoa` (future, third-party agents)
- Bot's `/start` now requires a Supabase Auth `access_token` in the body so per-character credentials flow into pubsub and ownership checks; dev workflows can use `BOT_TEST_ACCESS_TOKEN`
- Supabase Auth JWT expiry bumped from 1h to 24h so a session covers any plausible gameplay length without a refresh path
- Local-dev admin bypass now requires explicit `ALLOW_AUTH_BYPASS_FOR_LOCAL_DEV=1` — closes a prod foot-gun where missing `EDGE_API_TOKEN` could silently grant admin context

## [0.3.0] - 2026-04-30

### Added

- Combat round outcomes are now persisted to `ship_instances` after every round, not just at end of combat — DB-sourced reads (`my_corporation`, `corporation_info`, `status.update`, voice/task tools) reflect live fighter and shield counts during a fight instead of pre-combat values
- Destroyed players exit combat immediately: escape-pod conversion, personalized `combat.ended`, and unblocked movement / trade / bank actions all happen the moment the ship dies — no more sitting through the rest of someone else's fight
- Destroyed corp ships clean up immediately when they die (pseudo-character + `corporation_ships` row removed mid-round) instead of waiting for the encounter to end
- Destroyed combatants stay in the participant list flagged `destruction_handled = true` so observers and the LLM see "destroyed in round N" persistently across the rest of the encounter, not a vague absence

### Changed

- Salvage from a ship destroyed mid-combat now drops to the sector only when combat ends — preventing in-fight loots and sector passers-by from collecting wrecks while the battle is still going
- `combat_action` rejects all actions from destroyed or escape-pod participants (was: only rejected `flee`); attacks on a destroyed target are rejected at submission with a clear error
- VoiceAgent task.completed narration is now driven by a generic deferred-update queue instead of a per-event blocking gate. Close-together completions batch into one announcement (settle window of 2s, capped at 8s); narrations defer politely around the user's turn (won't front-load ahead of an answer to a question, won't fire while the user is speaking); a same-ship follow-up command silently folds the prior arrival into context with no narration; and once the conversation has moved 5+ turns past, queued events are appended silently. Voice agent prompt also restricts task.completed reports to the ships in the most recent event block — no more volunteering stale status on still-in-flight ships
- Voice agent task.completed reports no longer include ship status (shields, warp, cargo, ports) — the "unless commander asks" caveat was never used in practice

### Fixed

- Bot audio volume slider now actually controls remote bot audio: a local `PipecatClientAudio` binds the media element's `volume` to the store's `remoteAudioVolume` setting (the default component from `@pipecat-ai/client-react` ignored it)
- Sector map edge feather is now applied after the zoomed scene render, so it fades the final composed viewport instead of being painted over by ships, course plot, and badges
- `corporation.data` events no longer leak into the voice agent's LLM context — every internal `my_corporation` RPC (start_task ship resolution, kick member resolution, client refreshes) was dumping the full corp roster, ship list, and destroyed-ship history into voice context. TaskAgents and the web UI still receive the event via the bus broadcast and realtime push; the voice agent gets corp info on demand via the `corporation_info` tool's summary

## [0.2.0] - 2026-04-28

### Added

- Ship combat strategies: per-ship doctrine (`balanced` / `offensive` / `defensive`) plus optional custom prompt; voice + UI tools to set/get/clear; auto-injected at round-1 combat
- Combat strategies panel for selecting doctrine and editing the custom prompt
- `garrison.destroyed` event with voice narration for the owner; silent context for corp and sector observers
- Per-viewer combat POV (DIRECT / corp-ship observer / garrison observer / sector-only) shapes both summary lines and XML envelope attrs on every encounter event
- Round-1 fan-out: combat-start broadcasts to all stakeholders (corp members, absent garrison owners, sector observers); rounds 2+ stay participant-only
- Successful flee now emits the full movement cascade to the fleer (`movement.start`, `character.moved` depart, `movement.complete`, `map.local`, `character.moved` arrive) plus a personalized `combat.ended` so the client unsticks from combat state immediately, even when the fight continues for the others
- `has_fled` / `fled_to_sector` fields on participants in combat round payloads — distinguishes fled combatants from destroyed ones
- Standalone combat sim client for offline strategy experimentation
- Map marker for a destroyed garrison is cleared and logged to the activity feed
- Per-garrison fighter cap of 32,000; deploys that would exceed are rejected with a clear `max additional = N` error
- Client: BigMap panel shows sectors with active combat

### Changed

- Combat event payloads: participants gain `fighters` / `destroyed` / `corp_id`; garrison gains `owner_character_id` / `owner_corp_id`
- `ship.destroyed`: adds `owner_character_id` / `corp_id`; inference flips `NEVER → OWNED` so voice narrates the loss for the owner
- Toll garrisons are now per-payer: paying a toll is a peace contract scoped to that payer ↔ that garrison. Other hostiles must still pay (no free rides), paid payers cannot attack the garrison or re-pay it, and the garrison re-targets to unpaid hostiles on escalation rounds. Combat ends `toll_satisfied` only when every hostile has paid and nobody is attacking
- Combat reference prompt rewritten around the four POVs and the new payload fields
- Voice combat announcements widened to cover observed combats, not just direct participation

### Fixed

- `combat.round_resolved` reports post-round fighter counts correctly (was reading the participant snapshot before losses applied)
- A successful fleer is now moved out of the encounter every round, not only when combat happens to end the same round — previously a fleer who left mid-fight had their ship row stay in the combat sector until the rest of combat resolved
- Combat XML envelope attrs are escaped before being sent to the LLM — a ship name with quotes or angle brackets can no longer corrupt the event frame

## [0.1.5] - 2026-04-22

### Added

- Multilingual voice support: select a voice/language in settings and the entire pipeline adapts — STT recognition, TTS synthesis, and LLM responses switch to the chosen language
- Supported languages: English, Spanish, French, Hindi, Portuguese, Turkish
- Runtime language switching: change language mid-session without reconnecting
- Quest voice changer gracefully skips voice swap for non-English languages, keeping the active voice

## [0.1.4] - 2026-04-21

### Fixed

- Batch tool call inference: when the LLM issues multiple tool calls in one response, only trigger a single inference after the last tool completes instead of one per tool
- Corp ship task completions now include ship_name in the event XML so the voice agent can distinguish which ship finished

## [0.1.3] - 2026-04-20

### Added

- Corporations: two-word invite passphrases (e.g. `nebula-drift`) with collision retry
- Corporations: two-step confirmation flow for joining and for kicking members, with client modals
- Corporations: details modal accessible from the top bar — roster, fleet size, and (founder-only) invite passphrase with copy/regenerate
- Corporations: join notifications for the joiner and existing members, with the voice agent learning about new members immediately
- Corporations: auto-leave when joining a different corp (silent if not last member; confirm-pending if last; refused if the corp still owns ships)
- Voice agent: `join_corporation` and `kick_corporation_member` tools (previously TaskAgent-only)
- Dev-only `VITE_BOT_URL` to point the client at a local bot while using prod Supabase

### Changed

- Corporations: details modal restyled (elbow card, data table for members)
- Corporations: invite regenerate uses reactive spinner (clears when new code arrives, no timeout)
- Corporations: corp-scoped event polling now works reliably from first connection
- Corporations: only the founder can kick, view the invite code, or regenerate it
- Corporations: invite codes accept spaces and underscores as dashes (so speech input like "nebula cortex" works)
- Corporations: tasks are actor-private — corpmates no longer see each other's task events
- Corporations: credit transfers to a corp ship now refresh every corpmate's UI in real-time
- Combat: unified friendly-fire checks across ship, garrison, and character targets

### Fixed

- Friendly-fire: corp-ship garrisons no longer attack corpmates (pseudo-character corp resolution gap)
- Corp-ship events no longer leak into the voice agent as if they were the player's own
- Task slot limits now correct in LLM prompts (was claiming unlimited)
- Bot startup crash from an empty `__init__.py` stub in the Docker image

## [0.1.2] - 2026-04-19

### Added

- Combat tools (`combat_initiate`, `combat_action`) for TaskAgent with async completions
- Disconnect safety warnings in voice agent, game overview, and disconnect modal
- Aria labels and roles for mic toggle, text input, and conversation panel

### Changed

- Disabled event pruning cron by default; extended retention from 72 hours to 14 days
- Clarified combat targeting rules (any ship in sector is valid)
- Added ship destruction playbook to event_logs prompt

## [0.1.1] - 2026-04-19

### Added

- Event pruning cron job to prune stale non-important events (72h retention)
- Name validator with profanity and charset checks
- Disposable email domain blocking on signup
- Maintenance mode killswitch for login edge function
- Version plumbing: bot logs version on startup, sends version to client via RTVI on join
- `/release` skill for semver version bumps with CHANGELOG management
