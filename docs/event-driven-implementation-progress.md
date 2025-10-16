# Event-Driven API implementation

We are working on a code refactor and implementation of an event-driven API design.

The event-driven API design document is here:
  - docs/event-driven-api-design.md

## Work plan

- 2025-10-15: Verified RPC router propagates `request_id`; recommend prioritizing event payload updates (join/move/plot_course) in upcoming Phase 2-3 tickets so correlation metadata is consistently attached.
- 2025-10-15: After removing `check_trade`, audit prompt/tool guidance in future tickets so agents expect `trade` to raise errors instead of pre-checking.
- 2025-10-16: Removed `combat.status` polling; confirm upcoming join/move tickets emit `combat.round_waiting` for late arrivals so UI/tests rely exclusively on events.
- 2025-10-16: Join emits `combat.round_waiting` with request correlation when combat is active; ensure move arrival (2.5.3) mirrors this so reconnects and jumps behave the same way.
- 2025-10-16: Move arrivals now emit `combat.round_waiting` with `move` correlation metadata; confirm AsyncGameClient updates consume events instead of polling when we reach Phase 5.
- 2025-10-16: `my_status` now emits `status.snapshot` with request correlation; align upcoming map events (3.2-3.4) so reconnect hydration uses consistent snapshot semantics before AsyncGameClient refresh in Phase 5.
- 2025-10-16: `my_map` now emits `map.knowledge` snapshots; coordinate plot_course cleanup (3.3) and remaining map events (3.4) to share the same correlation helper for consistent reconnect flows.

Implement one ticket at a time. Implement the next ticket in the check-list. Then stop and review the code. Add comments and suggestions to the "Work plan" section of this document. Then wait for user feedback and approval.

After ticket completion, we will manually commit changes to the repository. If it's useful to see changes made for previous tickets, use git history and diff commands.

DO NOT MAKE ANY GIT COMMITS.

### Implementation Rules

- Treat each phase as a gate: finish all tickets in Phase 1 (1.x) before starting Phase 2 (2.x), and continue sequentially through the checklist. This keeps dependencies aligned with the design plan.
- Before closing a ticket, confirm its acceptance criteria and recommended tests from `docs/event-driven-api-design.md` (e.g., note the pytest modules or integration flows to rerun) so validation is explicit.
- When a ticket touches documentation, immediately queue or complete updates for `docs/event_catalog.md`, the new API/event references, and `CLAUDE.md` rather than deferring them.
- Whenever you stop for feedback, add a note about what was done for this ticket, and why you stopped, to the Progress notes section.
- After finishing a ticket: run the relevant tests, record outcomes and any blockers in "Progress notes," identify follow-up questions for design clarifications if needed, and pause for review/feedback before continuing.

  After completing a ticket, verify:
  - [ ] Acceptance criteria met (from design doc)
  - [ ] Tests pass (specify which: unit tests for server changes, integration tests for client changes)
  - [ ] No unintended side effects on existing functionality
  - [ ] Code follows existing patterns in the codebase
  - [ ] Error handling is complete
  - [ ] Changes logged in Progress notes with outcomes

If you encounter any issues or have questions, please add them to the "Progress notes" section and then stop and wait for feedback.

### Test Execution Strategy

  **Per Ticket:**
  - Phase 1-2: Unit tests only (`pytest game-server/tests/`)
  - Phase 3-4: Unit tests + targeted integration tests for changed endpoints
  - Phase 5.1-5.2: Full test suite including combat tests (~3 min runtime)
  - Phase 6-7: Full validation including NPC tests if available

  **Test Server:** For integration tests requiring server on port 8002, always note in Progress notes: "Test
  server started on port 8002" before running tests.

### High-Risk Tickets
  These tickets are particularly risky and need extra care:
  - **5.1 (AsyncGameClient)**: Affects all clients - test thoroughly
  - **5.2 (Integration Tests)**: May reveal issues in Phases 1-4
  - **7.1 (NPC Scripts)**: Complex async logic, may need LLM API access

## Check-list of tickets

- [x] Phase 0: Run full test suite and record baseline results
- [x] Ticket 1.1: Create RPC Response Helper Functions
- [x] Ticket 1.2: Add Error Event Support
- [x] Ticket 1.3: Expose RPC Frame ID to Handlers
- [x] Ticket 2.1: Delete check_trade Endpoint
- [x] Ticket 2.5.1: Delete combat.status Endpoint
- [x] Ticket 2.5.2: Verify Combat Events on Join
- [x] Ticket 2.5.3: Verify Combat Events on Move Arrival
- [x] Ticket 3.1: Implement status.snapshot Event (my_status)
- [x] Ticket 3.2: Implement map.knowledge Event (my_map)
- [ ] Ticket 3.3: Remove Redundant Return Data (plot_course)
- [ ] Ticket 3.4-3.6: Implement Remaining Map Events
- [ ] Ticket 4.1: Emit status.snapshot on Join (join)
- [ ] Ticket 4.2: Enhance trade.executed Event
- [ ] Ticket 4.3-4.4: Enhance Warp Power Events
- [ ] Ticket 4.5: Simplify combat.initiate Response and Enhance combat.round_waiting
- [ ] Ticket 4.6: Implement combat.action_accepted Event
- [ ] Ticket 4.7-4.10: Implement Garrison and Salvage Events
- [ ] Ticket 5.1: Update AsyncGameClient for Event-Based Responses
- [ ] Ticket 5.2: Update Integration Tests
- [ ] Ticket 6.1: Update API and Event Documentation
- [ ] Ticket 6.2: Update CLAUDE.md
- [ ] Ticket 7.1: Update NPC Scripts for Event-Driven AsyncGameClient
- [ ] Ticket 7.2: Remove Old Terminal Viewers
- [ ] Ticket 7.3: Design New Monitoring Tools (Optional)

## Test suite baseline results

- 2025-10-15: `uv run pytest -q` (with `PORT=8002` server running) → 5 failed, 221 passed, 53 skipped, 1 warning. Failures: `tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_events_privacy`, `tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_round_resolved_deltas`, `tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_ended_salvage_structure`, `tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_with_garrison`, `tests/test_websocket_messaging.py::test_sector_observers_receive_redacted_movement`. Combat-related tests are failing against current implementation baseline; no changes applied yet.

## Progress notes
- 2025-10-15 (Phase 0): Started server on port 8002, ran full pytest suite to capture current baseline. Documented failing combat event tests above; results reflect pre-refactor event-driven gaps. Pausing for review before moving to Ticket 1.1.
- 2025-10-15 (Ticket 1.1): Added rpc_success/rpc_failure/build_event_source helpers in `game-server/api/utils.py` and created `game-server/tests/test_api_utils.py`. Tests: `uv run pytest game-server/tests/test_api_utils.py -q` (pass). Pending review before Ticket 1.2.
- 2025-10-15 (Ticket 1.2): Added `emit_error_event` helper, new unit test in `game-server/tests/test_error_events.py`, and documented the `error` event schema in `docs/event_catalog.md`. Tests: `uv run pytest game-server/tests/test_api_utils.py game-server/tests/test_error_events.py -q` (pass). Pausing for review before Ticket 1.3.
- 2025-10-15 (Ticket 1.3): Updated WebSocket RPC router to guarantee `request_id` propagation, added payload validation, and introduced `game-server/tests/test_server_rpc.py` exercising explicit and generated request IDs. Tests: `uv run pytest game-server/tests/test_server_rpc.py game-server/tests/test_api_utils.py game-server/tests/test_error_events.py -q` (pass). Ready for review before Ticket 2.1.
- 2025-10-15 (Ticket 2.1): Removed `check_trade` endpoint, rate limits, AsyncGameClient method, and LLM tool references; updated prompts/docs (`utils/prompts.py`, `AGENTS.md`, `CLAUDE.md`) to reflect direct trading. Tests: `uv run pytest -q` (with test server on port 8002) → 7 failed, 224 passed, 53 skipped, 1 warning. Failures include prior baseline gaps (`tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_events_privacy`, `...::test_combat_round_resolved_deltas`, `...::test_combat_ended_salvage_structure`, `...::test_combat_with_garrison`, `tests/test_websocket_messaging.py::test_sector_observers_receive_redacted_movement`) plus two new trade-validation failures (`tests/test_combat_trade_events_integration.py::TestTradeEvents::test_port_update_event_on_trade`, `...::test_multiple_traders_receive_port_update`) triggered by insufficient credits after removing the preview step. Added optional `credits` support to `AsyncGameClient.join` and re-ran the two trade-event tests directly (`uv run pytest tests/test_combat_trade_events_integration.py::TestTradeEvents::test_port_update_event_on_trade tests/test_combat_trade_events_integration.py::TestTradeEvents::test_multiple_traders_receive_port_update -q`) → both now pass when seeding characters with 500 credits. Baseline combat/websocket failures remain for future tickets.
- 2025-10-15 (Combat event cleanup): Added a `test_reset` helper to `AsyncGameClient`, used it to isolate combat fixtures, and updated the websocket test to rely on `movement.complete` (movers no longer expect `character.moved`). Tests: `uv run pytest tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_round_resolved_deltas -q` (pass), `uv run pytest tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_ended_salvage_structure -q` (pass), `uv run pytest tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_with_garrison -q` (pass), `uv run pytest tests/test_combat_trade_events_integration.py::TestCombatEvents::test_combat_events_privacy -q` (pass), `uv run pytest tests/test_combat_trade_events_integration.py::TestTradeEvents::test_port_update_event_on_trade -q` (pass), and `uv run pytest tests/test_websocket_messaging.py::test_sector_observers_receive_redacted_movement -q` (pass). Full combat suite still requires ~22 minutes; noted timeout when batching (>20 min) but individual cases succeed.
- 2025-10-16 (Ticket 2.5.1): Removed the `combat.status` RPC handler, related rate limit, AsyncGameClient wrapper, and test usage so combat state is event-driven only. Tests: `uv run pytest game-server/tests -q` (pass). Pausing before Ticket 2.5.2 to verify combat events for late joiners.
- 2025-10-16 (Ticket 2.5.2): Join now emits `combat.round_waiting` with the `join` request's correlation metadata whenever combat is already active, and skips emission when no encounter is present. Added unit coverage in `game-server/tests/test_join_combat.py`. Tests: `uv run pytest game-server/tests/test_join_combat.py -q` (pass), `uv run pytest game-server/tests -q` (pass). Pausing before Ticket 2.5.3 to align move arrivals with the same event behavior.
- 2025-10-16 (Ticket 2.5.3): Move arrivals emit `combat.round_waiting` with `move` request correlation after stitching the character into active encounters (including auto-garrison starts). Added coverage in `game-server/tests/test_move_combat.py`. Tests: `uv run pytest game-server/tests/test_move_combat.py -q` (pass), `uv run pytest game-server/tests -q` (pass). Pausing before Phase 3 tickets.
- 2025-10-16 (Ticket 3.1): `my_status` now emits `status.snapshot` (correlated to the RPC request) and returns minimal success payloads. Added `game-server/tests/test_my_status.py` plus WebSocket integration coverage in `tests/test_server_websocket.py::test_ws_join_and_status`, and documented the new event in `docs/event_catalog.md`. Tests: `uv run pytest game-server/tests/test_my_status.py tests/test_server_websocket.py::test_ws_join_and_status -q` (pass). Pausing for review before Ticket 3.2.
- 2025-10-16 (Ticket 3.2): `my_map` now emits `map.knowledge` with request correlation while RPC responses collapse to `{success: True}`. Added `game-server/tests/test_my_map.py`, extended the WebSocket integration test to wait for `map.knowledge`, and documented the event in `docs/event_catalog.md`. Tests: `uv run pytest game-server/tests/test_my_map.py tests/test_server_websocket.py::test_ws_join_and_status -q` (pass). Pausing before Ticket 3.3.
