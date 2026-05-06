# OpenAI Realtime Phase 1 Plan

Date: 2026-05-05

## Goal

Add an `openai-realtime-mode` path for the voice agent using Pipecat's
`OpenAIRealtimeLLMService`, with OpenAI Realtime handling speech-to-speech
generation and input transcription while Gradient Bang keeps its existing
Silero/S3 turn timing as the authority.

Phase 1 intentionally does not implement compaction. When OpenAI Realtime mode
is enabled, context compaction and automatic summarization should be disabled or
bypassed.

## Decisions

- Use `gpt-realtime-1.5` as the default OpenAI Realtime model. Keep this
  configurable, for example `OPENAI_REALTIME_MODEL`, because Realtime model names
  move quickly.
- Disable OpenAI Realtime turn detection with `audio.input.turn_detection=False`.
  Pipecat's Realtime event model supports this and serializes it to JSON `null`
  for `session.update`.
- Keep local Silero/S3 as the turn authority.
- Use OpenAI Realtime input transcription instead of Deepgram in this mode.
- Keep local transport/VAD input at 16 kHz PCM16 mono for Silero/S3, and
  resample to 24 kHz PCM16 mono inside the Realtime service before
  `input_audio_buffer.append`. Keep Realtime output at 24 kHz.
- Treat remote conversation synchronization and inference triggering as
  separate behaviors. A frame can add model-visible history without causing
  `response.create`.
- Support both model-visible input paths that exist in Gradient Bang today:
  direct frames queued into `VoiceAgent`, and frames queued onto the main
  `PipelineTask` that are consumed by the user aggregator before the bridge.
- Gate direct `VoiceAgent` `run_llm` triggers in Realtime mode. Direct frames
  from `EventRelay` and `VoiceAgent._inject_context()` do not pass through the
  main `PreLLMInferenceGate`.
- Suppress Realtime input/control frame echoes after the Realtime service has
  handled them. Input audio and local turn-control frames should not bounce back
  through the bridge into the main output branch.
- Route Realtime audio output around the local Cartesia TTS serialization queue.
  Cartesia stays available for explicit local TTS paths such as `say-text`.
- Use an audio-only Silero/S3 turn-stop strategy in Realtime mode. Do not wait
  for Realtime transcription to stop the Pipecat user turn; Realtime
  transcription is a transcript/context mirror signal, not the turn authority.
- Keep local Cartesia TTS available for explicit `TTSSpeakFrame` paths such as
  `say-text`, but prevent it from resynthesizing normal Realtime assistant text.
- Do not add a general outbound queue for Realtime websocket-not-ready cases in
  Phase 1. If a Realtime client event would be dropped because there is no
  websocket, log a `DEBUG` line with enough detail to identify the dropped event
  and source frame.

## Current Pipeline Shape

Main pipeline in `src/gradientbang/pipecat_server/bot.py`:

```text
transport.input()
-> stt
-> idle_report_processor
-> pre_llm_gate
-> user_aggregator
-> ParallelPipeline(
     [
       bridge,
       post_llm_gate,
       token_usage_metrics,
       say_text_voice_guard,
       tts,
       transport.output(),
       assistant_aggregator,
     ],
     ui_branch,
   )
```

The player voice agent is bridged:

```text
VoiceAgent pipeline:
  EdgeSource
  -> LLM service
  -> EdgeSink
```

`VoiceAgent` is constructed with `bridged=()`, so its edge processors accept
frames from the main bridge while the agent is active.

## Frame Flow Audit

The expected bus/bridge flow is valid, with these required Realtime-mode
corrections:

- replace local TTS on the normal Realtime output path with an ordering-preserving
  Realtime output mux, while keeping Cartesia available for explicit local
  `TTSSpeakFrame` paths;
- suppress input/control frame echoes after the Realtime service handles them;
- gate direct `VoiceAgent` `LLMMessagesAppendFrame(run_llm=True)` and
  `LLMRunFrame` triggers before they reach Realtime;
- relay main-pipeline context append/run frames before `user_aggregator`
  consumes them;
- relay function-call outputs to the Realtime session even when
  `run_llm=False`;
- fan out interruptions to both the Realtime service and the local output branch
  so queued output audio is cleared;
- use a concrete remote-insertion ledger so direct append frames, main-pipeline
  append frames, and later context mirror frames cannot duplicate Realtime
  conversation items;
- split inference-gate user audio activity from logical user-turn response
  semantics so deferred direct runs are not accidentally lost.

## Audio Sample Rate

This is a Phase 1 blocker, but the invariant is split by boundary:

- local capture, Silero VAD, and S3/SmartTurn input stay at 16 kHz, because
  Silero only accepts 8 kHz or 16 kHz;
- OpenAI Realtime input and output stay at 24 kHz PCM16 mono, because the
  Realtime service and its truncation timing assume 24 kHz audio.

Gradient Bang must therefore not forward local `InputAudioRawFrame.audio` bytes
to `input_audio_buffer.append` blindly. In Realtime mode the wrapper must
resample local 16 kHz mono PCM to 24 kHz mono PCM before sending it to OpenAI.
Realtime output remains 24 kHz and is sent to the transport output path at that
rate.

```python
OPENAI_REALTIME_SAMPLE_RATE = 24000
OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE = 16000

DailyParams(
    audio_in_enabled=True,
    audio_out_enabled=True,
    audio_in_sample_rate=OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE,
    audio_out_sample_rate=OPENAI_REALTIME_SAMPLE_RATE,
    audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
)

TransportParams(
    audio_in_enabled=True,
    audio_out_enabled=True,
    audio_in_sample_rate=OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE,
    audio_out_sample_rate=OPENAI_REALTIME_SAMPLE_RATE,
    audio_in_filter=(KrispVivaFilter() if os.getenv("BOT_USE_KRISP") else None),
)
```

The main `PipelineTask` must also use the same value:

```python
PipelineParams(
    audio_in_sample_rate=OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE,
    audio_out_sample_rate=OPENAI_REALTIME_SAMPLE_RATE,
    enable_metrics=True,
    enable_usage_metrics=True,
)
```

The `VoiceAgent` pipeline task should use the same split values because its
Realtime LLM service receives its own `StartFrame`. The wrapper should accept
16 kHz `InputAudioRawFrame` instances from the bridge, resample them to 24 kHz,
and send only 24 kHz audio to OpenAI.

### Main to VoiceAgent

Downstream frames from the main pipeline reach the `BusBridgeProcessor` after
`user_aggregator`. The bridge sends non-lifecycle frames to the bus and does not
push them farther down the local branch.

The active `VoiceAgent` has an `EdgeSource` configured for upstream capture, so
it accepts bus frames whose direction is not upstream. Main downstream frames
therefore enter the top of the voice agent pipeline and reach the Realtime LLM
service.

This is the path for:

- `InputAudioRawFrame`
- `UserStartedSpeakingFrame`
- `UserStoppedSpeakingFrame`
- `InterruptionFrame`
- `LLMMessagesAppendFrame`
- `LLMRunFrame`
- `LLMSetToolsFrame`

### VoiceAgent to Main Transport Output

Downstream frames emitted by the Realtime service reach the voice agent
`EdgeSink`. The sink forwards those frames to the bus with their original
downstream direction.

The main `BusBridgeProcessor` receives those bus frames and pushes them into the
main branch at the bridge position with the same downstream direction. They then
continue through:

```text
post_llm_gate
-> token_usage_metrics
-> say_text_voice_guard
-> realtime_output_mux
-> transport.output()
-> assistant_aggregator
```

So yes: Realtime audio frames from `VoiceAgent`, specifically `TTSAudioRawFrame`,
can make it through the bridge and into `transport.output()`.

The correction is that local Cartesia TTS must not process normal Realtime
assistant output. The Realtime service emits:

- `LLMTextFrame` for RTVI bot LLM text events, with `append_to_context=False`
- `TTSTextFrame` for bot transcript/assistant aggregation
- `TTSAudioRawFrame` for actual audio playback
- `TTSStartedFrame` and `TTSStoppedFrame`
- `LLMFullResponseStartFrame` and `LLMFullResponseEndFrame`

Do not solve this by setting `skip_tts=True` on Realtime `TTSTextFrame`.
`TTSService.process_frame()` immediately pushes `TextFrame` instances with
`skip_tts=True`, while non-text Realtime audio/lifecycle frames go through the
TTS serialization queue. That can let transcript chunks overtake audio chunks.

In Realtime mode, replace the normal Cartesia TTS position in the main output
branch with an ordering-preserving `RealtimeOutputMux`:

- Realtime-originated `LLMFullResponseStartFrame`, `LLMTextFrame`,
  `TTSTextFrame`, `TTSStartedFrame`, `TTSAudioRawFrame`, `TTSStoppedFrame`, and
  `LLMFullResponseEndFrame` pass through in their original order. They must not
  enter Cartesia's text synthesis path or TTS serialization queue.
- Local explicit TTS paths, especially `TTSSpeakFrame` from `say-text`, still
  delegate to Cartesia and preserve the current local TTS behavior.
- If a frame is ambiguous, prefer preserving normal local Cartesia behavior
  unless it is known to be emitted by `GradientOpenAIRealtimeLLMService`.

Do not drop Realtime text frames. RTVI and `assistant_aggregator` still need to
see them.

If Phase 1 needs tighter RTVI `BotTTSStarted` timing than the stock Realtime
frames provide, `GradientOpenAIRealtimeLLMService` should emit internal
Realtime-output frames and let `RealtimeOutputMux` convert them into standard
Pipecat TTS frames immediately before `transport.output()`. That avoids RTVI
observing a standard `TTSStartedFrame` too early at the bridge. If we keep the
stock Realtime `TTSStartedFrame`, document it as "Realtime audio stream started"
rather than "audible playback started"; use `BotStartedSpeakingFrame` for actual
playback state.

Do not rely only on `push_silence_after_stop=False`. That is the current
`TTSService` default and Gradient Bang does not override it, but the output mux
keeps Realtime audio latency lower and prevents future TTS config changes from
injecting local silence after Realtime audio. `transport.output()` will generate
the usual `BotStartedSpeakingFrame` and `BotStoppedSpeakingFrame` from output
audio playback.

### Realtime Transcription Back To Gradient Bang

OpenAI Realtime transcription frames are emitted by the Realtime service
upstream:

- `InterimTranscriptionFrame`
- `TranscriptionFrame`

The voice agent `EdgeSource` captures upstream frames and sends them to the bus.
The main bridge pushes them upstream from the bridge position, so they travel
back into the main pipeline. The `RTVIObserver` also sees these frames and can
emit user transcription events to the client.

Pipecat's current Realtime completed-transcription handler emits
`TranscriptionFrame` without `finalized=True`. Phase 1 must fix that in
`GradientOpenAIRealtimeLLMService`. Prefer setting `finalized=True` on the frame
emitted from the wrapper so downstream code can use normal Pipecat semantics.

Do not let the stock user aggregator aggregate these late Realtime transcripts
as normal turn text. In the audio-only Realtime turn design below, the logical
Pipecat user turn has already stopped by the time the Realtime transcript
usually arrives. If the stock aggregator appends that transcript to its internal
aggregation after the turn is closed, the transcript can leak into the next user
turn.

Phase 1 should use an explicit Realtime transcript mirror:

- Realtime final transcripts remain client-visible RTVI transcription frames.
- Realtime final transcripts may update local `LLMContext` as a mirror for
  debugging, context dumps, and eventual Phase 2 compaction.
- Realtime final transcripts must not create a second Realtime user text item.
  The server-side Realtime conversation already contains the committed input
  audio item for the spoken turn.
- Realtime final transcripts must not trigger inference. The response was
  already triggered by the local `UserStoppedSpeakingFrame` / Realtime
  `input_audio_buffer.commit` path.
- The mirror should use the Realtime `item_id` from
  `conversation.item.input_audio_transcription.completed` when available. If a
  local placeholder exists for that audio turn, update it; otherwise append a
  best-effort local user transcript message without pushing an LLM run.

This is a deliberate server-side context strategy: do not echo OpenAI's final
transcript back into OpenAI as a new user text item. The remote Realtime
conversation already has the committed input-audio item. If OpenAI's ASR text
and the local transcript mirror differ, the remote conversation remains the
source of truth for model inference in Phase 1.

Known UX divergence from the Deepgram cascade: the client should not expect
live interim user transcription while the player is speaking. With OpenAI
Realtime transcription and local `turn_detection=False`, useful input
transcription arrives after local S3 commits the input audio buffer. The client
will usually see a late final transcript, and possibly late deltas, rather than
Deepgram-style live partials during speech.

## Input Echo Suppression

Pipecat's base `OpenAIRealtimeLLMService.process_frame()` handles input/control
frames and then pushes the same frame onward. In the bridged voice-agent
pipeline, that means local input frames can bounce back:

```text
main downstream InputAudioRawFrame
-> bridge
-> VoiceAgent EdgeSource
-> GradientOpenAIRealtimeLLMService sends audio to Realtime
-> same InputAudioRawFrame continues downstream
-> VoiceAgent EdgeSink
-> bus
-> main bridge
-> local output branch
```

`transport.output()` ignores `InputAudioRawFrame`, so this is not audible echo,
but it is wasted work and can route high-frequency audio frames through local
processors that should not be on the input path.

Phase 1 should explicitly suppress these echoes. Preferred implementation:
configure the Realtime `VoiceAgent` edge sink, or the Realtime wrapper, so these
downstream frames do not return to the main branch after the Realtime service
has handled them:

- `InputAudioRawFrame`
- `UserStartedSpeakingFrame`
- `UserStoppedSpeakingFrame`
- `UserSpeakingFrame`
- `VADUserStartedSpeakingFrame`
- `VADUserStoppedSpeakingFrame`
- `InterruptionFrame`

This suppression must be direction/source-aware. Suppress local downstream input
and control frames after the Realtime service consumes them. Do not globally
drop every frame of these types, because upstream server-originated control
frames or future Realtime interruption frames may still be needed by observers or
other processors.

Interruption needs an extra fanout rule. In the current bridge implementation,
non-lifecycle frames sent downstream into `BusBridgeProcessor` are sent to the
bus and not pushed locally into the rest of the main output branch. In Realtime
mode, a local interruption must reach both:

- the Realtime service, so it can send `input_audio_buffer.clear` and
  `response.cancel`;
- the local output branch, especially `RealtimeOutputMux` and
  `transport.output()`, so already-queued audio is cleared and local Cartesia
  state for explicit `TTSSpeakFrame` paths is reset.

Implement this by making the Realtime main bridge pass `InterruptionFrame`
locally while also sending it to the bus, or by adding an explicit interruption
fanout processor before the bridge. Continue suppressing the returned
VoiceAgent-side interruption echo so the output branch does not see duplicates.

Do not suppress `BotStartedSpeakingFrame` or `BotStoppedSpeakingFrame` this way.
Those frames are part of the existing bot-speaking lifecycle. In the current
bridged topology, upstream bot-speaking frames from `transport.output()` can
make a round trip through the active voice agent and return to the main bridge,
where `user_aggregator`, mute handling, and observers may see them. Phase 1
should preserve that behavior and test it after adding echo suppression.

## Realtime User Turn Strategy

The existing `TurnAnalyzerUserTurnStopStrategy` uses S3 to decide end of turn,
but it only triggers user-turn stop after it has transcription text. That is
correct for the current Deepgram cascade because Deepgram final transcripts are
already available before or around S3 stop.

With OpenAI Realtime transcription, that creates a loop:

```text
Realtime final transcript requires input_audio_buffer.commit
input_audio_buffer.commit is sent on UserStoppedSpeakingFrame
current S3 strategy waits for final transcript before UserStoppedSpeakingFrame
```

Phase 1 should use an audio-only S3 stop strategy modeled on
`../nemotron-nano-omni/src/nemotron_voice/bot.py`'s
`AudioOnlySmartTurnStopStrategy`:

```text
RealtimeAudioOnlyS3TurnStopStrategy
  uses StartFrame to set the S3/SmartTurn sample rate
  consumes VADUserStartedSpeakingFrame and VADUserStoppedSpeakingFrame
  appends InputAudioRawFrame bytes to S3SmartTurnAnalyzerV3
  on VAD stop, asks S3/SmartTurn whether the turn is complete
  if complete, calls trigger_user_turn_stopped() immediately
  does not inspect TranscriptionFrame
  does not wait for Realtime final transcription
```

Important details:

- Let the user aggregator emit the one logical `UserStoppedSpeakingFrame`. Do not
  manually broadcast one frame and then later trigger a second logical stop.
- That single `UserStoppedSpeakingFrame` is the Realtime commit signal. Pipecat's
  Realtime service sends `input_audio_buffer.commit` and `response.create` when
  `turn_detection=False`.
- Do not use the parent `_maybe_trigger_user_turn_stopped()` unchanged. The
  parent requires both transcription text and `_turn_complete`, which is the
  dependency loop we are breaking.
- Do not use `TranscriptionUserTurnStartStrategy` in Realtime mode. Late Realtime
  final transcripts must not start a new fake user turn after the audio-only turn
  has already stopped.
- `reset()` must clear only the audio-turn strategy state: VAD speaking state,
  accumulated analyzer audio, S3/SmartTurn completion state, and any pending
  metrics. It should not maintain transcript-wait state.
- If S3 says incomplete, do not stop the logical user turn and do not commit the
  Realtime audio buffer yet. Normal user-turn timeout behavior can still act as a
  fallback if configured.

The Realtime mode user aggregator config should keep Silero, use VAD-only start,
and replace the stop strategy:

```python
user_turn_strategies=UserTurnStrategies(
    start=[VADUserTurnStartStrategy()],
    stop=[
        RealtimeAudioOnlyS3TurnStopStrategy(
            turn_analyzer=S3SmartTurnAnalyzerV3(player_id=character_id),
        )
    ],
),
vad_analyzer=SileroVADAnalyzer(),
```

Do not switch to `ExternalUserTurnStrategies` for this mode. We are not asking
OpenAI to provide the turn lifecycle; we are asking local Silero/S3 to provide
it.

Use a Realtime-specific user aggregator or transcript processor so late Realtime
transcripts do not leak into the next local user turn. Two acceptable
implementation shapes:

1. Subclass `LLMUserAggregator` as `RealtimeAudioLLMUserAggregator` and override
   `_handle_transcription()` to avoid normal aggregation. The override forwards
   transcript information to a Realtime transcript mirror instead of appending to
   `_aggregation`.
2. Add a small processor immediately upstream of the user aggregator that handles
   Realtime transcription frames and prevents them from entering the stock
   aggregation path.

The mirror can create a local placeholder user message when the audio turn is
committed and update it when the final Realtime transcript arrives. This keeps
local context ordering closer to:

```text
user audio turn placeholder -> assistant response
```

instead of appending the transcript after the assistant response. This local
mirror must never send a new Realtime `conversation.item.create` for the same
spoken turn.

If placeholder ordering is implemented, the wrapper needs to handle Realtime's
`input_audio_buffer.committed` server event and associate its `item_id` with the
current local audio turn. Pipecat's base Realtime receive loop currently parses
that event type but does not dispatch a handler for it.

## Realtime Service Configuration

Use Pipecat's current non-beta service:

```python
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.services.openai.realtime.events import (
    AudioConfiguration,
    AudioInput,
    AudioOutput,
    InputAudioTranscription,
    PCMAudioFormat,
    SessionProperties,
)

llm = OpenAIRealtimeLLMService(
    api_key=os.environ["OPENAI_API_KEY"],
    model=os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-1.5"),
    session_properties=SessionProperties(
        output_modalities=["audio"],
        audio=AudioConfiguration(
            input=AudioInput(
                format=PCMAudioFormat(rate=24000),
                transcription=InputAudioTranscription(
                    model=os.getenv(
                        "OPENAI_REALTIME_TRANSCRIPTION_MODEL",
                        "gpt-4o-transcribe",
                    ),
                    language=language,
                ),
                turn_detection=False,
            ),
            output=AudioOutput(
                format=PCMAudioFormat(rate=24000),
                voice=os.getenv("OPENAI_REALTIME_VOICE", "marin"),
            ),
        ),
    ),
)
```

Pipecat's service already handles `turn_detection is False` this way:

- On `UserStoppedSpeakingFrame`: send `input_audio_buffer.commit` and
  `response.create`.
- On interruption: send `input_audio_buffer.clear` and `response.cancel`.

## Target Realtime Pipeline Shape

In OpenAI Realtime mode, remove or bypass the standalone STT service. Raw input
audio must still reach both the local user aggregator and the Realtime service.

Target main pipeline:

```text
transport.input()
-> idle_report_processor
-> pre_llm_gate
-> realtime_main_context_relay
-> realtime_user_aggregator
-> ParallelPipeline(
     [
       bridge,
       post_llm_gate,
       realtime_function_result_relay,
       token_usage_metrics,
       say_text_voice_guard,
       realtime_output_mux,
       transport.output(),
       assistant_aggregator,
     ],
     ui_branch,
   )
```

Local TTS remains available inside `realtime_output_mux` for explicit
`TTSSpeakFrame` use cases. Normal Realtime assistant speech is already audio and
must bypass Cartesia's text synthesis and serialization queue while preserving
Realtime text/audio/lifecycle ordering.

`realtime_user_aggregator` is not the stock Deepgram-era user aggregator. It is
configured with VAD-only turn start, `RealtimeAudioOnlyS3TurnStopStrategy`, and
Realtime transcript mirroring so late Realtime transcripts do not remain in the
normal aggregation buffer.

Target voice agent pipeline:

```text
VoiceAgent EdgeSource
-> realtime_voice_agent_inference_gate
-> GradientOpenAIRealtimeLLMService
-> VoiceAgent EdgeSink
```

`GradientOpenAIRealtimeLLMService` can be a small subclass/wrapper around
`OpenAIRealtimeLLMService` to cover Gradient Bang's missing behaviors.

## Game Events And run_llm

All game events should continue to be represented as
`LLMMessagesAppendFrame(messages=[...], run_llm=...)`, but Phase 1 must support
both routes by which those frames can reach the model:

1. Direct voice-agent route. `EventRelay`, `VoiceAgent._inject_context()`, and
   activation code can queue frames into `VoiceAgent`. Those frames enter the
   voice-agent pipeline. In Realtime mode they must pass through
   `RealtimeVoiceAgentInferenceGate` before hitting
   `GradientOpenAIRealtimeLLMService` as `LLMMessagesAppendFrame`.
2. Main-pipeline route. `ClientMessageHandler` can queue
   `LLMMessagesAppendFrame` onto the main `PipelineTask`. Those frames reach
   `user_aggregator`, where Pipecat consumes them, mutates local context, and
   only emits an `LLMContextFrame` when `run_llm=True`. The original append frame
   does not reach the bridge or Realtime service.

Current Pipecat Realtime service has a stub for `LLMMessagesAppendFrame`, so
Phase 1 needs a wrapper/subclass that implements it:

- `run_llm=False`: create a Realtime conversation item only. Do not call
  `response.create`.
- `run_llm=True`: create the conversation item, then call `response.create`
  unless the inference gate has changed the frame to `run_llm=False`.
- `LLMRunFrame`: call `response.create` against the current Realtime
  conversation state after the appropriate Realtime gate permits the run.
- `LLMSetToolsFrame`: update the wrapper's cached tools and then update the
  Realtime session tools. Pipecat's base Realtime handler sends a session update
  here, but Phase 1 should not assume that is enough; the Gradient wrapper
  should explicitly store `frame.tools` before sending.

Message mapping:

- System/developer-style activation messages should update Realtime session
  instructions via `session.update`.
- Non-system activation messages, including `<start_of_session>`, should be
  inserted as Realtime conversation message items in order.
- Player text, idle prompts, and game `<event>` payloads should be inserted as
  user-role Realtime message items with text content. They are model-visible
  context from the player/game side, not new system instructions.

Tool update behavior:

- Activation queues `LLMSetToolsFrame` directly into `VoiceAgent`.
- Other tool-change paths can flow through the universal user aggregator, which
  consumes and re-pushes `LLMSetToolsFrame` downstream for speech-to-speech
  services.
- `GradientOpenAIRealtimeLLMService` should treat repeated tool frames as
  idempotent: cache the latest `ToolsSchema`, convert it to Realtime's expected
  tool format, and send `session.update` when the websocket/session is ready.
- Cache the latest desired tools and instructions as local service state.
  `session.created` should send the current desired session state. Phase 1 does
  not need a general outbound queue for every conversation item or response
  request that arrives before the websocket exists.

## WebSocket Readiness And Dropped Event Logging

Do not build a general pending-outbound queue in Phase 1. The Realtime service
should be connected before normal conversation traffic, and if that assumption is
wrong we want logs before adding recovery machinery.

`GradientOpenAIRealtimeLLMService` should override or wrap the lowest send path
used by all custom Realtime client events. If there is no websocket, or the
service is disconnecting, log a `DEBUG` line and drop the event.

The log line should include:

- Realtime client event type, for example `conversation.item.create`,
  `response.create`, `input_audio_buffer.append`, or `session.update`;
- source path, for example `direct_append`, `main_context_relay`,
  `function_result_relay`, `audio_input`, or `session_update`;
- source Pipecat frame id/name when available;
- Realtime item id or tool call id when available.

This applies to message inserts, function-call outputs, explicit
`response.create`, audio appends, and session updates. The base
`_create_response()` already defers on `_api_session_ready`; the Gradient wrapper
should still log any custom send that reaches the websocket layer without a
websocket. If these DEBUG drops appear in practice, websocket readiness and
replay become a Phase 1 follow-up or Phase 2 item.

## Remote Insertion Ledger

Duplicate suppression must be specified concretely. Do not use role/content
hashes as the only identity: repeated identical game events or repeated typed
messages can be legitimate separate conversation items.

`GradientOpenAIRealtimeLLMService` should own a small append ledger used by both
the direct wrapper path and `RealtimeMainContextRelay`:

- For every `LLMMessagesAppendFrame`, assign per-message insertion keys from the
  frame identity and message index, for example `(frame.id, index)`.
- Generate the Realtime `ConversationItem.id` before sending
  `conversation.item.create`, and store the mapping from insertion key to item id.
- Also store a mirror key based on the Python message object identity plus a
  structural digest, for example `(id(message), digest(role/content))`. This is a
  guard for later `LLMContextFrame` mirror checks. The digest is not used alone.
- Do not mutate LLM message dicts with non-standard keys unless every outbound
  adapter strips those keys. A service-owned ledger is safer for Phase 1.
- Mark generated item ids in Pipecat's `_messages_added_manually` map before
  sending so `conversation.item.added` echoes for manually-created items do not
  produce duplicate assistant/user handling.
- If the same append frame is accidentally observed twice, the `(frame.id,
  index)` key suppresses the duplicate remote insert.
- If a later `LLMContextFrame` contains a message object already present in the
  mirror ledger, treat it as local context mirror only. Do not call
  `conversation.item.create` and do not call `response.create`.
- If a later `LLMContextFrame` contains a spoken-turn transcript, do not insert it
  as a user text item. The server-side Realtime conversation already has the
  committed input-audio item.

The direct and main paths should call the same service method, for example:

```text
insert_messages_from_append(frame, source) -> list[item_id]
maybe_create_response(source, frame)
```

That shared method owns message mapping, item id generation, manual-echo
tracking, and ledger checks. `LLMContextFrame` handling remains mirror-only in
Phase 1.

## Direct VoiceAgent Inference Gate

This is a Phase 1 blocker. Direct frames queued into `VoiceAgent` do not pass
through the main `PreLLMInferenceGate`:

```text
EventRelay / VoiceAgent._inject_context()
-> VoiceAgent.queue_frame(...)
-> VoiceAgent pipeline source
-> EdgeSource
-> GradientOpenAIRealtimeLLMService
```

Without a Realtime-mode gate inside the voice-agent pipeline, direct
`LLMMessagesAppendFrame(run_llm=True)` and direct `LLMRunFrame` can call
`response.create` immediately and bypass the shared bot/user/LLM/cooldown state.

Add `RealtimeVoiceAgentInferenceGate` between `VoiceAgent EdgeSource` and
`GradientOpenAIRealtimeLLMService`.

Deep investigation result: the current `InferenceGateState.update_user_speaking(False)`
clears any pending inference. That is intentional when a logical
`UserStoppedSpeakingFrame` is about to trigger a normal user-turn response; the
pending game/tool event is already in context and should be answered by that
user-turn response instead of producing a second response. It is not correct for
plain VAD stop. A VAD stop means audio activity ended; it does not prove that S3
accepted the turn or that a user-turn response will happen.

Phase 1 should split these concepts in the shared gate state:

```text
user_audio_active
  set by VADUserStartedSpeakingFrame / VADUserStoppedSpeakingFrame
  blocks inference while true
  becoming false does not clear pending inference

user_turn_active
  set by UserStartedSpeakingFrame / UserStoppedSpeakingFrame
  blocks inference while true
  becoming false may clear pending inference only when that logical stop will
  trigger a user-turn response
```

`can_run_now()` should return false when either `user_audio_active` or
`user_turn_active` is true. Pending inference should survive a VAD-only stop. It
should be cleared on the logical `UserStoppedSpeakingFrame` path only when the
spoken user turn will itself trigger the Realtime response. This preserves the
existing "user response covers pending events" behavior without losing deferred
direct events on VAD false starts or incomplete S3 turns.

Gate behavior:

- Use the same `InferenceGateState` as the main pre/post gates.
- Do not attach a second deferred-run emitter to `InferenceGateState`. The
  existing `PreLLMInferenceGate` emitter should remain the owner of deferred
  main-pipeline `LLMRunFrame` emission.
- On direct downstream `LLMMessagesAppendFrame(run_llm=True)`:
  - if inference can run now, pass the frame unchanged;
  - if inference cannot run now, set `run_llm=False`, request deferred inference
    on the shared gate state, and pass the frame onward so the Realtime
    conversation still receives the model-visible history.
- On direct downstream `LLMRunFrame`:
  - if inference can run now, pass the frame onward;
  - if inference cannot run now, request deferred inference and do not pass the
    direct run frame.
- Use the same event priority classification as `PreLLMInferenceGate` for
  `<event>` payloads, including combat direct-vs-observed handling.
- Non-event direct triggers such as idle prompts should still respect
  bot/user/LLM-in-flight state. If they are deferred, the already-inserted
  Realtime conversation history will be answered by the later main-pipeline
  `LLMRunFrame` observed by `RealtimeMainContextRelay`.
- If a direct event arrives while the user is speaking and S3 later accepts the
  spoken turn, the event should be answered by the Realtime response created from
  that same `UserStoppedSpeakingFrame`. No extra deferred run is needed.
- If a direct event arrives during VAD activity but S3 does not accept a complete
  user turn, the pending inference must survive VAD stop and eventually emit a
  deferred `LLMRunFrame`.

All explicit Realtime `response.create` call sites should go through one
service-owned helper that checks both shared gate state and Realtime response
state:

```text
maybe_create_response(source, frame)
  if a Realtime response is already active:
    request deferred inference and do not send response.create
  elif shared gate cannot run:
    request deferred inference and do not send response.create
  else:
    mark response active and send response.create
```

The `UserStoppedSpeakingFrame` / audio-commit path is the one path that is
allowed to create the user-turn response after local S3 accepts the turn. Once it
does, game events, tool results, typed messages, or direct run frames that arrive
while that response is active should insert their history/tool output but defer
their response until `response.done` / `LLMFullResponseEndFrame` clears the
active-response state. This prevents `conversation_already_has_active_response`
from silently dropping a trigger.

This makes direct and main-pipeline triggers converge on the same response
ownership rule: history insertion can happen immediately, but response creation
must be permitted by the shared inference gate.

## Main Pipeline Context Relay

This is a Phase 1 blocker. The Realtime wrapper cannot rely only on direct
`LLMMessagesAppendFrame` handling, because some important client-driven context
updates enter the main pipeline and are consumed before the bridge.

Add a `RealtimeMainContextRelay` after `pre_llm_gate` and before
`user_aggregator`:

```text
idle_report_processor
-> pre_llm_gate
-> realtime_main_context_relay
-> realtime_user_aggregator
```

That placement gives the relay the effective post-gate `run_llm` value while
still seeing the original frame before `user_aggregator` consumes it.

Relay behavior:

- On downstream `LLMMessagesAppendFrame`, call a Realtime service method that
  inserts the messages into the remote conversation/session and creates a
  response only if the frame's effective `run_llm` is true.
- On downstream `LLMRunFrame`, call `response.create` against the already-synced
  remote conversation. This covers deferred runs after earlier
  `run_llm=False` context insertion.
- Pass every frame onward so the local user/assistant aggregators, RTVI, idle
  handling, and context upload behavior keep working.
- Use the shared remote insertion ledger in `GradientOpenAIRealtimeLLMService` so
  the later `LLMContextFrame` emitted by the aggregator is treated as a mirror,
  not as a second message insertion.

Do not make generic `LLMContextFrame` deltas the primary message-delivery
mechanism in Phase 1. `LLMContextFrame` does not preserve `run_llm`, and it
cannot reliably distinguish a typed user message from a spoken user transcript
whose audio item is already present in the remote Realtime conversation. The
wrapper should use context frames for local mirror/bookkeeping and duplicate
checks, not as the normal way to trigger Realtime responses.

Typed client chat needs a Realtime-specific path as well. Today
`ClientMessageHandler._handle_user_text_input()` simulates a spoken turn by
queuing:

```text
UserTextInputFrame
InterruptionFrame
UserStartedSpeakingFrame
TranscriptionFrame(text=...)
UserStoppedSpeakingFrame
```

In Realtime mode, do not send that synthetic `UserStoppedSpeakingFrame` to the
Realtime service. With OpenAI turn detection disabled, Pipecat interprets
`UserStoppedSpeakingFrame` as the command to commit the input audio buffer and
create a response. For typed text there is no audio buffer to commit.

Instead, typed text in Realtime mode should:

- queue `UserTextInputFrame` as today for local idle/mute bookkeeping;
- queue `InterruptionFrame` so active assistant audio is cancelled;
- queue `LLMMessagesAppendFrame(messages=[{"role": "user", "content": text}],
  run_llm=True)` through the main pipeline, where `RealtimeMainContextRelay`
  inserts it into Realtime and then `user_aggregator` updates local context;
- preserve client-visible typed-message behavior explicitly. Do not rely on
  synthetic `TranscriptionFrame` events for typed chat in Realtime mode. If the
  client transcript/history needs a server echo for typed text, emit a dedicated
  typed-text RTVI/server-message event or continue observing `UserTextInputFrame`
  in the client path.

## Response Trigger Ownership

This is another Phase 1 blocker. Pipecat's base `OpenAIRealtimeLLMService`
treats the first `LLMContextFrame` as an initial conversation bootstrap:

```text
if self._context is None:
  self._context = context
  _process_completed_function_calls(send_new_results=False)
  _create_response()
```

That is correct for the stock service, but it is wrong for Gradient Bang's
Realtime voice flow. In our flow, the first spoken turn is triggered by local
Silero/S3:

```text
S3 complete
-> UserStoppedSpeakingFrame
-> input_audio_buffer.commit
-> response.create
-> Realtime transcription comes back upstream
-> Realtime transcript mirror updates local context/RTVI without triggering LLM
-> LLMContextFrame reaches Realtime service
```

If `self._context` is still `None` when that final `LLMContextFrame` arrives,
the base `_handle_context()` will call `_create_response()` again. That creates
a duplicate `response.create` for the same user turn, or at minimum produces a
`conversation_already_has_active_response` error after Pipecat has already
emitted local response-start frames and metrics.

Phase 1 must make response creation explicit. `GradientOpenAIRealtimeLLMService`
should own this rule:

```text
LLMContextFrame is context synchronization only in Realtime voice mode.
It must never create a response merely because it is the first context frame.
```

The wrapper must still push handled `LLMMessagesAppendFrame` instances
downstream after inserting them into Realtime. Direct `EventRelay` and
`VoiceAgent._inject_context()` appends rely on the downstream path
`VoiceAgent -> EdgeSink -> main bridge -> assistant_aggregator` to keep local
`LLMContext` in sync. Duplicate prevention belongs in the remote insertion
ledger and `_handle_context()` mirror behavior, not in frame consumption.

Required wrapper behavior:

- Initialize `self._context` from the first `LLMMessagesAppendFrame`, usually
  the activation messages containing the system prompt.
- Apply system/developer instructions to the Realtime session during activation
  setup.
- Insert any non-system activation messages as Realtime conversation items
  without creating a response when `run_llm=False`.
- Mark the base "initial conversation setup" path as complete, or override the
  response path, so later `_create_response()` calls do not replay activation
  messages.
- Override `_handle_context()` so the first local `LLMContextFrame` is treated
  as an update/mirror, not as an implicit run request.
- Do not create a duplicate text conversation item for any spoken user
  transcript. The remote Realtime conversation already has the committed input
  audio item. Local transcript mirroring is for Gradient Bang bookkeeping and
  client visibility only.

Only these events should send `response.create` in Realtime mode:

- `UserStoppedSpeakingFrame` after `input_audio_buffer.commit`.
- Direct `LLMMessagesAppendFrame(run_llm=True)` reaching
  `GradientOpenAIRealtimeLLMService` after `RealtimeVoiceAgentInferenceGate`
  permits the run.
- Main-pipeline `LLMMessagesAppendFrame(run_llm=True)` observed by
  `RealtimeMainContextRelay`.
- Direct `LLMRunFrame` after `RealtimeVoiceAgentInferenceGate` permits the run,
  or main-pipeline `LLMRunFrame` observed by `RealtimeMainContextRelay`.
- Function/tool result handling when the result's effective post-gate
  `run_llm` is true.

This preserves the existing EventRelay semantics:

- Ambient/context events can be inserted silently with `run_llm=False`.
- Onboarding/session-start and urgent game events can wake the assistant with
  `run_llm=True`.
- The pre-LLM inference gate can still defer main-pipeline event-triggered runs
  by flipping `run_llm` to `False` before `RealtimeMainContextRelay` sees the
  frame and later emitting `LLMRunFrame`.

## Function Call Output Sync

This is a Phase 1 blocker. Tool-result history sync must not depend on
`LLMAssistantAggregator` emitting an `LLMContextFrame`.

In the current cascade path, `LLMAssistantAggregator` handles
`FunctionCallResultFrame` by updating local context. It only pushes an upstream
context frame when the effective `run_llm` is true. That is fine for the
non-Realtime path, but it is not enough for Realtime mode because the remote
Realtime conversation also needs a `function_call_output` item.

If a tool result has `run_llm=False`, or if `post_llm_gate` changes it to
`run_llm=False` for deferred inference, the assistant aggregator updates local
context but emits no context frame. Pipecat's base Realtime service only sends
completed function-call outputs while processing context frames, so the remote
Realtime conversation would never see the result. Later responses could then
reason from a remote conversation where the function call is still unresolved or
where the tool output is missing.

Phase 1 should add a small Realtime function-result relay in the main branch,
after `post_llm_gate` and before `assistant_aggregator`:

```text
bridge
-> post_llm_gate
-> realtime_function_result_relay
-> token_usage_metrics
-> say_text_voice_guard
-> realtime_output_mux
-> transport.output()
-> assistant_aggregator
```

That placement matters:

- It is still before `assistant_aggregator`, so it does not depend on the
  aggregator's `run_llm=True` context-frame behavior.
- It is after `post_llm_gate`, so it observes the final effective `run_llm`
  decision for tool results. This preserves existing deferred-inference
  semantics.
- Do not place this relay inside the `VoiceAgent` pipeline unless the
  post-LLM gate is also moved there. In the current bridge topology,
  `FunctionCallResultFrame` reaches `bridge -> post_llm_gate ->
  realtime_function_result_relay -> ... -> assistant_aggregator`, so the relay
  is still before local context aggregation and can see the post-gate
  `run_llm` value.

Relay behavior:

- On every downstream `FunctionCallResultFrame` from the Realtime voice agent,
  first check a Realtime-owned pending-call ledger. Send a Realtime
  `function_call_output` only when `frame.tool_call_id` was issued by the
  Realtime service and is still awaiting output.
- For known Realtime call ids, send exactly one Realtime
  `conversation.item.create` with `type="function_call_output"` and
  `call_id=frame.tool_call_id`.
- If the call id is unknown, pass the frame onward unchanged and log `DEBUG`.
  Do not send an unknown local/other-agent tool result to OpenAI Realtime.
- Serialize `frame.result` once into the string expected by Realtime
  `function_call_output`. Avoid double-encoding results that are already JSON
  strings.
- Mark the `tool_call_id` as sent in `GradientOpenAIRealtimeLLMService`, or make
  `_process_completed_function_calls()` skip already-sent IDs, so later context
  sync cannot duplicate the output.
- If the effective post-gate `run_llm` is false, do not call
  `response.create`.
- If the effective post-gate `run_llm` is true, call `response.create` after
  the output item has been inserted.
- If `post_llm_gate` suppresses an originally true `run_llm`, the relay still
  sends the `function_call_output` but does not create a response. The later
  deferred `LLMRunFrame` creates the response against a remote conversation that
  already contains the tool output.

Do not rely on `LLMContextFrame` to deliver Realtime tool outputs in Phase 1.
Context frames can remain useful as a local mirror and as a safety check, but
remote tool-output insertion needs its own explicit path.

Also do not rely on Pipecat cascade batch behavior for correctness here. The
existing `LLMAgent` batch suppression was tuned for text LLM batches where the
assistant aggregator sees the batch and decides when the final tool result should
run the model. OpenAI Realtime function-call argument completion arrives
one call at a time. In Realtime mode, the explicit function-result relay and the
shared inference gate own response creation after tool outputs.

## RTVI Frame Requirements

Do not collapse Realtime output into opaque transport audio only. The client
still needs the usual Pipecat/RTVI-observed frames:

- `UserStartedSpeakingFrame`
- `UserStoppedSpeakingFrame`
- `InterimTranscriptionFrame`
- `TranscriptionFrame`
- `LLMFullResponseStartFrame`
- `LLMFullResponseEndFrame`
- `LLMTextFrame`
- `TTSTextFrame`
- `TTSStartedFrame`
- `TTSStoppedFrame`
- `TTSAudioRawFrame`
- function call start/in-progress/result frames
- `RTVIServerMessageFrame` game events
- typed user text events or equivalent client transcript updates

The existing `RTVIObserver` already handles these frame types. The Realtime mode
work is mostly about preserving the same frame flow across the bus, preventing
local TTS from consuming Realtime text, and bypassing local TTS for Realtime
audio frames.

Typed text is the exception to the "usual transcription frame" path. In Realtime
mode typed chat should not emit synthetic audio-turn stop frames, so any
client-visible typed transcript entry must be preserved through `UserTextInputFrame`
handling or an explicit typed-text RTVI/server event.

## Compaction Bypass

When `openai-realtime-mode` is enabled:

- Do not create the summarization LLM unless another non-Realtime path needs it.
  In `bot.py`, move construction of the Gemini summarizer and
  `LLMAutoContextSummarizationConfig` behind the non-Realtime branch instead of
  only disabling the assistant aggregator flag.
- Set `LLMAssistantAggregatorParams(enable_auto_context_summarization=False)`.
- Do not call Realtime `reset_conversation()` for compaction.
- Do not try to rewrite the remote Realtime conversation history in Phase 1.
- Keep any `llm.context_summarized` RTVI event disabled in this mode.

Known Phase 1 divergence: local `LLMContext` will continue to grow without
summarization, while the Realtime service maintains its own remote conversation
and may truncate or manage server-side state independently. That divergence is
accepted for Phase 1 and should be addressed with a Realtime-specific
reset/reseed design in Phase 2.

Compaction becomes Phase 2, where we can design a Realtime-specific remote
conversation reset/reseed flow.

## Reconnection Scope

Phase 1 does not add a new Realtime websocket reconnection and remote
conversation recovery design. `GradientOpenAIRealtimeLLMService` can inherit the
upstream Pipecat service's current failure behavior. If the websocket drops
mid-conversation, preserving or rebuilding the remote conversation is out of
scope for Phase 1.

## Implementation Steps

1. Add config flags:
   - `OPENAI_REALTIME_MODE`
	   - `OPENAI_REALTIME_MODEL`, default `gpt-realtime-1.5`
	   - `OPENAI_REALTIME_TRANSCRIPTION_MODEL`, default `gpt-4o-transcribe`
	   - `OPENAI_REALTIME_VOICE`
	   - `OPENAI_REALTIME_SAMPLE_RATE`, default `24000`, for OpenAI Realtime
	     input/output.
	   - `OPENAI_REALTIME_LOCAL_INPUT_SAMPLE_RATE`, default `16000`, for
	     transport capture, Silero, and S3/SmartTurn input.
2. Add `GradientOpenAIRealtimeLLMService`.
	   - Configure `turn_detection=False`.
	   - Configure Realtime input and output audio formats as 24 kHz PCM.
	   - Resample local 16 kHz mono PCM `InputAudioRawFrame` audio to 24 kHz
	     mono PCM before `input_audio_buffer.append`.
   - Override the completed input-transcription handler so emitted
     `TranscriptionFrame` instances have `finalized=True` and preserve the
     Realtime event object, including `item_id`, in `frame.result`.
   - If using local transcript placeholders, dispatch
     `input_audio_buffer.committed` server events and expose the committed
     `item_id` to the transcript mirror.
   - Add DEBUG dropped-send logging when a custom Realtime client event reaches
     the websocket send path with no websocket or while disconnecting.
   - Implement `LLMMessagesAppendFrame`.
     - Initialize `self._context` on first append.
     - Send activation/system instructions through `session.update`.
     - Send appended non-system messages as conversation items.
     - Honor `run_llm` without using the base first-context bootstrap.
     - Use the remote insertion ledger, not content-only fingerprints, to avoid
       duplicate item creation.
   - Override `_handle_context()` so no `LLMContextFrame` implicitly creates
     the first response. Context frames should update the local mirror and tool
     bookkeeping only.
   - Implement `LLMRunFrame` as an explicit `response.create`.
   - Implement `LLMSetToolsFrame`.
     - Cache the latest tools on the wrapper.
     - Convert and send them with `session.update` when the websocket/session is
       ready.
     - Resend cached tools from the `session.created` path if the original tool
       frame arrived too early.
     - Treat duplicate tool frames as idempotent.
   - Cache latest desired session instructions and tools as service state. Do
     not add a general queue/replay system for conversation items in Phase 1.
   - Expose a reusable method for inserting appended messages and optionally
     creating a response, so both direct wrapper handling and
     `RealtimeMainContextRelay` use the same code path.
   - Track sent message insertion keys, message-object mirror keys, and Realtime
     item ids so context-frame mirror updates cannot duplicate message
     insertion.
   - Expose a method for inserting one `function_call_output` item and
     optionally creating a response after insertion.
   - Track Realtime pending call ids and sent tool-call output ids so explicit
     relay delivery and context sync cannot send duplicates.
3. Add `RealtimeAudioOnlyS3TurnStopStrategy`.
   - Model it on Nemotron's `AudioOnlySmartTurnStopStrategy`.
   - Use VAD plus `InputAudioRawFrame` audio for the S3/SmartTurn
     turn-complete decision.
   - Call `trigger_user_turn_stopped()` immediately when S3 says complete.
   - Do not inspect or wait for `TranscriptionFrame`.
   - Reset VAD/audio/analyzer state between turns.
4. Add Realtime transcript mirroring.
   - Use `RealtimeAudioLLMUserAggregator` or an upstream transcript processor so
     late Realtime transcription frames do not enter the stock user aggregation
     buffer.
   - Keep Realtime transcripts visible to RTVI/client observers.
   - Update a local placeholder user message, or append a local user transcript
     message, without pushing an LLM run and without inserting another Realtime
     user text item.
5. Update inference gate state semantics.
   - Split user audio activity from logical user-turn activity.
   - VAD start/stop should block/unblock inference without clearing pending
     inference.
   - Logical `UserStoppedSpeakingFrame` may clear pending inference only when
     the user-stop path will itself trigger a response.
   - Add VAD frame handling so direct Realtime `VoiceAgent` triggers are blocked
     as soon as local VAD says the user is speaking.
6. Add `RealtimeOutputMux`.
   - Replace the normal Cartesia TTS processor in the Realtime main output branch.
   - Pass known Realtime output frames through in original order without setting
     `skip_tts=True` and without using Cartesia's serialization queue.
   - Delegate explicit local TTS paths such as `TTSSpeakFrame` / `say-text` to
     Cartesia.
   - If needed for tighter RTVI timing, have the Realtime wrapper emit internal
     output frames and let the mux convert them into standard Pipecat TTS frames
     immediately before `transport.output()`.
   - Do not depend on `push_silence_after_stop=False` as the only protection.
7. Add Realtime input echo suppression and interruption fanout.
   - Prevent downstream input/control frames handled by Realtime from being
     re-emitted through `VoiceAgent` `EdgeSink` back to the main branch.
   - Suppress `InputAudioRawFrame`, local user-speaking frames, VAD speaking
     frames, `UserSpeakingFrame`, and `InterruptionFrame`.
   - Make suppression direction/source-aware; do not globally drop all frames of
     those types.
   - Ensure local `InterruptionFrame` reaches both the Realtime service and the
     local output branch before suppressing the returned echo.
   - Do not suppress `BotStartedSpeakingFrame` or `BotStoppedSpeakingFrame`.
8. Add `RealtimeVoiceAgentInferenceGate`.
   - Insert it between `VoiceAgent EdgeSource` and
     `GradientOpenAIRealtimeLLMService` in Realtime mode.
   - Share the main `InferenceGateState`.
   - Do not replace the existing deferred-run emitter attached by
     `PreLLMInferenceGate`.
   - Gate direct `LLMMessagesAppendFrame(run_llm=True)` by flipping it to
     `run_llm=False` and requesting deferred inference when the shared gate
     cannot run now.
   - Gate direct `LLMRunFrame` by suppressing it and requesting deferred
     inference when the shared gate cannot run now.
9. Add `RealtimeMainContextRelay`.
   - Insert it after `pre_llm_gate` and before `user_aggregator` in the
     Realtime main pipeline.
   - Mirror downstream `LLMMessagesAppendFrame` into the Realtime service before
     the user aggregator consumes it.
   - Use the same remote insertion ledger path as direct VoiceAgent appends.
   - Trigger `response.create` only when the frame's effective `run_llm` is
     true.
   - Mirror downstream `LLMRunFrame` as explicit `response.create`.
   - Pass all frames onward.
10. Add `RealtimeFunctionResultRelay`.
   - Insert it immediately after `post_llm_gate` in the Realtime main branch.
   - On every downstream `FunctionCallResultFrame` with a known Realtime pending
     call id, insert the Realtime `function_call_output` regardless of `run_llm`.
   - For unknown call ids, pass the frame onward and log `DEBUG`; do not send an
     unknown tool output to OpenAI.
   - Trigger `response.create` only when the frame's effective post-gate
     `run_llm` is true.
   - Pass all frames onward so `token_usage_metrics`, RTVI observation,
     `transport.output()`, and `assistant_aggregator` keep their existing
     behavior.
11. Update `bot.py` mode selection.
   - In Realtime mode, skip Deepgram STT in the main pipeline.
   - In Realtime mode, do not construct the Gemini summarization LLM or
     `LLMAutoContextSummarizationConfig`.
	   - Set transport `audio_in_sample_rate` to 16 kHz and
	     `audio_out_sample_rate` to 24 kHz for Daily and WebRTC params.
	   - Set the main `PipelineTask` `audio_in_sample_rate` to 16 kHz and
	     `audio_out_sample_rate` to 24 kHz.
   - Use Realtime-specific user aggregator config:
     `RealtimeAudioLLMUserAggregator`,
     `UserTurnStrategies(start=[VADUserTurnStartStrategy()], stop=[RealtimeAudioOnlyS3TurnStopStrategy(...)])`,
     and `SileroVADAnalyzer()`.
   - Disable assistant auto summarization.
   - Insert `RealtimeMainContextRelay` after `pre_llm_gate`.
   - Insert `RealtimeFunctionResultRelay` after `post_llm_gate`.
   - Use `realtime_output_mux` in place of raw `tts` in the main branch.
12. Update `ClientMessageHandler` text input behavior.
   - In Realtime mode, convert typed user text into
     `LLMMessagesAppendFrame(run_llm=True)` instead of synthetic
     `UserStartedSpeakingFrame` / `TranscriptionFrame` /
     `UserStoppedSpeakingFrame`.
   - Keep `UserTextInputFrame` and `InterruptionFrame`.
   - Preserve typed-message client transcript behavior explicitly through
     `UserTextInputFrame` observation or a typed-text RTVI/server event.
13. Update `VoiceAgent.build_llm()`.
   - Choose `GradientOpenAIRealtimeLLMService` when Realtime mode is enabled.
   - Keep existing tool registration.
14. Update the `VoiceAgent` pipeline construction in Realtime mode.
   - Insert `RealtimeVoiceAgentInferenceGate` before the Realtime LLM service.
   - Preserve existing tool registration and bridged edge behavior.
15. Update the `VoiceAgent` pipeline task in Realtime mode.
	   - Set its `PipelineParams.audio_in_sample_rate` and
	     `audio_out_sample_rate` to the same 16 kHz input / 24 kHz output split
	     as the main pipeline.
16. Keep EventRelay delivery unchanged where possible.
   - It should still queue `LLMMessagesAppendFrame`.
   - The Realtime service wrapper should adapt those frames to Realtime
     conversation events.

## Verification Plan

Unit tests:

- A downstream `TTSAudioRawFrame` emitted from a bridged `VoiceAgent` reaches a
  processor placed after the main bridge with direction downstream.
- An upstream Realtime `TranscriptionFrame` emitted from `VoiceAgent` reaches the
  Realtime transcript mirror and RTVI observers without entering the stock user
  aggregation buffer.
- Realtime completed input transcription emits `TranscriptionFrame` with
  `finalized=True` and preserves the Realtime `item_id` in `frame.result`.
- If a custom Realtime send happens while no websocket exists, the service logs a
  `DEBUG` dropped-event line with event type and source frame details, and does
  not raise or queue a retry.
- Realtime mode constructs transport params and both pipeline tasks with
  `audio_in_sample_rate == 16000` and `audio_out_sample_rate == 24000`.
- Realtime mode does not construct the Gemini summarization LLM or
  `LLMAutoContextSummarizationConfig`; non-Realtime mode still does.
- `InputAudioRawFrame(sample_rate=16000)` instances reaching
  `GradientOpenAIRealtimeLLMService` are resampled before
  `input_audio_buffer.append`; frames with non-mono channel counts are rejected.
- The default Realtime model is `gpt-realtime-1.5` when
  `OPENAI_REALTIME_MODEL` is unset.
- `RealtimeOutputMux` passes known Realtime
  `LLMFullResponseStartFrame`, `LLMTextFrame`, `TTSTextFrame`,
  `TTSStartedFrame`, `TTSAudioRawFrame`, `TTSStoppedFrame`, and
  `LLMFullResponseEndFrame` through in original order without setting
  `skip_tts=True` and without using Cartesia's serialization queue.
- Realtime `TTSTextFrame` chunks do not overtake neighboring
  `TTSAudioRawFrame` chunks in the main branch or at `transport.output()`.
- Incoming Realtime `TTSStartedFrame`, `TTSAudioRawFrame`, and
  `TTSStoppedFrame` reach `transport.output()` without entering local
  Cartesia synthesis.
- If internal Realtime output frames are used for tighter RTVI timing, the mux
  converts them into standard Pipecat TTS frames immediately before
  `transport.output()` and does not expose early standard `TTSStartedFrame`
  instances to RTVI observers.
- `TTSSpeakFrame` still uses local Cartesia TTS in Realtime mode.
- Realtime input/control echo suppression prevents `InputAudioRawFrame` and
  local user-speaking control frames from returning to the main output branch
  after the Realtime service handles them.
- Local `InterruptionFrame` reaches both the Realtime service and the local
  output branch, and the returned VoiceAgent echo is suppressed so it is not
  replayed through the main branch.
- `BotStartedSpeakingFrame` and `BotStoppedSpeakingFrame` still reach the
  processors that currently depend on them, including first-speech mute
  release.
- Direct VoiceAgent `LLMMessagesAppendFrame(run_llm=True)` passes unchanged and
  creates one response when shared inference gate state can run now.
- Direct VoiceAgent `LLMMessagesAppendFrame` is still pushed downstream after
  Realtime insertion so `assistant_aggregator` updates local context.
- Direct VoiceAgent `LLMMessagesAppendFrame(run_llm=True)` is changed to
  `run_llm=False`, still inserts Realtime conversation history, and requests
  deferred inference when shared inference gate state cannot run now.
- Direct VoiceAgent `LLMRunFrame` passes only when shared inference gate state
  can run now; otherwise it is suppressed and converted into a deferred
  inference request.
- A direct VoiceAgent trigger deferred during user speech is answered by the
  Realtime response created from the later logical `UserStoppedSpeakingFrame`
  when S3 accepts the spoken turn.
- A direct VoiceAgent trigger deferred during VAD activity is not lost if S3 does
  not accept a complete spoken turn; after VAD stops, pending inference survives
  and eventually emits a deferred `LLMRunFrame`.
- `RealtimeAudioOnlyS3TurnStopStrategy` calls `trigger_user_turn_stopped()`
  exactly once when S3/SmartTurn says complete.
- The same strategy does not wait for `TranscriptionFrame`.
- The same strategy resets VAD/audio/analyzer state between turns.
- Realtime mode uses VAD-only start strategies; late Realtime
  `TranscriptionFrame` does not start a fake second user turn.
- The Realtime transcript mirror updates a local placeholder or local transcript
  message without pushing an LLM run and without inserting a Realtime user text
  item.
- If placeholder ordering is used, `input_audio_buffer.committed` maps the
  committed Realtime audio item id to the local placeholder, and
  `conversation.item.input_audio_transcription.completed` updates that same
  placeholder.
- `LLMMessagesAppendFrame(run_llm=False)` sends conversation item create without
  response create.
- `LLMMessagesAppendFrame(run_llm=True)` sends conversation item create and
  response create.
- A main-pipeline `LLMMessagesAppendFrame(run_llm=False)` is consumed by
  `user_aggregator` but still creates one Realtime conversation item via
  `RealtimeMainContextRelay`, with no response.
- A main-pipeline `LLMMessagesAppendFrame(run_llm=True)` is consumed by
  `user_aggregator` but still creates one Realtime conversation item and one
  response via `RealtimeMainContextRelay`.
- A main-pipeline `LLMRunFrame` creates one Realtime response even though
  `user_aggregator` consumes the run frame and emits only an `LLMContextFrame`
  downstream.
- Activation `LLMMessagesAppendFrame(run_llm=False)` initializes Realtime
  service context and session instructions, then the first later
  `LLMContextFrame` does not call `response.create`.
- First spoken turn sends exactly one `response.create`: the one following
  `UserStoppedSpeakingFrame` / `input_audio_buffer.commit`.
- First spoken turn also updates local context exactly once with the Realtime
  final transcript; no additional user text item is inserted into the remote
  Realtime conversation for that same spoken turn.
- Typed text input in Realtime mode does not send `UserStoppedSpeakingFrame` to
  the Realtime service; it inserts the typed text as a Realtime user
  conversation item and triggers one response.
- Typed text input from `ClientMessageHandler._handle_user_text_input()` reaches
  the OpenAI Realtime conversation through `RealtimeMainContextRelay` even
  though `user_aggregator` consumes the append frame before the bridge.
- A later `LLMContextFrame` containing the same typed text does not insert a
  duplicate Realtime user item.
- Two identical typed text or game-event messages in two different append frames
  create two Realtime conversation items. Duplicate suppression must not collapse
  legitimate repeated content.
- The same append frame observed twice creates only one Realtime conversation
  item per message index.
- A direct VoiceAgent append that later appears in an upstream `LLMContextFrame`
  does not create a duplicate Realtime conversation item.
- A main-pipeline append mirrored by `RealtimeMainContextRelay` and later present
  in `LLMContextFrame` does not create a duplicate Realtime conversation item.
- `FunctionCallResultFrame(run_llm=False)` sends exactly one Realtime
  `function_call_output` and no `response.create`.
- `FunctionCallResultFrame` with an unknown/non-Realtime `tool_call_id` is passed
  onward, logs `DEBUG`, and does not send a Realtime `function_call_output`.
- A real or representative deferred game-event tool result with
  `run_llm=False` reaches OpenAI Realtime as `function_call_output` even though
  `LLMAssistantAggregator` does not emit an upstream context frame.
- `FunctionCallResultFrame(run_llm=True)` after `post_llm_gate` sends exactly
  one Realtime `function_call_output` followed by one `response.create`.
- A tool result that starts as `run_llm=True` but is suppressed by
  `post_llm_gate` sends `function_call_output` and no `response.create`; the
  later deferred `LLMRunFrame` sends the response.
- `RealtimeFunctionResultRelay` observes the post-gate effective `run_llm`
  value while still running before `assistant_aggregator`; local context
  aggregation happens after the relay.
- A later `LLMContextFrame` containing the same completed tool result does not
  send a duplicate Realtime `function_call_output`.
- A Realtime function call result with effective `run_llm=True` still creates a
  response when `LLMAgent` sees a single-call Realtime batch.
- Multiple Realtime function-call result frames do not rely on Pipecat's
  cascade batch coalescing for correctness; response creation is explicit and
  guarded against duplicate active-response triggers.
- `LLMSetToolsFrame` and instruction updates are cached as desired session state;
  `session.created` sends the current desired state, and any immediate send
  attempted without a websocket logs a DEBUG drop.
- Deferred gate behavior still works: when `pre_llm_gate` flips an event append
  to `run_llm=False`, Realtime does not run until the later `LLMRunFrame`.

High-risk integration tests:

- First spoken user turn end-to-end: S3 triggers one logical
  `UserStoppedSpeakingFrame`, Realtime commits audio and creates exactly one
  response, Realtime emits final transcription, and the transcript mirror updates
  local/client-visible text without creating a second remote user item.
- Direct EventRelay event end-to-end while the gate cannot run because the user
  is speaking: the event is inserted into the Realtime conversation immediately
  with no response, and the later user-stop response covers both the event and
  the user's spoken audio.
- Direct EventRelay event end-to-end during VAD activity where S3 does not accept
  a user turn: the event is inserted immediately, pending inference survives VAD
  stop, and the later deferred run creates exactly one response.
- Deferred tool-result end-to-end: a tool result with effective `run_llm=False`
  updates local context and sends exactly one Realtime `function_call_output`;
  the later deferred `LLMRunFrame` sends the response.
- Client typed text end-to-end: `ClientMessageHandler` queues typed text, the
  text appears in local context and in the Realtime conversation, and exactly
  one response is created without an audio-buffer commit.
- Realtime output ordering end-to-end: interleaved Realtime audio and transcript
  frames reach `transport.output()` in the same relative order and the client
  does not receive all bot transcript chunks ahead of audible speech.
- Bot-speaking lifecycle end-to-end: Realtime audio reaches
  `transport.output()`, generated `BotStartedSpeakingFrame` and
  `BotStoppedSpeakingFrame` still reach the user aggregator path, and
  `TextInputBypassFirstBotMuteStrategy` clears first-speech mute.
- Interruption end-to-end: the user interrupts during Realtime bot speech,
  Realtime receives cancel/clear, local output queues are cleared, and the next
  user turn has no leftover assistant audio.

Manual/integration checks:

- User speaks once: Silero/S3 stop commits Realtime audio, Realtime transcribes,
  transcript mirror updates local/client-visible text, bot responds with
  Realtime audio.
- User interrupts bot: local interruption reaches Realtime and clears/cancels
  the active Realtime response.
- Client receives RTVI user speaking, late/final user transcription, bot LLM,
  bot TTS, bot speaking, and function call events.
- Client does not receive Deepgram-style live interim user transcription while
  the player is still speaking; that is expected in Phase 1.
- A game event with `run_llm=False` appears in Realtime context without speech.
- A game event with `run_llm=True` triggers one response, not two.
- A tool result with `run_llm=False` is visible to the next Realtime response
  even though it did not immediately trigger speech.
- `say-text` still speaks through local TTS and does not pollute assistant
  context.
