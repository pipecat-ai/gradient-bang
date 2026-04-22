# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
