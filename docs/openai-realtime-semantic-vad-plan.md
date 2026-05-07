# OpenAI Realtime Semantic VAD Plan

Date: 2026-05-06

## Goal

Remove all local turn detection (Silero VAD + S3 Smart Turn) and rely entirely
on OpenAI Realtime's `semantic_vad` for user-turn start, user-turn stop, and
mid-bot interruption detection.

This is a follow-on to the existing OpenAI Realtime Phase 1 wiring in
`src/gradientbang/pipecat_server/openai_realtime.py` and `bot.py`, which today
keeps local Silero/S3 as the turn authority and configures
`audio.input.turn_detection = False` on the OpenAI side.

## Why semantic VAD is the right next step

The Phase 1 code carries substantial complexity because local turn detection
runs ahead of OpenAI transcription:

- `RealtimeAudioOnlyS3TurnStopStrategy` exists to drive turn-end from S3 audio
  classification while ignoring transcript timing.
- `RealtimeAudioLLMUserAggregator` currently mirrors Realtime transcripts into
  context out-of-band, because they arrive *after* the local S3 turn has already
  closed.
- The wrapper's `_handle_user_stopped_speaking` is responsible for sending
  `input_audio_buffer.commit` + `response.create` because OpenAI is told not
  to detect speech itself.

If OpenAI is the turn authority, `RealtimeAudioOnlyS3TurnStopStrategy` can be
deleted and the wrapper stops owning audio-buffer commit. The user aggregator
must be changed, not merely kept: Realtime transcript frames need an
OpenAI-item-keyed aggregation path. Pipecat's stock `LLMUserAggregator` has one
transcript buffer and one active user turn, so it cannot safely separate
overlapping OpenAI audio items when transcription completions arrive out of
order.

## What semantic VAD provides

With `audio.input.turn_detection = SemanticTurnDetection(eagerness, create_response,
interrupt_response)`, OpenAI emits server events that Pipecat's
`OpenAIRealtimeLLMService` and the wrapper map to standard pipeline frames:

| Server event | Pipecat handler | Frames emitted |
| --- | --- | --- |
| `input_audio_buffer.speech_started` | wrapper override preserving `_handle_evt_speech_started` effects | `UserStartedSpeakingFrame` broadcast with OpenAI `item_id` metadata + `broadcast_interruption()` |
| `input_audio_buffer.speech_stopped` | wrapper override replacing `_handle_evt_speech_stopped` | `UserStoppedSpeakingFrame` broadcast with OpenAI `item_id` metadata |
| `input_audio_buffer.committed` | wrapper's `_handle_evt_input_audio_buffer_committed` | records latest committed audio item id for diagnostics / recovery |
| `conversation.item.input_audio_transcription.completed` | wrapper's `handle_evt_input_audio_transcription_completed` | upstream `TranscriptionFrame` |
| `conversation.item.input_audio_transcription.failed` | wrapper's new failed-transcription handler | upstream marker `TranscriptionFrame` |
| `response.created` / `response.done` | existing handlers | `LLMFullResponseStartFrame` / `LLMFullResponseEndFrame`, audio frames, etc. |

These broadcasts originate *inside the VoiceAgent's pipeline*. For them to
reach the main pipeline, VoiceAgent's bridged `_BusEdgeProcessor`s must not
exclude semantic VAD control frames. Today
`realtime_voice_agent_echo_exclude_frames()` excludes
`UserStartedSpeakingFrame`, `UserStoppedSpeakingFrame`, and
`InterruptionFrame`, which would keep the semantic VAD frames local to
VoiceAgent and break the migration. In semantic VAD mode those frame types must
be allowed to cross the bus. `_BusEdgeProcessor.process_frame` already pushes a
frame locally before sending it to the bus, so removing them from the exclude
tuple provides the needed "fanout": VoiceAgent still observes the frames
locally, and the main pipeline receives a bus copy.

There are two different bridge implementations in this flow:
VoiceAgent pipelines are wrapped by `_BusEdgeProcessor` at their source/sink
edges (`BaseAgent.create_pipeline`), while the main transport/session pipeline
uses the mid-pipeline `BusBridgeProcessor`. VoiceAgent edges push locally first,
then send matching-direction frames to the bus. The main bridge receives bus
frames with `push_frame()`, not `process_frame()`, so received semantic VAD
frames are inserted into the main pipeline without being rebroadcast.

With that forwarding fix, both semantic copies reach the main bridge through
VoiceAgent's `_BusEdgeProcessor`s. The main bridge pushes bus frames locally
from `on_bus_message`; this does not re-enter
`BusBridgeProcessor.process_frame`, so it does not rebroadcast the same frame.
VoiceAgent's own edge processors also ignore bus messages whose source is
VoiceAgent, so `broadcast_sibling_id` pairs do not create a loop. The main
pipeline's `user_aggregator` (upstream of the bridge) sees the upstream copy,
and the parallel branch's `transport.output()` and local TTS (downstream) see
the downstream `InterruptionFrame`.

Frame *types* stay the same, but source and reception side effects do not. In
Phase 1, logical user-start/stop originated in the main pipeline's
`user_aggregator`; in semantic VAD mode, those frames originate inside
VoiceAgent. That means `RealtimeVoiceAgentInferenceGate` and VoiceAgent's
pipeline-task upstream observer see spoken user turns directly, updating
`_user_speaking`, `_awaiting_bot_reply`, and deferred-update drain state. This
is desired, but it is a behavioral change that must be tested.

## Decisions

- **`create_response=False`**: keep `maybe_create_response` as the single
  client-side `response.create` path for every inference source (user turns,
  game events, `LLMRunFrame`, tool results). This is not the same as routing
  every source through the shared `can_run_now()` gate: user audio turns still
  call `maybe_create_response(..., ignore_gate=True)`, matching Phase 1, while
  retaining the wrapper's active-response guard and deferred-run behavior. With
  `create_response=True`, OpenAI auto-fires `response.create` on every
  `speech_stopped`, the wrapper's active-response/gate logic stops controlling
  user turns, and any concurrent `LLMMessagesAppendFrame(run_llm=True)`
  arriving from EventRelay can race the auto-response and get rejected with
  `conversation_already_has_active_response` (`realtime/llm.py:751-755`
  silently swallows it).

  **Known cost:** every spoken user turn pays one extra round trip:
  `speech_stopped` event → wrapper sends `response.create` → OpenAI begins
  generating. The cleaner follow-up is dynamic `session.update` toggling:
  `create_response=True` only when the pipeline is quiescent, and
  `create_response=False` while a deferred event is queued or a response is
  active. Defer that optimization until the static `create_response=False` path
  is stable. Leave a short code comment at the `SemanticTurnDetection` call site
  documenting this latency tradeoff.
- **`interrupt_response=True`**: let OpenAI cancel its own response on user
  speech_started. The local pipeline still receives the broadcast
  `InterruptionFrame` to clear `transport.output()`'s audio buffer.
- **Keep `RealtimeAudioLLMUserAggregator`, but change its job.** In semantic VAD
  mode it must not feed Realtime `TranscriptionFrame` /
  `InterimTranscriptionFrame` into Pipecat's stock single `_aggregation` buffer.
  Instead it should:
  - record user-start insertion anchors by OpenAI Realtime `item_id`, taken from
    `UserStartedSpeakingFrame.metadata`;
  - record semantic stops by the `UserStoppedSpeakingFrame` item id;
  - store completed/failed transcript state by `frame.result.item_id`;
  - finalize each stopped+transcribed item independently, inserting the user
    message before the first assistant message added after that matching item-id
    anchor, with Realtime `item_id` metadata.
    This repairs the rare but real case where assistant text is aggregated before
    OpenAI input transcription completes, and it avoids the more serious case
    where turn B starts before turn A's transcript arrives and stock aggregation
    would merge or strand the text. See Risk G5.
- **Use an immediate Realtime stop strategy for local turn state.** The main
  `user_aggregator` should still see `UserStartedSpeakingFrame` /
  `UserStoppedSpeakingFrame`, but the stock `ExternalUserTurnStopStrategy` is the
  wrong closure authority for Realtime transcripts because it waits for text and
  has only one pending turn. Add a Realtime-specific external stop strategy that
  triggers on `UserStoppedSpeakingFrame` immediately, with
  `enable_user_speaking_frames=False`, so `UserTurnController` closes before the
  next OpenAI item can start. Transcript context insertion is owned by the
  item-keyed Realtime aggregator, not by stock `push_aggregation()`. The
  Realtime aggregator must override `_maybe_emit_user_turn_stopped()`: when the
  immediate semantic stop path produces empty stock aggregation, do not call the
  stock empty `on_user_turn_stopped` handler; emit any content-bearing
  turn-stopped callback from item finalization if current consumers need it.
- **Item-id consistency assumption:** a single OpenAI user audio item uses the
  same `item_id` across `input_audio_buffer.speech_started`,
  `input_audio_buffer.speech_stopped`,
  `conversation.item.input_audio_transcription.completed`, and
  `conversation.item.input_audio_transcription.failed`. This matches current
  Realtime events and is the basis of the anchor map. If the ids ever mismatch,
  the implementation must log the mismatch and use the safe fallback described
  in G5 rather than corrupting local context order.
- **`eagerness` defaults to `medium` and is exposed as an env var.** Coarser
  than the per-player S3 tuning; expect a different turn-boundary feel. Avoid
  `auto` as the default because it can change OpenAI-side over time and make
  deployment-to-deployment turn boundaries less deterministic.
- **Audio sample rate handling unchanged.** The wrapper's per-frame
  `AudioResampler` (`openai_realtime.py:528-539`) keeps doing the 16k → 24k
  conversion; Daily transport input stays at `OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE = 16000`.

## Frame flow audit (semantic VAD mode)

### User starts speaking

1. OpenAI server emits `input_audio_buffer.speech_started`.
2. Wrapper's `_handle_evt_speech_started` override runs
   `_truncate_current_audio_response`, then broadcasts paired
   `UserStartedSpeakingFrame` instances carrying `evt.item_id` and
   `evt.audio_start_ms` in frame metadata, then calls
   `broadcast_interruption()`. Do not call the parent handler: inline these
   steps so the metadata-carrying frames replace the parent's plain
   `broadcast_frame(UserStartedSpeakingFrame)`. Do not use
   `broadcast_frame_instance()` unless metadata is deep/copied per copy; that
   helper shallow-copies non-init fields, so the upstream/downstream frames
   would share the same metadata dict. A small local helper that creates two
   frames, sets `broadcast_sibling_id`, and assigns fresh metadata dicts is
   safer.
3. The user-start broadcast pushes both directions from the LLM service.
   - Upstream copy: VoiceAgent upstream edge → bus → main bridge
     `on_bus_message` → pushed
     upstream into main pipeline → user_aggregator's
     `ExternalUserTurnStartStrategy` triggers `trigger_user_turn_started`.
     `RealtimeAudioLLMUserAggregator` records a user-start insertion anchor
     keyed by the OpenAI item id from frame metadata. Idle report processor
     sees the frame and cancels its timer.
   - Downstream copy: VoiceAgent downstream edge → bus → main bridge → pushed
     downstream into parallel branch → reaches transport.output() (which is now
     informed about the upcoming interrupt) → reaches assistant_aggregator
     (which calls `_handle_interruptions` → `_trigger_assistant_turn_stopped` →
     resets state).
4. Inside VoiceAgent, the upstream copy also passes through
   `RealtimeVoiceAgentInferenceGate` and VoiceAgent's upstream observer. This
   flips shared gate user-turn state and VoiceAgent `_user_speaking` state for
   spoken turns, which did not happen from this source in Phase 1.
5. `broadcast_interruption` does the same for `InterruptionFrame`. Local TTS
   resets, transport.output() flushes its audio queue, OpenAI cancels its
   active response server-side (interrupt_response=True). Existing Pipecat
   `broadcast_interruption()` also resets the processor task and stops all
   metrics before broadcasting the interruption; that behavior is intentionally
   preserved.

### User stops speaking

1. OpenAI server emits `input_audio_buffer.speech_stopped`.
2. Wrapper's overridden `_handle_evt_speech_stopped`:
   - does **not** call `super()._handle_evt_speech_stopped(evt)`, because the
     parent starts TTFB/processing metrics before broadcasting and our
     `maybe_create_response` path starts those metrics only if it actually sends
     `response.create`.
   - directly broadcasts paired `UserStoppedSpeakingFrame` instances carrying
     `evt.item_id` and `evt.audio_end_ms` in fresh per-frame metadata dicts.
   - calls `maybe_create_response("speech-stopped", ignore_gate=True)`. We
     drive `response.create` directly here rather than through the
     `_handle_user_stopped_speaking(frame)` path, because broadcasting
     bypasses `process_frame` and the frame doesn't re-enter the wrapper. (See
     Risk G2.)
3. `UserStoppedSpeakingFrame` propagates the same way as in Phase 1: bridge
   pushes both copies, and the main user_aggregator's Realtime stop strategy
   closes Pipecat's local user-turn state immediately without emitting another
   `UserStoppedSpeakingFrame`. The Realtime aggregator must suppress a premature
   empty stock aggregation event here; transcript context is finalized later by
   item id. In VoiceAgent, the upstream copy also clears shared user-turn-active
   state and sets `_awaiting_bot_reply=True`, blocking deferred-update narration
   until the assistant cycle goes idle.
4. OpenAI auto-commits the audio buffer (this happens regardless of
   `create_response`).
5. Wrapper's `maybe_create_response` either:
   - queues `LLMFullResponseStartFrame`, starts metrics, marks the shared gate
     LLM-in-flight, and sends `response.create`; or
   - if another response is already active, requests deferred inference and does
     **not** start metrics.
   Audio response begins only in the first case. In the deferred case, metrics
   start later when the deferred trigger actually calls `maybe_create_response`
   and sends `response.create`.

### User audio transcribed

1. OpenAI emits `conversation.item.input_audio_transcription.completed`,
   typically *during* response generation.
2. Wrapper pushes a final `TranscriptionFrame` upstream.
3. Frame reaches user_aggregator. In semantic VAD mode the Realtime-specific
   aggregator consumes Realtime final/interim transcription frames into an
   item-keyed table instead of calling stock `LLMUserAggregator.process_frame`
   for them. Stock aggregation has one `_aggregation` buffer and would merge or
   strand text if turn B starts before turn A's transcript completes.
4. Once that item has both semantic stop state and final transcript/failure
   state, `RealtimeAudioLLMUserAggregator` finalizes that item directly: resolve
   the matching user-start anchor from the item-id table, search forward from
   that anchor, and insert before the first later assistant message; if no later
   assistant exists, append after any non-assistant messages added mid-turn. This
   repairs local context order to `[..., user, assistant]` without moving
   system/event/user appends that legitimately arrived during the turn. It
   records OpenAI `item_id` metadata and marks the item as emitted so a duplicate
   transcription event cannot mirror the same user message again. If a transcript
   arrives for an older item after a newer user-start has already been observed,
   it must use its own item-id anchor, not the latest active anchor.
5. user_aggregator pushes `LLMContextFrame` downstream → reaches wrapper →
   `_handle_context` runs `_process_completed_function_calls(send_new_results=False)`,
   which is a no-op for plain user turns. Local context now has the user
   message.

### User audio transcription fails

1. OpenAI emits `conversation.item.input_audio_transcription.failed`.
2. Wrapper handles it explicitly instead of only logging. It pushes a final
   upstream `TranscriptionFrame` with a non-empty local marker such as
   `[voice input transcription failed]` and the OpenAI failure event attached in
   `result` metadata.
3. The item-keyed Realtime aggregator treats this as the final state for that
   OpenAI item and inserts one synthetic failed-transcription user message at
   that item's anchor. Local turn state should already have closed from the
   semantic `UserStoppedSpeakingFrame`; the marker exists for context/audit, not
   to satisfy stock `ExternalUserTurnStopStrategy`.
4. The failed item id is marked emitted/deduped the same way as completed
   transcript item ids, so a retry or duplicate failure event cannot add another
   marker.

### Bot interrupted by user mid-response

1. While bot is speaking, user starts talking. Audio still flows through main
   pipeline → bridge → bus → wrapper's `_send_user_audio` (audio is *not*
   muted during bot speech in normal operation; see Risk G3).
2. OpenAI detects speech_started, fires the same broadcast as above.
3. `interrupt_response=True` causes OpenAI to cancel its response server-side.
4. Locally, `InterruptionFrame` arrives at transport.output()'s
   `_handle_frame` → MediaSender clears audio queue. Local TTS service handles
   `InterruptionFrame` → resets state.
5. Wrapper's `_truncate_current_audio_response` already runs in
   `_handle_evt_speech_started`. With `interrupt_response=True`, OpenAI may
   also have canceled first; benign cancel/truncate races must remain non-fatal
   and should be verified against the actual Realtime error codes.

### Game events / tool calls / text input

The code call points remain the same: `RealtimeMainContextRelay` mirrors main
context appends/runs, `RealtimeFunctionResultRelay` sends
`function_call_output`, and non-user-audio response triggers still pass through
`maybe_create_response` with the shared gate enabled. The surrounding state is
not identical to Phase 1 because semantic VAD frames now update
`RealtimeVoiceAgentInferenceGate` and VoiceAgent spoken-turn state directly.
`RealtimeMainContextRelay` does not mirror user-start/user-stop/interruption
frames, and the main bridge's bus receive path uses `push_frame`, not
`process_frame`, so semantic VAD control frames are not double-emitted back to
VoiceAgent. Its context-append mutation behavior does change: it must avoid
locally appending messages that a downstream main context aggregator
(`user_aggregator` for main-origin frames, `assistant_aggregator` for
VoiceAgent-origin frames) will add to the same shared `LLMContext` object (see
G5b).

## Concrete changes

### `src/gradientbang/pipecat_server/openai_realtime.py`

| Location | Change |
| --- | --- |
| `build_realtime_session_properties` (l. 880-900) | `turn_detection=False` → `SemanticTurnDetection(eagerness=..., create_response=False, interrupt_response=True)` |
| `RealtimeAudioOnlyS3TurnStopStrategy` (l. 135-178) | **Delete** |
| `RealtimeAudioLLMUserAggregator` (l. 181-233) | Keep but rewrite semantics: consume Realtime final/interim transcript frames into an item-keyed table instead of stock `_aggregation`; remove unconditional mirror append; record start/stop anchors by OpenAI item id from `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame` metadata; capture transcript item id from `frame.result.item_id`; finalize each stopped+transcribed item independently, inserting the user message before the first later assistant message after the matching item-id anchor, with Realtime `item_id` metadata and item-id dedupe |
| `RealtimeSemanticUserTurnStopStrategy` (new) | Add a tiny external stop strategy for semantic VAD mode that triggers local user-turn stop immediately on `UserStoppedSpeakingFrame` with `enable_user_speaking_frames=False`; do not wait for transcript text |
| `_handle_evt_speech_started` (override, new) | Do **not** call `super()`. Inline parent effects: `_truncate_current_audio_response()`, metadata-carrying `UserStartedSpeakingFrame` broadcast with fresh metadata dicts per copy, then `broadcast_interruption()` |
| `_handle_user_stopped_speaking` (l. 351-359) | No-op in semantic VAD mode (no commit, no create_response). Replaced by override of `_handle_evt_speech_stopped` |
| `_handle_evt_speech_stopped` (override, new) | Do **not** call `super()`. Directly broadcast `UserStoppedSpeakingFrame` with OpenAI `item_id` / `audio_end_ms` metadata using fresh metadata dicts per copy, then call `await self.maybe_create_response("speech-stopped", ignore_gate=True)` so metrics start only when a response is actually created |
| `_receive_task_handler` transcription-failed branch (l. 655-656) | Replace log-only handling with a helper that pushes a final marker `TranscriptionFrame` upstream and dedupes the OpenAI item id |
| `insert_messages_from_append` / `RealtimeMainContextRelay` | Make context mirroring duplicate-safe: send Realtime conversation items/session updates but skip all local context append branches for any append source once the wrapper has adopted the shared main `LLMContext`; before shared adoption, keep wrapper-owned local mutation |
| `RealtimeVoiceAgentInferenceGate.process_frame` (l. 759-766) | Drop `VADUserStartedSpeakingFrame` / `VADUserStoppedSpeakingFrame` branches (dead code without local VAD) |
| `realtime_voice_agent_echo_exclude_frames` (l. 868-877) | Remove `UserStartedSpeakingFrame`, `UserStoppedSpeakingFrame`, `VADUserStartedSpeakingFrame`, `VADUserStoppedSpeakingFrame`, and `InterruptionFrame` from the tuple so semantic VAD user/control frames cross the bus; keep raw audio excluded |

### `src/gradientbang/pipecat_server/bot.py`

| Location | Change |
| --- | --- |
| `LLMUserAggregatorParams` block (l. 405-421) | For realtime mode only, set `vad_analyzer=None` and replace `UserTurnStrategies(...)` with `UserTurnStrategies(start=[ExternalUserTurnStartStrategy()], stop=[RealtimeSemanticUserTurnStopStrategy()])`. Keep `SileroVADAnalyzer`, `S3SmartTurnAnalyzerV3`, and `TurnAnalyzerUserTurnStopStrategy` for non-Realtime mode |
| `RealtimeAudioLLMUserAggregator` wiring (l. 426-434) | Keep |
| Imports | Drop `RealtimeAudioOnlyS3TurnStopStrategy`; add `ExternalUserTurnStartStrategy` and the new Realtime stop strategy. Do **not** remove `VADUserTurnStartStrategy`, `S3SmartTurnAnalyzerV3`, `TurnAnalyzerUserTurnStopStrategy`, or `SileroVADAnalyzer` unless their non-Realtime uses are also removed |

### New environment variable

- `OPENAI_REALTIME_VAD_EAGERNESS` — `low` / `medium` / `high` / `auto`
  (default `medium`).

### Files that don't need changes

- `BusBridgeProcessor.fanout_frames` already includes `InterruptionFrame`,
  `BotStartedSpeakingFrame`, `BotStoppedSpeakingFrame` (`bot.py:645-650`). No
  additions needed for output-side fanout. `UserStartedSpeakingFrame` /
  `UserStoppedSpeakingFrame` now arrive from VoiceAgent via the bus and are
  pushed into the main pipeline by the bridge.
- `RealtimeFunctionResultRelay`, `build_realtime_output_mux`,
  `_RealtimeBypassRoute`, `_LocalTTSRoute`.
- `IdleReportProcessor` — depends on
  `UserStartedSpeakingFrame`/`BotStartedSpeakingFrame`/`BotStoppedSpeakingFrame`/`LLMFullResponseStartFrame`,
  all still flow.
- `TextInputBypassFirstBotMuteStrategy` — depends on `BotStoppedSpeakingFrame`
  from transport.output(), still flows through fanout.
- `VoiceAgent`'s `_handle_user_started_speaking` /
  `_handle_user_stopped_speaking` — same frame types, but this is no longer a
  "no change" path. Because semantic VAD frames originate inside VoiceAgent,
  VoiceAgent's pipeline-task upstream observer now sees spoken turns directly.
  This intentionally changes deferred-update drain state and must be covered by
  tests.
- `RTVIObserver` — same frame types should be emitted, but source timing
  changes. Keep the existing event-sequence manual check.

## Risks

### G1. Stock text-gated external stop would keep the local turn open too long

`external_user_turn_stop_strategy.py:131-133` waits for `_user_speaking=False`
*and* a final transcript *and* a 0.5 s "no new transcript" timer. That is unsafe
for Realtime semantic VAD because OpenAI transcription completions can arrive
after the next speech item has already started. Pipecat's `UserTurnController`
has one active-turn flag, so keeping turn A open while turn B starts means turn
B's start can be suppressed and text can merge into the wrong logical turn.

Mitigation: do not use stock `ExternalUserTurnStopStrategy` as the closure
authority in semantic VAD mode. Add a Realtime-specific external stop strategy
that triggers local turn stop immediately on `UserStoppedSpeakingFrame` with
`enable_user_speaking_frames=False`. Transcript timing then affects only when
the item-keyed Realtime aggregator inserts context, not whether
`UserTurnController` can accept the next semantic start. The Realtime aggregator
must also avoid stock empty aggregation emission on that immediate stop by
overriding `_maybe_emit_user_turn_stopped()`, not by trying to intercept the stop
strategy or controller callback itself.

### G2. `_handle_user_stopped_speaking` is unreachable in semantic VAD mode

`broadcast_frame` calls `push_frame` directly — it does not run through the
wrapper's `process_frame`. So the `UserStoppedSpeakingFrame` the wrapper
broadcasts never re-enters the wrapper. The existing
`_handle_user_stopped_speaking` block becomes dead code in semantic VAD mode.

Mitigation: drive `maybe_create_response` directly from an override of
`_handle_evt_speech_stopped`, not from `_handle_user_stopped_speaking`. Do not
call the parent `_handle_evt_speech_stopped`, because it starts metrics before
we know whether `maybe_create_response` will actually send `response.create`.
Treat `_handle_user_stopped_speaking` as a no-op when `turn_detection` is a
`SemanticTurnDetection` instance. If the speech-stopped trigger defers because
a response is already active, metrics start later when the deferred trigger
actually sends `response.create`.

### G3. Mute-during-greeting prevents barge-in on first bot speech

`TextInputBypassFirstBotMuteStrategy` returns muted until the first
`BotStoppedSpeakingFrame`, and the user_aggregator's `_maybe_mute_frame`
suppresses `InputAudioRawFrame` while muted (`llm_response_universal.py:597-610`).
That means audio doesn't reach OpenAI during the very first bot greeting, so
semantic VAD can't detect a barge-in.

Same behavior exists in cascade today; not a regression. Worth flagging in
the test plan ("user can interrupt second bot turn but not the first").

### G4. `eagerness` is coarser than S3's per-player tuning

S3SmartTurnAnalyzerV3 was constructed with `player_id`, suggesting per-player
calibration. OpenAI offers four global levels. Expect a different turn-boundary
feel from current production. Plan to gather user feedback after rollout and
expose the eagerness env var to tune as needed.

### G5. Late-arriving transcripts and overlapping items can corrupt context order

OpenAI emits `conversation.item.input_audio_transcription.completed` in
parallel with response generation and does not guarantee transcript completion
events arrive in conversational order. If transcription completes *after*
`response.done`, the assistant_aggregator may already have pushed the assistant
message. A normal append from the user_aggregator would produce
`[..., assistant, user]`, which is wrong.

The worse variant is overlapping item lifecycle: turn A stops, turn B starts,
and turn A's final transcript arrives while turn B is active. Stock
`LLMUserAggregator` has a single `_aggregation` buffer and stock
`UserTurnController` suppresses consecutive starts while one turn is open, so an
item-id insertion repair inside `push_aggregation()` is not enough. By the time
`push_aggregation()` runs, the text may already be merged with another item or
stranded outside any active local turn.

Mitigation: remove the current mirror-append behavior and do not feed Realtime
transcript frames into stock `_aggregation`. Instead,
`RealtimeAudioLLMUserAggregator` records user-start and user-stop state by
OpenAI Realtime `item_id`, using metadata propagated from
`input_audio_buffer.speech_started` / `speech_stopped`. Completed/failed
transcription events update the same item table. When an item has stopped and
has a final transcript/failure marker, finalize that item directly: resolve the
matching anchor, search forward from that anchor, and insert the user message
before the first later assistant message. If no later assistant exists, append
after any non-assistant mid-turn messages. This preserves
`[..., user, assistant]` even if assistant aggregation wins the race, without
using a stale raw index when `LLMMessagesAppendFrame(run_llm=False)` mutates
context mid-turn or when a newer user-start is observed before an older
transcript completes. The aggregator must track Realtime transcript `item_id`s
so duplicate completion/failure events are ignored. If a transcript arrives
without a matching item-id anchor, log a warning with the transcript item id
and the known anchor ids, then fall back to a normal append. Do not build a
secondary `input_audio_buffer.committed.previous_item_id` chain for the MVP;
add that only if fallback logs show missing anchors are common enough to need
recovery beyond log + append.

### G5b. Main context relay can duplicate `LLMMessagesAppendFrame` messages

`RealtimeMainContextRelay` runs before the main `user_aggregator` and calls
`insert_messages_from_append()` so Realtime sees context appends early. After
`_handle_context` has adopted the main `LLMContext`, the wrapper and the main
pipeline aggregators can be pointing at the same context object. If the relay
appends messages into that shared context and then lets the same frame continue,
stock `LLMUserAggregator._handle_llm_messages_append()` appends those messages
again. This is a pre-existing Phase 1 bug, not introduced by semantic VAD, so
the fix needs Phase 1 regression coverage as well as semantic-VAD coverage.

The same shared-context hazard exists for `source="voice-agent"` append frames
once the wrapper has adopted the main context. Those frames do not continue into
the main `user_aggregator`, but the wrapper pushes them downstream, VoiceAgent's
edge sink forwards them to the bus, the main bridge injects them into the output
branch, and the main `assistant_aggregator` also calls `add_messages()` on the
same shared context. So the guard cannot be main-pipeline-only.

Mitigation: make `insert_messages_from_append()` distinguish server-side
Realtime item creation from local context mutation, and track whether
`_handle_context` has adopted the shared main context (for example with an
explicit `_gradient_shared_context_adopted` flag). Set that flag in
`_handle_context` when adopting an incoming context object from an
`LLMContextFrame` (`self._context is not context` before assignment), and do not
toggle it back to false if a later context object is adopted. For any append
source, send the Realtime conversation items and update session instructions as
needed, but skip **every** local `context.add_message()` branch once the wrapper
is using the shared main context: system/developer messages, tool messages,
unsupported-role fallbacks, and user/assistant messages all need the same guard.
Keep local mutation only for wrapper-owned context before the first shared
`LLMContextFrame`, or replace it with an explicit pending-local-sync mechanism.
Do not gate `_gradient_seen_message_keys.add(...)`; that tracking records what
was sent toward Realtime and must keep updating even when local context mutation
is skipped.

Source decision: `source="main-pipeline"` is duplicate-safe because the same
frame continues into the main user aggregator. `source="voice-agent"` is
duplicate-safe for a different downstream writer: after shared-context adoption,
the same frame continues into the main assistant aggregator. Before shared
adoption, `source="voice-agent"` can still mutate the wrapper-owned context so
Realtime has current context until the first main context sync. Tests must cover
both `run_llm=True` and `run_llm=False` append frames, because `run_llm=False`
does not necessarily push an immediate `LLMContextFrame`.

### G6. Eagerness remains a tuning risk

Ship with `medium` rather than `auto` so turn boundaries do not change because
OpenAI adjusts server-side automatic behavior. If `medium` is too eager (cuts
user mid-thought) or too patient (long awkward silences), tune the explicit env
var to `low`, `high`, or `auto` after measuring behavior.

### G7. Audio buffer commit is no longer ours to control

Failure modes change. With Phase 1, an audio glitch that suppresses
`UserStoppedSpeakingFrame` from S3 means the buffer never commits and the
session stalls. With semantic VAD, OpenAI's own VAD has the same failure mode
on its side, and recovery options are different. Default recovery should be
reconnect/session reset or a tested silence-watchdog prototype; only send an
explicit client commit after verifying OpenAI's semantic VAD state machine
accepts that recovery path.

### G8. `_handle_context` still updates local context from user_aggregator
`LLMContextFrame`s

When the item-keyed Realtime user aggregator finalizes a completed/failed audio
item, it inserts the user message into the shared `LLMContext` and pushes an
`LLMContextFrame` downstream. It reaches the wrapper. `_handle_context` sets
`self._context = context` and runs
`_process_completed_function_calls(send_new_results=False)`. For a plain user
turn that's a no-op; for a turn that ended with a function call already
processed, it walks the (already-marked) tool-call IDs without sending anything
new. This remains correct only if the Realtime user aggregator pushes a context
frame from the item finalization path; the old mirror-only path would not.

### G8b. Immediate semantic stop and delayed user aggregation create a short state skew

The semantic `UserStoppedSpeakingFrame` clears VoiceAgent state and shared
gate state immediately. `RealtimeVoiceAgentInferenceGate` calls
`update_user_turn_active(False, clear_pending=True)` on that frame, while
VoiceAgent sets `_user_speaking=False` and `_awaiting_bot_reply=True`. The main
`user_aggregator` closes Pipecat's local turn immediately through the Realtime
stop strategy, but user-message context insertion still waits for final
transcription/failure for that specific OpenAI item.

Current local audit:

- `EventRelay._should_run_llm` does not read `_user_speaking`,
  `_awaiting_bot_reply`, or `_user_turn_active` directly; it decides whether an
  event wants inference from event config, recent request ids, task ownership,
  and combat scope.
- The shared `InferenceGateState` does read `_user_turn_active` via
  `can_run_now()`. In semantic VAD mode that state clears at OpenAI speech-stop,
  before final transcript context insertion. Spoken user turns still bypass this
  gate via `ignore_gate=True`; event/tool/text triggers still use it.
- VoiceAgent's deferred-update drain reads `_user_speaking` and
  `_awaiting_bot_reply`. The immediate stop clears `_user_speaking` but sets
  `_awaiting_bot_reply=True`, so deferred narration should remain blocked until
  the assistant cycle goes idle.

Mitigation: add a test for the gap between semantic `UserStoppedSpeakingFrame`
and final transcript aggregation. During that gap, event/tool triggers may be
queued by the shared gate, but deferred narration must not flush ahead of the
assistant reply, and no code should rely on user transcript content already
being present in context.

### G9. The shared gate is still bypassed for spoken user turns

`maybe_create_response("speech-stopped", ignore_gate=True)` intentionally
bypasses `InferenceGateState.can_run_now()` for user audio, matching Phase 1.
The wrapper still prevents concurrent Realtime responses via
`_gradient_response_active`; if a speech-stopped trigger arrives during an
active response, it requests deferred inference instead of starting metrics or
sending another `response.create`.

Mitigation: describe this as a single client-side response-create path, not a
single shared gate. Verify event/tool triggers still use the shared gate and
spoken user turns still get immediate response priority.

### G10. Input audio transcription failure can lose the failed item

`conversation.item.input_audio_transcription.failed` currently only logs. With
the item-keyed Realtime aggregator, local turn state closes from semantic stop,
but the context insertion path still needs a final state for the OpenAI item. If
failure is only logged, the item is never represented in local context and its
OpenAI item id/error are lost.

Mitigation: handle the failed event by pushing a final upstream
`TranscriptionFrame` with a local marker such as
`[voice input transcription failed]`, preserving the OpenAI item id/error in
metadata. The Realtime aggregator consumes it as that item's final state and
inserts one auditable synthetic user message at the matching anchor.

Decision for this phase: keep the marker approach because it gives downstream
systems an auditable placeholder without inventing a second context message
type. To keep the marker from becoming bad UX or polluting summaries, mark the
frame/context message with metadata such as
`openai_realtime_transcription_failed=True`, `synthetic=True`,
`openai_realtime_item_id=<item_id>`, and `openai_realtime_error=<error>`.
Downstream consumers must treat it specially:

- RTVI user-transcription emission should suppress the marker or present it as
  a styled local failure state, not as ordinary user speech.
- Context summarization/compaction should omit or summarize it as a technical
  transcription failure, not literal user intent.
- Voice-context upload (`context_upload`) and chat history/debug export should
  preserve the metadata so the failure is auditable without presenting the
  marker as normal player text.

### G11. Barge-in cancel/truncate races should be explicitly benign

On `speech_started`, the client calls `_truncate_current_audio_response`.
With `interrupt_response=True`, OpenAI may already have canceled the same
response server-side. Existing handling swallows known benign active-response
errors such as `response_cancel_not_active` and
`conversation_already_has_active_response`; implementation should verify the
actual truncate/cancel error codes observed during barge-in and extend the
non-fatal set only for confirmed benign cases.

## Implementation steps

1. Add env var and config plumbing for `OPENAI_REALTIME_VAD_EAGERNESS`.
2. Update `build_realtime_session_properties` to use `SemanticTurnDetection`
   with `create_response=False`, `interrupt_response=True`.
3. Override `_handle_evt_speech_started` in `GradientOpenAIRealtimeLLMService`
   without calling `super()`: inline `_truncate_current_audio_response()`,
   broadcast paired `UserStartedSpeakingFrame`s with OpenAI `item_id` and
   `audio_start_ms` metadata using fresh metadata dicts per copy, then call
   `broadcast_interruption()` so the existing process-task reset and
   `stop_all_metrics()` behavior is preserved.
4. Override `_handle_evt_speech_stopped` in `GradientOpenAIRealtimeLLMService`
   to directly broadcast `UserStoppedSpeakingFrame` and then call
   `maybe_create_response("speech-stopped", ignore_gate=True)`. Include OpenAI
   `item_id` and `audio_end_ms` metadata on the stop frames, with fresh
   metadata dicts per copy. Do not call the parent handler.
5. Adjust `_handle_user_stopped_speaking` to no-op when `turn_detection` is a
   `SemanticTurnDetection` instance (or any non-False value).
6. Rewrite `RealtimeAudioLLMUserAggregator` for semantic VAD:
   - consume Realtime final/interim transcription frames into an item-keyed table
     instead of stock `LLMUserAggregator` `_aggregation`;
   - record item-id keyed user-start insertion anchors from
     `UserStartedSpeakingFrame.metadata["openai_realtime_item_id"]`;
   - record item-id keyed semantic stops from
     `UserStoppedSpeakingFrame.metadata["openai_realtime_item_id"]`;
   - capture Realtime transcript/failure `item_id` from `frame.result`;
   - override `_maybe_emit_user_turn_stopped()` so immediate local stop closes
     `UserTurnController` state without emitting an empty stock
     `UserTurnStoppedMessage` when stock `push_aggregation()` returns `""`;
   - finalize each stopped+transcribed item directly by inserting the user
     message before the first later assistant message after the matching item-id
     anchor, with metadata and item-id dedupe;
   - remove unconditional mirror append.
7. Add explicit handling for
   `conversation.item.input_audio_transcription.failed`: push a final marker
   `TranscriptionFrame` upstream, preserve failure metadata, mark it synthetic
   / failed for downstream filters, and dedupe by OpenAI item id.
8. Make `insert_messages_from_append` / `RealtimeMainContextRelay`
   duplicate-safe when the wrapper and main pipeline share the same
   `LLMContext`: after shared-context adoption, do not locally append messages
   in any branch for either `source="main-pipeline"` or `source="voice-agent"`,
   while still sending Realtime conversation items/session updates promptly.
   Keep local mutation only while the wrapper still owns its private context.
   Continue updating `_gradient_seen_message_keys` regardless of whether local
   mutation is skipped.
9. Delete `RealtimeAudioOnlyS3TurnStopStrategy` and update imports without
   removing non-Realtime S3/Silero imports.
10. Switch `bot.py` realtime-mode user-aggregator config to
   `UserTurnStrategies(start=[ExternalUserTurnStartStrategy()],
   stop=[RealtimeSemanticUserTurnStopStrategy()])` and `vad_analyzer=None`.
11. Strip dead VAD frame branches from `RealtimeVoiceAgentInferenceGate`. Update
   `realtime_voice_agent_echo_exclude_frames` so `UserStartedSpeakingFrame`,
   `UserStoppedSpeakingFrame`, and `InterruptionFrame` cross the bus in
   semantic VAD mode; also remove the now-dead VAD frame exclusions.
12. Verify VoiceAgent spoken-turn observer side effects: user speech toggles
   `_user_speaking`, speech stop sets `_awaiting_bot_reply`, and deferred
   updates do not flush ahead of the user's reply.
13. Verify barge-in works end-to-end (G3 expected exception on first turn),
   including benign cancel/truncate races with `interrupt_response=True`.
14. Tune `eagerness` based on observed turn boundaries.

## Verification plan

Unit tests:

- `_handle_evt_speech_started` broadcasts `UserStartedSpeakingFrame` with
  `openai_realtime_item_id` and `openai_realtime_audio_start_ms` metadata, and
  still truncates current audio plus broadcasts interruption. The upstream and
  downstream broadcast copies have equal metadata values but do not share the
  same metadata dict object.
- `_handle_evt_speech_stopped` override calls `maybe_create_response` exactly
  once with `ignore_gate=True`, broadcasts `UserStoppedSpeakingFrame` with
  `openai_realtime_item_id` and `openai_realtime_audio_end_ms` metadata, and
  does not call the parent metrics-start path. The stop-frame broadcast copies
  also do not share metadata dict objects.
- If `_handle_evt_speech_stopped` defers because a response is active, metrics
  are not started at speech-stopped time and do start when the deferred trigger
  later sends `response.create`.
- `_handle_user_stopped_speaking` is a no-op when `turn_detection` is a
  `SemanticTurnDetection` instance.
- `RealtimeSemanticUserTurnStopStrategy` triggers local user_turn_stopped
  immediately on `UserStoppedSpeakingFrame` with
  `enable_user_speaking_frames=False`, and does not wait for transcript text or
  inherit the stock external stop strategy's 0.5 s timer.
- The Realtime aggregator's immediate-stop path closes local controller state
  through an `_maybe_emit_user_turn_stopped()` override without emitting an empty
  stock `UserTurnStoppedMessage`; any content-bearing user-turn-stopped callback
  is tied to item finalization.
- `conversation.item.input_audio_transcription.failed` produces a final marker
  `TranscriptionFrame`, lets the item-keyed Realtime aggregator finalize that
  item, and dedupes repeated failed events for the same item id. It does not rely
  on the generic user-turn 5 s timeout and does not push an empty context turn
  first.
- `RealtimeAudioLLMUserAggregator` consumes final/interim Realtime transcript
  frames into per-item state; the old mirror-only path and stock single-buffer
  transcript path are both gone for Realtime audio items.
- If assistant aggregation happens before final input transcription,
  `RealtimeAudioLLMUserAggregator` item finalization inserts the user message
  before that assistant message and does not duplicate the transcript.
- If two OpenAI user items complete transcription out of order, each transcript
  resolves by its own `item_id` and uses its own recorded anchor; a late turn A
  completion cannot insert using turn B's anchor and cannot merge text with turn
  B's transcript.
- If `speech_started`, `speech_stopped`, and transcription events carry
  mismatched item ids for what appears to be one turn, the aggregator logs the
  mismatch and uses the missing-anchor fallback rather than corrupting message
  order.
- If `LLMMessagesAppendFrame(run_llm=False)` mutates context after
  user-start but before input transcription completes, the user message still
  inserts before the first later assistant message rather than at a stale raw
  index.
- Duplicate `conversation.item.input_audio_transcription.completed` events with
  the same `item_id` do not add duplicate user context messages.
- `RealtimeMainContextRelay` / `insert_messages_from_append` sends Realtime
  conversation items without duplicating the same `LLMMessagesAppendFrame`
  messages in local context when the wrapper and main pipeline share the same
  `LLMContext`. Cover system/developer, tool, unsupported-role fallback, and
  user/assistant branches; cover both `run_llm=True` and `run_llm=False`; cover
  both semantic-VAD and existing Phase 1 realtime mode.
- `source="voice-agent"` append frames still mutate wrapper-owned context exactly
  once before shared-context adoption, but after shared-context adoption they skip
  local `context.add_message()` and rely on the downstream main
  assistant_aggregator to add the message exactly once.
- A VoiceAgent-origin `LLMMessagesAppendFrame` crossing
  `_BusEdgeProcessor` → main `BusBridgeProcessor` → assistant_aggregator does not
  duplicate messages in the shared `LLMContext` after the wrapper has adopted it.
- `_gradient_seen_message_keys` continues updating for append messages
  post-adoption even when local `context.add_message()` is skipped.
- `LLMContextFrame` from the user_aggregator does not re-trigger
  `response.create` in the wrapper (i.e., the wrapper's `_gradient_response_active`
  guard works for the second-trigger case).
- `RealtimeVoiceAgentInferenceGate` receives semantic `UserStartedSpeakingFrame`
  / `UserStoppedSpeakingFrame` from the Realtime LLM service and updates shared
  user-turn state without relying on VAD frame branches.
- `realtime_voice_agent_echo_exclude_frames()` does not exclude
  `UserStartedSpeakingFrame`, `UserStoppedSpeakingFrame`, or
  `InterruptionFrame` in semantic VAD mode, and those frames reach the main
  pipeline exactly once from VoiceAgent with no bus rebroadcast loop.
- A realistic VoiceAgent `_BusEdgeProcessor` → main `BusBridgeProcessor` test
  proves semantic `UserStartedSpeakingFrame`, `UserStoppedSpeakingFrame`, and
  `InterruptionFrame` reach the main user/output branch exactly once.
- During the gap between semantic `UserStoppedSpeakingFrame` and final
  transcript aggregation, VoiceAgent deferred updates remain blocked by
  `_awaiting_bot_reply`, event/tool triggers do not run ahead of the assistant
  reply, and code that needs user content waits for the delayed user-aggregator
  close.
- After removing VAD frame branches, `_user_audio_active` /
  `update_user_audio_active` has no remaining required Realtime caller; remove
  or leave only if another current caller is verified.
- Non-Realtime mode still constructs `SileroVADAnalyzer`,
  `S3SmartTurnAnalyzerV3`, `VADUserTurnStartStrategy`, and
  `TurnAnalyzerUserTurnStopStrategy`.

Manual / integration:

- User completes a turn, bot responds with audio. Local context ends with
  `[..., user, assistant]` in that order.
- Force a delayed input-transcription completion after `response.done`; local
  context is repaired to `[..., user, assistant]` and contains only one user
  message for the OpenAI item.
- Force two user turns where turn B starts before turn A's transcription
  completes, then complete the transcriptions out of order; local context uses
  each completion's OpenAI item id to place the right user message at the right
  turn boundary, with no merged or stranded transcript text.
- Append a system/personality or event message with `run_llm=False` while the
  wrapper has adopted the main context; local context contains the append once,
  and Realtime still receives the conversation/session update.
- User starts speaking mid-bot-response: bot audio cuts off cleanly within
  expected latency, OpenAI cancels server-side, new user turn opens.
- Barge-in logs no fatal Realtime errors. Any cancel/truncate races caused by
  `interrupt_response=True` are confirmed benign and either swallowed or logged
  at debug level only.
- Force `conversation.item.input_audio_transcription.failed`: local user turn
  closes with the synthetic failed-transcription marker and the next user turn
  starts fresh. RTVI/chat history do not present the marker as ordinary user
  speech, context upload preserves failure metadata, and summarization does not
  treat it as player intent.
- Game event with `run_llm=True` arrives during bot speech: queued via
  `RealtimeVoiceAgentInferenceGate`, fires after bot finishes — no
  `conversation_already_has_active_response`.
- Function-call result with `run_llm=False` (deferred) is sent as
  `function_call_output` but does not produce a duplicate `response.create`
  later.
- Eagerness tuning: try `low`, `medium`, `high`, `auto` and record subjective
  turn-boundary feel.
- Barge-in does NOT work during the first bot greeting (expected, G3).
- Barge-in DOES work on the second and subsequent bot turns.
- Long silence with no speech: session stays alive (OpenAI doesn't terminate
  the websocket on idle audio buffer).
- RTVI client receives the same event sequence it received under cascade and
  Phase 1 (user-started, user-stopped, user-transcription, bot-llm-started,
  bot-llm-text, bot-tts-started, bot-speaking, bot-tts-stopped, bot-speaking,
  bot-llm-stopped).

## Out of scope for this phase

- Compaction (still Phase 2 work as described in the original Phase 1 plan).
- Replacing `eagerness` with a per-player tunable equivalent of S3.
- Removing `RealtimeAudioLLMUserAggregator` entirely. In semantic VAD mode it
  now owns transcript ordering repair; removal requires replacing that behavior
  with another authoritative local-context ordering strategy.
- Switching off `RealtimeMainContextRelay` / `RealtimeFunctionResultRelay`.
  These remain necessary independent of turn detection.
