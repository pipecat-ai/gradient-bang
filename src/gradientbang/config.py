"""Centralized config for gradientbang.

Loads ``.env.bot`` into process env, then exposes a typed ``settings`` object.
Prefer importing constants and ``settings`` from here for runtime code.
"""

import re

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PLAYER_AGENT_NAME = "player"
MAX_CORP_SHIP_TASKS = 3
MAX_PERSONAL_SHIP_TASKS = 1
REQUEST_ID_CACHE_TTL_SECONDS = 15 * 60
REQUEST_ID_CACHE_MAX_SIZE = 5000
TASK_RESPONSE_SPEECH_START_GRACE_SECONDS = 0.75
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

ENV_FILE = ".env.bot"
load_dotenv(ENV_FILE, override=False)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", env_ignore_empty=True)

    # ===== Logging =====
    LOGURU_LEVEL: str = Field(
        default="INFO",
        description="Loguru minimum log level. One of TRACE/DEBUG/INFO/WARNING/ERROR/CRITICAL.",
    )
    LOG_LEVEL: str | None = Field(
        default=None,
        description="Legacy logging level alias used by older scripts. Prefer LOGURU_LEVEL.",
    )

    # ===== Supabase & game server =====
    SUPABASE_URL: str | None = Field(
        default=None,
        description="Base URL of the Supabase project (e.g. https://abc.supabase.co). Required for the bot to talk to the game server in prod.",
    )
    SUPABASE_SERVICE_ROLE_KEY: str | None = Field(
        default=None,
        description="Supabase service-role key. Grants admin access; required for server-side admin operations.",
    )
    SUPABASE_ANON_KEY: str = Field(
        default="anon-key",
        description="Supabase anon (public) API key. Used for unauthenticated client calls.",
    )
    SUPABASE_API_TOKEN: str | None = Field(
        default=None,
        description="Optional bearer token for edge function auth (alternative to EDGE_API_TOKEN).",
    )
    SUPABASE_ADMIN_DEFAULT_CREDITS: int = Field(
        default=25000,
        description="Starting credit balance assigned to new characters created via the admin API.",
    )
    SUPABASE_EVENT_LOG_PATH: str | None = Field(
        default=None,
        description="Debug-only path to append a JSONL trace of Supabase events. Unset in normal operation.",
    )
    SUPABASE_LEGACY_ID_NAMESPACE: str = Field(
        default="5a53c4f5-8f16-4be6-8d3d-2620f4c41b3b",
        description="UUID namespace used to map legacy character labels to stable UUIDs.",
    )
    SUPABASE_SHIP_ID_NAMESPACE: str = Field(
        default="b7b87641-1c44-4ed1-8e9c-5f671484b1a9",
        description="UUID namespace used to map legacy ship labels to stable UUIDs.",
    )
    SUPABASE_ALLOW_LEGACY_IDS: bool = Field(
        default=False,
        description="Allow non-UUID legacy character identifiers by mapping them to UUIDv5.",
    )

    # ===== Edge functions / local API =====
    EDGE_FUNCTIONS_URL: str | None = Field(
        default=None,
        description="Base URL for invoking edge functions. Typically https://<project>.functions.supabase.co in prod, or the local serve URL in dev.",
    )
    EDGE_API_TOKEN: str | None = Field(
        default=None,
        description="Bearer token for edge function auth. Preferred over SUPABASE_API_TOKEN.",
    )
    EDGE_FUNCTIONS_DIR: str | None = Field(
        default=None,
        description="Path to the local edge functions source dir, used when running edge functions in-process during dev.",
    )
    LOCAL_API_PORT: int = Field(
        default=54380,
        description="Port the local dev API server listens on when running edge functions in-process.",
    )
    LOCAL_API_POSTGRES_URL: str | None = Field(
        default=None,
        description="Postgres URL for the local dev API server. Local Supabase only.",
    )

    # ===== Event transport (pubsub / polling) =====
    EVENT_TRANSPORT: str = Field(
        default="pubsub",
        description="Game event transport mode. One of 'pubsub' (PGMQ-backed) or 'polling' (REST polling fallback).",
    )
    PGMQ_URL: str | None = Field(
        default=None,
        description="Postgres URL used by the PGMQ pubsub subscriber. Required when EVENT_TRANSPORT=pubsub.",
    )
    PGMQ_RECONNECT_BACKOFF_MAX: float = Field(
        default=10.0,
        description="Max seconds between PGMQ reconnect attempts after a failure.",
    )
    PGMQ_NO_EVENTS_WARNING_SECONDS: float = Field(
        default=30.0,
        description="Emit a warning if no events have been received for this long. Helps detect silent subscriber stalls.",
    )
    PGMQ_MAX_DISPATCH_ATTEMPTS: int = Field(
        default=3,
        description="Max number of times a single PGMQ message will be re-dispatched on handler failure before being dropped.",
    )
    EVENT_SESSION_HEARTBEAT_SECONDS: float = Field(
        default=15.0,
        description="How often the event session writes a heartbeat row, so other consumers know it's alive.",
    )
    EVENT_SESSION_TTL_SECONDS: int = Field(
        default=60,
        description="Time-to-live (seconds) for an event session without a heartbeat. After this, the session is considered dead.",
    )
    EVENT_SESSION_HARD_TTL_SECONDS: int = Field(
        default=21600,
        description="Hard upper bound on event session lifetime (seconds) regardless of heartbeats. Default 6h.",
    )
    EVENT_SESSION_VISIBILITY_TIMEOUT_SECONDS: int = Field(
        default=10,
        description="PGMQ message visibility timeout. Messages not ack'd within this window become visible to other consumers.",
    )
    EVENT_SESSION_EMPTY_POLL_INTERVAL_SECONDS: float = Field(
        default=1.0,
        description="Sleep duration (seconds) after a poll that returned no messages, to avoid busy-looping.",
    )
    EVENT_SESSION_BATCH_QTY: int = Field(
        default=100,
        description="Max messages fetched per PGMQ poll batch.",
    )
    EVENT_SESSION_BOOTSTRAP_DRAIN_TIMEOUT_SECONDS: float = Field(
        default=2.0,
        description="When a session starts, drain backlog for at most this long (seconds) before going into normal poll mode.",
    )
    SUPABASE_POLL_INTERVAL_SECONDS: float = Field(
        default=1.0,
        description="Polling interval (seconds) when EVENT_TRANSPORT=polling.",
    )
    SUPABASE_POLL_LIMIT: int | None = Field(
        default=None,
        description="Max rows fetched per polling pass. None = adaptive (poller chooses).",
    )
    SUPABASE_POLL_BACKOFF_MAX: float = Field(
        default=5.0,
        description="Max backoff (seconds) when the polling subscriber sees consecutive errors.",
    )

    # ===== Subagent bus =====
    SUBAGENT_BUS_TRANSPORT: str = Field(
        default="local",
        description="Transport for the subagent bus. One of 'local' (in-process), 'pgmq', or 'pubsub'.",
    )
    SUBAGENT_BUS_DATABASE_URL: str | None = Field(
        default=None,
        description="Postgres URL for the subagent bus when transport=pgmq/pubsub.",
    )
    SUBAGENT_BUS_SESSION_CHANNEL: str | None = Field(
        default=None,
        description="Override the generated subagent bus channel name. Normally auto-generated per bot instance.",
    )
    SUBAGENT_BUS_CHANNEL: str | None = Field(
        default=None,
        description="Retired bus-channel env name kept visible for older .env.bot files. Use SUBAGENT_BUS_SESSION_CHANNEL for the active runtime.",
    )

    # ===== LLM: voice runtime =====
    VOICE_LLM_PROVIDER: str = Field(
        default="google",
        description="Provider for the voice runtime LLM. One of 'openai', 'anthropic', 'google', 'minimax'.",
    )
    VOICE_LLM_MODEL: str | None = Field(
        default=None,
        description="Model ID for the voice runtime. Provider-specific default applies when unset.",
    )
    VOICE_LLM_THINKING_BUDGET: int = Field(
        default=0,
        description="Extended-thinking token budget for the voice runtime. 0 disables.",
    )
    VOICE_LLM_FUNCTION_CALL_TIMEOUT_SECS: float = Field(
        default=20.0,
        description="Per-tool-call timeout (seconds) for the voice runtime before falling back / cancelling.",
    )

    # ===== LLM: task agent =====
    TASK_LLM_PROVIDER: str = Field(
        default="google",
        description="Provider for TaskAgent LLM. Same options as VOICE_LLM_PROVIDER.",
    )
    TASK_LLM_MODEL: str | None = Field(
        default=None,
        description="Model ID for TaskAgent. Provider-specific default applies when unset.",
    )
    TASK_LLM_THINKING_BUDGET: int = Field(
        default=4096,
        description="Extended-thinking token budget for TaskAgent. Higher than voice runtime because tasks are autonomous.",
    )
    TASK_LLM_FUNCTION_CALL_TIMEOUT_SECS: float = Field(
        default=20.0,
        description="Per-tool-call timeout (seconds) for the TaskAgent.",
    )
    TASK_AGENT_TIMEOUT: float = Field(
        default=0.0,
        description="Hard timeout (seconds) for an entire TaskAgent run. 0 = no limit.",
    )
    TASK_AGENT_EVENT_DRAIN_GRACE_SECONDS: float = Field(
        default=1.0,
        description="Seconds TaskAgent waits for nearby batched game events before resuming inference.",
    )
    TASK_STEER_CLOSING_WAIT_SECONDS: float = Field(
        default=5.0,
        description=(
            "Seconds start_task waits for a closing task to finish before retrying "
            "inline. Triggered when an auto-steer races the active task's terminal "
            "turn (LLM never sees the intermediate state)."
        ),
    )

    # ===== LLM: context summarization =====
    SUMMARIZATION_LLM_PROVIDER: str = Field(
        default="google",
        description="Provider for the context-summarization LLM. Same options as VOICE_LLM_PROVIDER.",
    )
    SUMMARIZATION_LLM_MODEL: str = Field(
        default="gemini-2.5-flash",
        description="Model ID for the context-summarization LLM. Default is a fast Gemini model.",
    )

    # ===== LLM: UI agent =====
    UI_AGENT_LLM_PROVIDER: str = Field(
        default="google",
        description="Provider for the UIAgent LLM (autonomous UI control).",
    )
    UI_AGENT_LLM_MODEL: str = Field(
        default="gemini-2.5-flash",
        description="Model ID for UIAgent. Default is a fast Gemini model since UI decisions need low latency.",
    )
    UI_AGENT_LLM_THINKING_BUDGET: int = Field(
        default=0,
        description="Extended-thinking token budget for UIAgent. 0 disables.",
    )
    UI_AGENT_STATUS_TIMEOUT_SECS: float = Field(
        default=10.0,
        description="Timeout (seconds) for UIAgent status RPCs.",
    )
    UI_AGENT_PORTS_LIST_TIMEOUT_SECS: float = Field(
        default=15.0,
        description="Timeout (seconds) for the UIAgent 'list ports' RPC.",
    )
    UI_AGENT_SHIPS_LIST_TIMEOUT_SECS: float = Field(
        default=15.0,
        description="Timeout (seconds) for the UIAgent 'list ships' RPC.",
    )
    UI_AGENT_COURSE_PLOT_TIMEOUT_SECS: float = Field(
        default=25.0,
        description="Timeout (seconds) for the UIAgent 'plot course' RPC.",
    )
    UI_AGENT_PORTS_LIST_STALE_SECS: float = Field(
        default=60.0,
        description="After this many seconds, the cached ports list is considered stale and re-fetched.",
    )
    UI_AGENT_SHIPS_CACHE_TTL_SECS: float = Field(
        default=60.0,
        description="TTL (seconds) for the UIAgent ships cache.",
    )
    UI_AGENT_INTENT_REQUEST_DELAY_SECS: float = Field(
        default=2.0,
        description="Seconds to wait before requesting a deferred UIAgent intent.",
    )

    # ===== LLM provider keys =====
    OPENAI_API_KEY: str | None = Field(
        default=None,
        description="OpenAI API key. Required when any *_LLM_PROVIDER=openai.",
    )
    ANTHROPIC_API_KEY: str | None = Field(
        default=None,
        description="Anthropic API key. Required when any *_LLM_PROVIDER=anthropic.",
    )
    GOOGLE_API_KEY: str | None = Field(
        default=None,
        description="Google AI Studio API key. Required when any *_LLM_PROVIDER=google.",
    )
    MINIMAX_API_KEY: str | None = Field(
        default=None,
        description="MiniMax API key. Required when any *_LLM_PROVIDER=minimax.",
    )
    MINIMAX_BASE_URL: str = Field(
        default="https://api.minimax.io/v1",
        description="Base URL for the Minimax API. Override only if pointing at a proxy / region-specific endpoint.",
    )

    # ===== STT / TTS =====
    STT_PROVIDER: str = Field(
        default="deepgram",
        description="Speech-to-text provider. Currently only 'deepgram' is supported.",
    )
    TTS_PROVIDER: str = Field(
        default="gradium",
        description="Text-to-speech provider. One of 'cartesia', 'gradium', 'elevenlabs'.",
    )
    DEEPGRAM_API_KEY: str | None = Field(
        default=None,
        description="Deepgram API key for speech-to-text.",
    )
    CARTESIA_API_KEY: str | None = Field(
        default=None,
        description="Cartesia API key (used when TTS_PROVIDER=cartesia).",
    )
    GRADIUM_API_KEY: str | None = Field(
        default=None,
        description="Gradium API key (used when TTS_PROVIDER=gradium).",
    )

    # ===== Daily.co transport / recording =====
    DAILY_API_KEY: str | None = Field(
        default=None,
        description="Daily.co API key for WebRTC room creation and recording.",
    )
    DAILY_RECORDING_BUCKET_NAME: str | None = Field(
        default=None,
        description="S3 bucket name where Daily.co writes session recordings.",
    )
    DAILY_RECORDING_BUCKET_REGION: str | None = Field(
        default=None,
        description="AWS region of the Daily.co recording bucket.",
    )
    DAILY_RECORDING_ASSUME_ROLE_ARN: str | None = Field(
        default=None,
        description="IAM role ARN that Daily.co assumes to write to the recording bucket.",
    )

    # ===== AWS (smart turn / context upload) =====
    AWS_ACCESS_KEY_ID: str = Field(
        default="",
        description="AWS access key for smart-turn and context-upload S3 writes.",
    )
    AWS_SECRET_ACCESS_KEY: str = Field(
        default="",
        description="AWS secret access key paired with AWS_ACCESS_KEY_ID.",
    )
    AWS_REGION: str = Field(
        default="us-east-1",
        description="AWS region for smart-turn and context-upload operations.",
    )
    SMART_TURN_S3_BUCKET: str | None = Field(
        default=None,
        description="S3 bucket where smart-turn audio artifacts are uploaded.",
    )
    CONTEXT_S3_BUCKET: str | None = Field(
        default=None,
        description="S3 bucket where conversation context summaries are uploaded.",
    )

    # ===== Bot runtime =====
    BOT_USE_KRISP: bool = Field(
        default=False,
        description="Enable Krisp noise-suppression filter on the bot's audio input. Leave False in local dev (the native krisp_audio package is PCC-only).",
    )
    BOT_TEST_CHARACTER_ID: str | None = Field(
        default=None,
        description="Pin the bot to a specific character ID for local testing (bypasses normal login flow).",
    )
    BOT_TEST_CHARACTER_NAME: str | None = Field(
        default=None,
        description="Display name override for the test character.",
    )
    BOT_TEST_NPC_CHARACTER_NAME: str | None = Field(
        default=None,
        description="NPC character name for local NPC testing scenarios.",
    )
    BOT_TEST_ACCESS_TOKEN: str | None = Field(
        default=None,
        description="Pre-baked access token used by the test character flow.",
    )
    BOT_IDLE_REPORT_TIME: float = Field(
        default=9.0,
        description="Seconds of conversational silence before the bot considers the player idle.",
    )
    BOT_IDLE_REPORT_COOLDOWN: float = Field(
        default=45.0,
        description="Minimum seconds between consecutive idle-report nudges.",
    )
    BOT_IDLE_REPORT_ENABLED: bool = Field(
        default=True,
        description="Master toggle for idle-report behaviour.",
    )
    BOT_NEW_PLAYER_ONBOARDING: bool = Field(
        default=True,
        description="Enable prompt injection and route seeding for players with no known mega-port. Set false for evals/tests.",
    )
    CONTEXT_SUMMARIZATION_MESSAGE_LIMIT: int = Field(
        default=200,
        description="Number of conversation messages retained before triggering context summarization.",
    )
    USE_EDGE_TOKEN_FOR_AUTH: bool = Field(
        default=False,
        description="When true, the bot authenticates to edge functions with EDGE_API_TOKEN instead of an anon JWT.",
    )

    # ===== BYOA (Bring-Your-Own-Agent) =====
    BYOA_AGENT_WAKE_TIMEOUT_SECONDS: float = Field(
        default=30.0,
        description="Timeout (seconds) waiting for a BYOA agent to ack a wake handshake.",
    )
    BYOA_TOOL_CALL_TIMEOUT_SECONDS: float = Field(
        default=30.0,
        description="Per-RPC timeout (seconds) when the BYOA agent calls a game tool.",
    )
    BYOA_AGENT_IDLE_TEARDOWN_SECONDS: float = Field(
        default=300.0,
        description="If a BYOA agent has no activity for this long (seconds), the harness tears it down.",
    )
    BYOA_WAKE_TARGET: str = Field(
        default="noop",
        description="wake_agent spawn target. The Supabase edge function reads this when waking external BYOA runners.",
    )
    BYOA_BUS_DATABASE_URL: str | None = Field(
        default=None,
        description="Restricted BYOA bus DSN handed to external BYOA runner processes by wake_agent.",
    )
    BYOA_BUS_DB_USER: str = Field(
        default="byoa_login",
        description="Postgres role name used when provisioning the restricted BYOA bus login.",
    )
    BYOA_BUS_DB_PASSWORD: str | None = Field(
        default=None,
        description="Password used when provisioning the restricted BYOA bus login.",
    )
    BYOA_TASK_ID: str | None = Field(
        default=None,
        description="Task ID injected by the BYOA invocation. Not user-set.",
    )
    BYOA_WAKE_REQUEST_ID: str | None = Field(
        default=None,
        description="Wake request ID injected by the BYOA invocation. Not user-set.",
    )
    BYOA_PROMPT: str | None = Field(
        default=None,
        description="Inline task prompt for a one-off BYOA run. Mutually exclusive with BYOA_PROMPT_FILE.",
    )
    BYOA_PROMPT_FILE: str | None = Field(
        default=None,
        description="Path to a file containing the task prompt for a BYOA run.",
    )

    # ===== Tracing / observability =====
    WANDB_API_KEY: str | None = Field(
        default=None,
        description="Weights & Biases API key for Weave tracing.",
    )
    WEAVE_PROJECT: str = Field(
        default="gradientbang",
        description="Weave project name to log traces under.",
    )
    CEKURA_API_KEY: str | None = Field(
        default=None,
        description="Cekura tracer API key. Required when CEKURA_TRACER_ENABLED=true.",
    )
    CEKURA_AGENT_ID: str | None = Field(
        default=None,
        description="Cekura agent identifier this bot instance reports as.",
    )
    CEKURA_TRACER_ENABLED: bool = Field(
        default=False,
        description="Master toggle for the Cekura tracer. Must be explicitly true to enable.",
    )
    TOKEN_USAGE_LOG: str | None = Field(
        default=None,
        description="Optional CSV path for LLM token usage logging.",
    )

    # ===== Data directories =====
    GRADIENTBANG_WORLD_DATA_DIR: str = Field(
        default="tmp/world-data",
        description="Directory holding generated universe artifacts (universe.json) before they are loaded into Supabase.",
    )
    GRADIENTBANG_QUEST_DATA_DIR: str = Field(
        default="data/quests",
        description="Directory used by quest loading tooling for quest definition JSON files.",
    )


settings = Settings()
