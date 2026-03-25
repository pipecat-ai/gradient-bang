# Pipecat SubAgents Architecture

## Agent Hierarchy & Orchestration

```mermaid
graph TB
    subgraph Runner["AgentRunner"]
        direction TB

        subgraph MainAgent["MainAgent (BaseAgent)"]
            direction TB
            Transport["Transport<br/>Daily WebRTC"]
            STT["DeepgramSTT"]
            UserAgg["UserAggregator"]
            Bridge["BusBridgeProcessor"]
            TTS["CartesiaTTS"]
            AsstAgg["AssistantAggregator<br/>+ Context Summarization"]
            PreGate["PreLLMInferenceGate"]
            PostGate["PostLLMInferenceGate"]
            RTVI["RTVIProcessor"]

            Transport -->|audio in| STT
            STT --> UserAgg
            UserAgg --> PreGate
            PreGate --> Bridge
            Bridge --> PostGate
            PostGate --> TTS
            TTS --> AsstAgg
            AsstAgg --> RTVI
            RTVI -->|audio out| Transport
        end

        subgraph ParPipeline["ParallelPipeline"]
            UIAgent["UIAgent<br/>Autonomous UI Control"]
        end

        subgraph VoiceAgent["VoiceAgent (LLMAgent)"]
            VoiceLLM["Voice LLM<br/>(Gemini/GPT)"]
            VoiceTools["@tool methods<br/>start_task, stop_task,<br/>steer_task, query_progress,<br/>my_status, plot_course,<br/>combat_*, send_message..."]
        end

        subgraph TaskWorkers["Dynamic Task Workers"]
            direction LR
            PlayerTask["GameTaskAgent<br/>(Player Ship)"]
            CorpTask1["GameTaskAgent<br/>(Corp Ship 1)"]
            CorpTask2["GameTaskAgent<br/>(Corp Ship 2)"]
            CorpTask3["GameTaskAgent<br/>(Corp Ship 3)"]
        end
    end

    Bus["AsyncQueueBus"]

    Bridge <--->|"BusFrameMessage<br/>(audio, transcription, LLM frames)"| Bus
    VoiceAgent <--->|"BusFrameMessage<br/>(active agent)"| Bus
    UIAgent -.->|"observes frames<br/>(parallel pipeline)"| Bridge

    style Runner fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style MainAgent fill:#16213e,stroke:#0f3460,color:#e0e0e0
    style VoiceAgent fill:#0f3460,stroke:#533483,color:#e0e0e0
    style TaskWorkers fill:#1a1a2e,stroke:#533483,color:#e0e0e0
    style ParPipeline fill:#16213e,stroke:#0f3460,color:#e0e0e0
    style Bus fill:#533483,stroke:#e94560,color:#e0e0e0
```

## Task Lifecycle

```mermaid
sequenceDiagram
    participant User
    participant Voice as VoiceAgent
    participant Bus as AgentBus
    participant Main as MainAgent
    participant GTA as GameTaskAgent
    participant Game as AsyncGameClient
    participant Server as Supabase Edge Fn

    Note over User,Server: Task Creation
    User->>Voice: "Move to sector 5 and trade"
    Voice->>Voice: LLM decides: call start_task tool
    Voice->>GTA: start_task(GameTaskAgent, payload={description, ship_id})
    Note over Voice,GTA: Framework creates task_id,<br/>adds agent to runner,<br/>tracks in _task_groups

    GTA->>GTA: on_task_request(task_id, payload)
    GTA->>GTA: Build internal LLM pipeline<br/>(LLM + tools + ResponseStateTracker)
    GTA->>Game: my_status() → get initial state
    Game->>Server: RPC call
    Server-->>Game: status.snapshot event
    Game-->>GTA: Event with ship state

    Note over User,Server: Task Execution Loop
    loop Inference → Tool → Event → Inference
        GTA->>GTA: LLM inference
        GTA->>Game: Tool call (e.g. "move")
        Game->>Server: RPC
        GTA->>GTA: Tool returns {"status": "Executed."}
        GTA->>GTA: _awaiting_completion_event = "movement.complete"
        Server-->>Game: movement.complete event
        Game-->>GTA: _handle_event() → add to context
        GTA->>GTA: Schedule next inference (1s batch window)
    end

    Note over User,Server: Progress Updates
    GTA->>Voice: send_task_update({text, type})
    Voice->>Main: Push via RTVI to client
    Main->>User: RTVIServerMessageFrame

    Note over User,Server: Task Completion
    GTA->>Voice: send_task_response(status=COMPLETED, response={...})
    Voice->>Voice: on_task_completed(task_id, responses)
    Voice->>Voice: LLM informed: "Task finished: ..."
    Voice->>User: Speaks result
```

## Event Routing

```mermaid
flowchart TB
    WS["WebSocket Events<br/>(AsyncGameClient)"] --> Router{"GameEventRouter<br/>(on MainAgent)"}

    Router -->|"has __task_id<br/>matching active task"| TaskRoute["Route to GameTaskAgent<br/>via direct reference"]
    Router -->|"combat.round_waiting"| CombatPriority["Combat Priority Handler"]
    Router -->|"voice agent request_id<br/>match"| VoiceContext["Push to Voice LLM Context<br/>LLMMessagesAppendFrame via bus"]
    Router -->|"bank.transaction,<br/>chat.message, etc.<br/>(TASK_SCOPED_DIRECT_EVENT_ALLOWLIST)"| BothRoute["Voice Context + RTVI Client"]
    Router -->|"UI-relevant events"| ClientOnly["RTVI Push to Client Only"]

    CombatPriority -->|"cancel non-combat tasks"| CancelTasks["VoiceAgent.cancel_task()"]
    CombatPriority -->|"interrupt voice turn"| VoiceInterrupt["Push combat context<br/>to Voice LLM"]
    CombatPriority -->|"combat.ended"| ResumeNormal["Deactivate combat priority"]

    TaskRoute --> TaskAgent["GameTaskAgent._handle_event()"]
    TaskAgent --> Batch{"Event Batch<br/>Window (1s)"}
    Batch -->|"timer fires"| Inference["Schedule LLM Inference"]
    Batch -->|"completion event<br/>matches awaited"| ImmediateInfer["Immediate Inference"]

    style Router fill:#533483,stroke:#e94560,color:#e0e0e0
    style CombatPriority fill:#e94560,stroke:#ff6b6b,color:#e0e0e0
    style WS fill:#0f3460,stroke:#533483,color:#e0e0e0
```

## Task Control (Steer / Stop / Query)

```mermaid
sequenceDiagram
    participant User
    participant Voice as VoiceAgent
    participant GTA as GameTaskAgent

    Note over User,GTA: Steer Task
    User->>Voice: "Focus on profit, not safety"
    Voice->>Voice: LLM calls steer_task tool
    Voice->>GTA: inject_user_message(instruction)<br/>(direct reference, same process)
    GTA->>GTA: Append to LLM context,<br/>schedule immediate inference

    Note over User,GTA: Stop Task
    User->>Voice: "Cancel that task"
    Voice->>Voice: LLM calls stop_task tool
    Voice->>GTA: cancel_task(task_id)
    Note over GTA: Framework sends<br/>BusCancelAgentMessage
    GTA->>GTA: on_task_cancelled()<br/>Set cancelled flag,<br/>quench inference,<br/>close pipeline
    GTA->>Voice: send_task_response(status=CANCELLED)
    Voice->>User: "Task cancelled"

    Note over User,GTA: Query Progress
    User->>Voice: "What's that task doing?"
    Voice->>Voice: LLM calls query_task_progress
    Voice->>GTA: request_task_update(task_id)
    GTA->>GTA: on_task_update_requested()<br/>Gather task log
    GTA->>Voice: send_task_update({summary})
    Voice->>User: Speaks summary
```

## Failure Modes & Recovery

```mermaid
flowchart TB
    subgraph TaskErrors["GameTaskAgent Error Handling"]
        ToolError["Tool Call Error<br/>(RPC failure, timeout)"]
        ToolError -->|"increment<br/>_consecutive_error_count"| ErrorCheck{"count >= 3?"}
        ErrorCheck -->|No| AddContext["Add error to LLM context<br/>Continue inference"]
        ErrorCheck -->|Yes| ForceFinish["Force-finish task<br/>status=FAILED"]

        CompletionTimeout["Completion Event Timeout<br/>(5s watchdog)"]
        CompletionTimeout --> FallbackInfer["Schedule fallback inference<br/>(LLM handles missing event)"]

        NoToolWatchdog["No-Tool Watchdog<br/>(LLM keeps talking, no actions)"]
        NoToolWatchdog -->|"nudge count < 3"| Nudge["Inject nudge message<br/>'Please use a tool'"]
        NoToolWatchdog -->|"nudge count >= 3"| ForceFinish

        HyperspaceStuck["Corp Ship in Hyperspace<br/>(409 response)"]
        HyperspaceStuck --> RetryLoop["Retry my_status<br/>every 4s for 20s"]
        RetryLoop -->|"ship arrives"| ContinueTask["Continue task normally"]
        RetryLoop -->|"timeout"| ForceFinish
    end

    subgraph TaskResponse["Response Flow"]
        ForceFinish --> SendFailed["send_task_response<br/>(status=FAILED, error msg)"]
        AddContext --> ContinueInference["Next inference cycle"]
        SendFailed --> VoiceNotified["VoiceAgent.on_task_response()<br/>Informs user of failure"]
    end

    subgraph CombatInterrupt["Combat Interrupt"]
        CombatEvent["combat.round_waiting"] --> CancelActive["Cancel all non-combat<br/>GameTaskAgents"]
        CancelActive --> TasksCancelled["Tasks receive<br/>on_task_cancelled()"]
        TasksCancelled --> CleanResponse["send_task_response<br/>(status=CANCELLED,<br/>reason='combat')"]
    end

    style TaskErrors fill:#1a1a2e,stroke:#e94560,color:#e0e0e0
    style TaskResponse fill:#16213e,stroke:#0f3460,color:#e0e0e0
    style CombatInterrupt fill:#e94560,stroke:#ff6b6b,color:#e0e0e0
```

## Corp Ship Multi-Task Concurrency

```mermaid
flowchart LR
    subgraph Voice["VoiceAgent"]
        TaskGroups["_task_groups<br/>(framework managed)"]
    end

    subgraph Players["Player Task"]
        SharedClient["Shared AsyncGameClient<br/>(entity_type=player)"]
        PlayerGTA["GameTaskAgent<br/>(player ship)"]
        SharedClient <--> PlayerGTA
    end

    subgraph Corp1["Corp Ship Task 1"]
        Client1["Dedicated AsyncGameClient<br/>(entity_type=corporation_ship)"]
        CorpGTA1["GameTaskAgent<br/>(corp ship 1)"]
        Client1 <--> CorpGTA1
    end

    subgraph Corp2["Corp Ship Task 2"]
        Client2["Dedicated AsyncGameClient"]
        CorpGTA2["GameTaskAgent<br/>(corp ship 2)"]
        Client2 <--> CorpGTA2
    end

    Voice -->|"start_task(payload={scope: player})"| PlayerGTA
    Voice -->|"start_task(payload={scope: corp, ship_id})"| CorpGTA1
    Voice -->|"start_task(payload={scope: corp, ship_id})"| CorpGTA2

    PlayerGTA -->|"send_task_response"| Voice
    CorpGTA1 -->|"send_task_response"| Voice
    CorpGTA2 -->|"send_task_update"| Voice

    EventRouter["MainAgent<br/>GameEventRouter"] -->|"route by __task_id"| PlayerGTA
    EventRouter -->|"route by __task_id"| CorpGTA1
    EventRouter -->|"route by __task_id"| CorpGTA2

    style Voice fill:#533483,stroke:#e94560,color:#e0e0e0
    style Players fill:#0f3460,stroke:#533483,color:#e0e0e0
    style Corp1 fill:#16213e,stroke:#0f3460,color:#e0e0e0
    style Corp2 fill:#16213e,stroke:#0f3460,color:#e0e0e0
```
