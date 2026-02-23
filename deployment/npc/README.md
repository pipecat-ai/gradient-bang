# NPC, vLLM (Nemotron) and Supervisor

## Quickstart

Install dependencies and login to Modal:

```shell
uv sync --group npc
uv run --group npc modal setup
```

### 1. Deploy the vLLM Nemotron service

```shell
uv run --group npc modal deploy vllm_modal.py
```

Note your deployment URL, e.g. `https://{org}--nemotron-nano-vllm-serve.modal.run`

Test the service:

```shell
LLM_SERVICE_URL=https://<org>--nemotron-nano-vllm-serve.modal.run uv run python test_vllm.py
```

> [!NOTE]
> First run may timeout while the model loads. Check logs on modal.com if the healthcheck fails.

### 2. Create `.env` and Modal secrets

Copy the example and fill in your values:

```shell
cp env.example .env
# Edit .env with your values
```

Create the Modal secret from your `.env`:

```shell
uv run --group npc modal secret create gb-npc --from-dotenv .env
```

### 3. Deploy the NPC service

```shell
uv run --group npc modal deploy npc_modal.py
```

This deploys two things:
- **NPC class** — the long-lived NPC agent (spawned on demand)
- **Status dashboard** — always-on web endpoint (`min_containers=1`)

After deploy, Modal prints the URL for the status dashboard, e.g.:

```
Created web function status => https://{org}--gb-npc-status.modal.run
```

Open this URL in a browser to see all running NPCs, their state (active/idle), task count, and last wake event. The page auto-refreshes every 10 seconds.

### 4. Spawn NPCs

**Spawn script (fire-and-forget):**

```shell
# Single NPC, random personality
python spawn_npc.py npc-01

# Single NPC, specific personality
python spawn_npc.py npc-01 --fragment aggressive

# Multiple NPCs at once
python spawn_npc.py npc-01 npc-02 npc-03 --fragment friendly
```

**Via `modal run` (blocks until complete):**

```shell
uv run --group npc modal run npc_modal.py --character-id npc-01
uv run --group npc modal run npc_modal.py --character-id npc-01 --fragment aggressive
```

**Via Python:**

```python
import modal

NPC = modal.Cls.from_name("gb-npc", "NPC")

# Fire-and-forget spawn
NPC().run.spawn(character_id="npc-01", fragment="aggressive")

# Blocking call (waits for completion)
NPC().run.remote(character_id="npc-01", fragment="friendly")
```

### 5. Monitor NPCs

Open the status dashboard URL (printed during deploy) in a browser. It shows:

| Column | Description |
|--------|-------------|
| Character | Character ID |
| Fragment | Personality fragment name |
| State | `active` (running TaskAgent), `idle` (listening for events), or `starting` |
| Current Task | First 120 chars of the active task prompt |
| Tasks Run | How many TaskAgent runs so far |
| Last Wake Event | Event type that woke NPC from idle |
| Started | When the NPC was spawned |
| Last Change | When the state last changed |

NPCs loop between **active** (TaskAgent running, making LLM calls) and **idle** (no inference, listening for game events). They wake from idle when combat, chat, or sector events fire.

## NPC Lifecycle

```
spawn(character_id, fragment)
        │
        ▼
┌──────────────┐
│   ACTIVE     │ TaskAgent running, LLM inference, game tools
│   phase      │
└──────┬───────┘
       │ TaskAgent finishes
       ▼
┌──────────────┐
│   IDLE       │ No inference. Listening for:
│   phase      │   combat.*, chat.message, sector.update
└──────┬───────┘
       │ Wake event fires
       ▼
┌──────────────┐
│   ACTIVE     │ New TaskAgent with reactive prompt
│   phase      │ (includes the event that woke it)
└──────┬───────┘
       │ ... loops indefinitely ...
```

## Prompt Fragments

NPC behavior is defined by prompts in `prompts/`:

- `base.md` — Core NPC behavior, always included
- `fragment_*.md` — Personality modifiers appended to the base

Available fragments:

- `aggressive` — Ruthless fighter, initiates combat, demands tolls
- `friendly` — Cooperative trader, avoids conflict, helps others

To add a new personality, create `prompts/fragment_<name>.md` and redeploy. Fragments are auto-discovered.

## Architecture

```
┌─────────────────────┐
│  spawn / modal run   │
└─────────┬───────────┘
          │ character_id, fragment
          ▼
┌─────────────────────┐     ┌─────────────────────┐
│   NPC (Modal CPU)   │────▶│  vLLM Nemotron      │
│                     │     │  (Modal GPU)         │
│  TaskAgent          │     │  OpenAI-compatible   │
│  + 31 game tools    │     │  /v1/chat/completions│
│  + AsyncGameClient  │     └─────────────────────┘
└─────────┬───────────┘
          │ HTTP            ┌─────────────────────┐
          ▼                 │  Status Dashboard   │
┌─────────────────────┐     │  (always-on)        │
│  Supabase           │     │  /status            │
│  Edge Functions     │     └─────────────────────┘
└─────────────────────┘
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LLM_SERVICE_URL` | Yes | URL of deployed vLLM instance |
| `MODEL_NAME` | No | Model name (default: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`) |
| `SUPABASE_URL` | Yes | Supabase base URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key for auth |
| `EDGE_API_TOKEN` | Yes | Edge function API token |
