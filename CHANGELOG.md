# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `start_task` on a busy ship still auto-steers the new instruction into the running task (preserving in-flight progress), but the steer is now wrapped with a `<priority>` directive on injection so the TaskAgent treats it as overriding its original plan. The voice agent prompt is updated to require READING the `task.completed` message and re-issuing `start_task` for any intent that wasn't fulfilled — this is the recovery path for cross-intent steers (e.g. "buy a probe and an Atlas" on a single personal slot).
- `steer_task` and the auto-steer path in `start_task` now pre-flight the target's finishing state. If the in-process TaskAgent has already called `finished` (or been cancelled), the orchestrator returns `error: "task_closing"` for explicit `steer_task` calls and translates to `ship_busy` for `start_task` busy-branch calls — either way the voice LLM chains a fresh `start_task` in the same turn instead of firing a steer that would race the terminal turn and silently drop. Personal and corp in-process ships both covered (same code path); BYOA agents skip the check and rely on the standard busy retry.
- TaskAgent `_inject_steering` now wraps incoming steer text with a short `<priority>` directive before injecting it into LLM context, so the steer outranks the original task instruction (which is itself a user message). Orchestrator side drops its now-redundant `"Steering instruction: "` text prefix.

## [0.6.0] - 2026-05-26

### Changed

- Bumped `pipecat-ai` to 1.3.0 (subagents now in-tree; dropped the `pipecat-ai-subagents` package).
- Centralized runtime configuration in `gradientbang.config` using `pydantic-settings`.
- Repository structure tidy-up and runtime module reorganization under `src/gradientbang/runtime/`.
- Migrated to the latest Pipecat SubAgents spec — `PipelineWorker`-hosted `Orchestrator`, bus-based `TaskAgent` workers, and the universal wake-up handshake aligned to the current `pipecat-ai-subagents` API.
- New-player onboarding now keeps the generated mega-port route as session-scoped private TaskAgent startup context for player-ship tasks, controlled by `BOT_NEW_PLAYER_ONBOARDING`.
- Local player-ship TaskAgents are now one-task workers like local corp-ship TaskAgents; completed player tasks end and remove their worker instead of reusing an idle pipeline.
- Text input now waits on Pipecat user-mute events via `app_resources`, matching voice turn sequencing.

### Fixed

- Map UI: numeric `map_zoom_level` from the UI agent is now honored as an absolute zoom (4–50 scale) instead of being downgraded to a single step when no center/highlight/fit is set. `map_zoom_direction` still steps gently for vague "zoom in/out" requests.

## [0.5.6] - 2026-05-21

### Fixed

- `list_known_ports` no longer builds an overlong PostgREST `.in(...)` URL for long-lived characters; ports are now loaded via a direct Postgres query against only the BFS-searched sectors, unblocking session startup for explored players.
- Port commodity sell trades now emit realized FIFO net profit instead of gross sale revenue, keeping tutorial trade-profit progress aligned with the voice agent.
- Tightened voice-agent prompt and `create_corporation` schema to discourage auto-founding a corp on cost/info questions ("how much for a corp?") and to nudge the agent toward asking for a name first.
- Added a corp-ship-purchase worked example to the voice-agent prompt and a rule against deferring ship purchases to the UI, to reduce cases where the agent refuses voice purchases.

## [0.5.5] - 2026-05-18

### Added

- BigMap: follow/freeroam mode with a Recenter button after pan or zoom gestures.
- Map: garrisons render in mode-specific colors (defensive/offensive/toll) for both own and enemy garrisons.
- Map: corp-mate ships render in a distinct color from self-owned corp ships.
- `local_map_region` response carries garrison `mode` and active `combat` per visited sector, so first-paint renders are complete without waiting for follow-up events.
- Ship payload includes `owner_character_id` so the client can classify self vs corp-mate without a separate lookup.

### Changed

- Internal: BYOA wake, presence, broker auth, and registry handling extracted from `VoiceAgent` into a new `ByoaCoordinator` collaborator (`pipecat_server/byoa_coordinator.py`). No behavior change; `voice_agent.py` shrinks by ~12%.
- BigMap zoom controls now share a store-backed zoom value with mouse-wheel zoom, keeping the slider, buttons, and canvas aligned.
- Course plot framing now runs only while BigMap is in follow mode; route animation continues in freeroam.
- Removed the course plot zoom toggle from map controls.
- Client map mutations consolidated behind a single `applyMapDelta(delta)` switch in `mapSlice`. Replaces `updateMapSectors` and the separate `combat_sectors` record; combat is now a flag on the sector node.

### Fixed

- EventRelay and TaskAgent now process game events through ordered mailboxes.
- BigMap freeroam no longer snaps back from delayed map fetch, fallback, or route-fit responses.
- Task-agent event inference drain grace is configurable via `TASK_AGENT_EVENT_DRAIN_GRACE_SECONDS`.
- Map sector icons (port, mega-port, garrison) reliably render on first paint after moving sector — previously required a hover to refresh. Memo equality now covers `garrison.mode` and `combat`.

## [0.5.4] - 2026-05-16

### Fixed

- Combat screen crash on missing result participant payloads.
- Corp ship task-response cleanup now releases session locks even if task-output notification fails.
- `ship.destroyed` client handling no longer creates a synthetic corporation ship entry for sector-visible destruction events that do not belong to the player's corporation.

## [0.5.3] - 2026-05-15

### Changed

- Gameplay `EVENT_TRANSPORT=pubsub` now uses online session-scoped PGMQ queues with heartbeat expiry and scheduled DB cleanup.

## [0.5.2] - 2026-05-14

### Added

- Per-character corporation ship cap with BYOA and destroyed-ship exemptions

## [0.5.1] - 2026-05-14

### Added

- Gradium is now supported as the default TTS provider, with Cartesia still selectable via `TTS_PROVIDER=cartesia`

### Fixed

- BYOA wake dispatch always calls `wake_agent`. The previous `fresh_presence` skip-wake optimization was racy — the just-exited harness's `online=False` broadcast could lag the next task dispatch, leaving the cache stale and the second task silently timing out
- Pubsub event delivery hardened to a required boundary. `pgmq_publish` and `record_event_with_recipients` no longer swallow publish failures, and `purge_backlog` keeps the per-character queue present (purges messages instead of dropping the table) so bootstrap-RPC events stop hitting silent `undefined_table` no-ops. Bot-side double-purge brackets `session_init` so bootstrap echoes never leak into the LLM context via EventRelay
- `pgBuildLocalMapRegion` includes `player: { id: characterId }` in its return so bootstrap `map.local` payloads pass the client's session-payload check
- `Dockerfile.bot`: install `git` so `uv` can clone the pinned `pipecat-ai-subagents` rev; drop the dead `COPY src/gradientbang/subagents/` line
- Deno edge server warms the adjacency cache at startup before serving traffic; bumps the local pg pool 3→8 to absorb bursty bootstrap traffic
- `purge_event_backlog` resolver: `PGMQ_URL` falls back to `LOCAL_API_POSTGRES_URL` when unset (both point at the same admin DSN in cloud deploys)

## [0.5.0] - 2026-05-14

### Added

- **BYOA (Bring-Your-Own-Agent)** — corp members can claim a corp ship and run their own task agent for it. Operators deploy the [BYOA harness](docs/byoa.md) (local dev via `uv run byoa --serve`, or production via a Vercel Function the operator owns). The bot wakes the operator's receiver over HTTPS per task; the operator's runtime spawns `uv run byoa` with the wake env. BYOA ships are owner-only: only the BYOA owner can start tasks on them; any corp member can force-cancel
- Per-ship wake config via `ship_byoa_configure { action: 'set', source_url, wake_secret }`. The wake bearer is stored encrypted at rest (`byoa_wake_secret_enc`, pgcrypto) and used per-ship — no shared env-var bearer
- BYOA online/offline + waking state on corp ship cards. Cold starts show a fuel-colored `Waking` badge until the first `task_output`
- Subagent bus is transport-pluggable via `SUBAGENT_BUS_TRANSPORT` (`local` default; `pgmq` enables BYOA). Set `SUBAGENT_BUS_DATABASE_URL` when running `pgmq`. Channels are server-allocated UUID-128 strings (`gb_<32hex>`) minted per voice session — knowledge of the channel name is the bus capability
- `TASK_AGENT_TIMEOUT` (bot env, default `1800`s) is now the per-task hard upper bound. Bot cancels and clears its local ship lock on expiry. Not operator-overridable
- `current_task_actor` and `byoa` blocks on `list_user_ships` and `corporation_info` ship-list payloads (character IDs truncated to 12 hex chars)
- Universal wake-up handshake (`BusAgentHelloRequest` / `Response`) before task dispatch. Times out per `BYOA_AGENT_WAKE_TIMEOUT_SECONDS` (default 30s) — generous enough for a Vercel-Sandbox cold start
- Idle teardown for warm corp-ship / BYOA agents after `BYOA_AGENT_IDLE_TEARDOWN_SECONDS` (default 300s) of no activity. Player-ship agents are reused across tasks and excluded

### Changed

- Ship-task lock is per-bot in memory (`VoiceAgent._locked_ships`). BYOA presence heartbeats (10s cadence over the bus) are the crash signal — ~30s stale presence clears the local lock and emits `task.cancel`
- `task_lifecycle event_type=start` and `task_cancel` no longer touch a DB lock; they emit lifecycle events only. Still returns `403 byoa_private_not_owner` when a non-owner tries to start a task on a private BYOA ship. `task_cancel { force: true }` lets any corp member cancel a BYOA-owned task when the owner is unreachable
- `record_event_with_recipients` owns pubsub delivery from SQL, so SQL-only quest events reach pgmq without JS dual-writes
- `quest.reward_claimed` events reframed as payout, not progress
- TaskAgent drops its dedicated `AsyncGameClient` — VoiceAgent's single player-bound client services every TaskAgent via per-call identity overrides. Concurrent calls disambiguate `task_id` via a `ContextVar` instead of mutating shared client state
- Game RPCs, lifecycle events, corp queries, and combat doctrine fetches all flow through typed bus messages to VoiceAgent's broker. Broker treats envelope `character_id` / `actor_character_id` as authoritative

### Fixed

- Onboarding mega-port route stays in Federation Space. `findRouteToNearest` accepts a traversable predicate; `join` filters by `fedspace_sectors`; worldgen's `select_fedspace` grows the fedspace region as a connected subgraph so every mega-port is reachable without crossing Neutral. **Existing universes must be regenerated** to pick up the new layout
- Task-agent mega-port verification: read the `MEGA ` / `STD ` prefix on the port string in `movement.complete` / `status.snapshot` instead of stacking commodity filters on `list_known_ports`, which produced false negatives

### Removed

- DB ship-lock columns and RPCs (`acquire_ship_task_lock`, `release_ship_task_lock`, `force_release_ship_task_lock`, `refresh_ship_task_heartbeats`), the `task_heartbeat` edge function, and `AsyncGameClient.task_heartbeat`
- BYOA token surface: `byoa_tokens` table, `verify_byoa_token` SQL function, and the `byoa_token_mint` / `byoa_token_revoke` edge functions. Channel-as-capability replaced the per-op token check
- Env vars: `BYOA_TOKEN`, `BYOA_HEARTBEAT_INTERVAL_SECONDS`, `TASK_LOCK_HEARTBEAT_STALE_SECONDS`, `TASK_LOCK_HARD_TTL_MINUTES`, `BYOA_SERVER_LOCK_STALE_SECONDS`, `BYOA_SERVER_LOCK_HARD_TTL_MINUTES`

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
