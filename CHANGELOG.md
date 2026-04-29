# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Combat round outcomes are now persisted to `ship_instances` after every round, not just at end of combat — DB-sourced reads (`my_corporation`, `corporation_info`, `status.update`, voice/task tools) reflect live fighter and shield counts during a fight instead of pre-combat values
- Destroyed players exit combat immediately: escape-pod conversion, personalized `combat.ended`, and unblocked movement / trade / bank actions all happen the moment the ship dies — no more sitting through the rest of someone else's fight
- Destroyed corp ships clean up immediately when they die (pseudo-character + `corporation_ships` row removed mid-round) instead of waiting for the encounter to end
- Destroyed combatants stay in the participant list flagged `destruction_handled = true` so observers and the LLM see "destroyed in round N" persistently across the rest of the encounter, not a vague absence

### Changed

- Salvage from a ship destroyed mid-combat now drops to the sector only when combat ends — preventing in-fight loots and sector passers-by from collecting wrecks while the battle is still going
- `combat_action` rejects all actions from destroyed or escape-pod participants (was: only rejected `flee`); attacks on a destroyed target are rejected at submission with a clear error

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
