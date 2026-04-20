# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-04-20

### Added

- Two-word passphrase invite codes (e.g. `nebula-drift`) with collision retry
- Two-step confirm flow for `kick_corporation_member` and `join_corporation` via `corporation.kick_pending` / `corporation.join_pending` events and client confirmation modals
- `join_corporation` and `kick_corporation_member` exposed to the voice agent; removed from TaskAgent
- Auto-leave when joining a different corp while already in one: silent if not last member; pending-confirm if last member; refused if corp still owns ships
- Founder rejoin carve-out on `corporation_join` (skip invite-code validation when rejoining own corp)
- `is_founder` flag on member payloads so LLM/UI can gate founder-only actions
- New `KickConfirmDialog` and `JoinConfirmDialog` on the client
- New `_shared/friendly.ts` helper (`areFriendly`, `areFriendlyFromMeta`, `buildCorporationMap`) — single source of truth for combat friendly checks. `combat_garrison` and `combat_resolution` migrated to it.
- `VITE_BOT_URL` support in client for routing Pipecat sessions to a local bot while using prod Supabase (dev-only, dead-code-eliminated in prod builds)

### Changed

- Founder-only authorization for `corporation_kick` and `corporation_regenerate_invite_code` (was any-member)
- `invite_code` gated to the founder in `corporation_info` / `my_corporation` / `corporation.data` payloads; non-founders see only the notice that the founder holds it
- `JOIN_CORPORATION` schema now requires both `corp_name` and `invite_code`; description explicitly defers to `create_corporation` for onboarding
- Extracted shared `disbandCorporation()` helper with safety-net ship-release so a corp can never be soft-deleted while still owning ships
- Pending events are character-scoped to the actor (not broadcast to the corp)
- Confirm paths re-validate server-side so stale client messages can't bypass checks

### Fixed

- Removed literal duplicate self-kick check in `corporation_kick` handler
- Client now handles `corporation.member_left` / `corporation.member_kicked` to refresh the corp roster
- Friendly-fire: corporation-owned ship garrisons no longer target corpmates. `loadGarrisonCombatants` was resolving owner corp via `corporation_members` alone, which doesn't include corp-ship pseudo-characters; their corp_id came back null and the round resolver treated corpmates as hostile. Same gap fixed in `combat_initiate`'s targetability check.
- `combat_action` friendly-fire guard extended to character targets — previously only garrison targets were rejected, so a player dragged into combat with a corpmate could attack them.
- Corp-ship events no longer leak into voice agent context — remote sector activity was appearing as if it were the player's own
- Task slot limits now explicit in game prompts — LLM was telling players they could run unlimited concurrent tasks
- Dockerfile: copy real `__init__.py` instead of empty stub that crashed bot on startup

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
