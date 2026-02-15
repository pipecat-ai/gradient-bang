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

### 4. Run an NPC

**Via CLI (runs remotely on Modal):**

```shell
# Random personality fragment
uv run --group npc modal run npc_modal.py --character-id npc-01

# Specific personality
uv run --group npc modal run npc_modal.py --character-id npc-01 --fragment aggressive
```

**Via Python (fire-and-forget spawn):**

```python
import modal

NPC = modal.Cls.from_name("gb-npc", "NPC")

# Random personality
NPC().run.spawn(character_id="npc-01")

# Specific personality
NPC().run.spawn(character_id="npc-01", fragment="aggressive")
```

## Prompt Fragments

NPC behavior is defined by prompts in `/prompts/`:

- `base.md` — Core NPC behavior, always included
- `fragment_*.md` — Personality modifiers appended to the base

Available fragments:

- `aggressive` — Ruthless fighter, initiates combat, demands tolls
- `friendly` — Cooperative trader, avoids conflict, helps others

To add a new personality, create `prompts/fragment_<name>.md` and redeploy. Fragments are auto-discovered.

## Architecture

```
┌─────────────────────┐
│  modal run / spawn   │
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
          │ HTTP
          ▼
┌─────────────────────┐
│  Supabase           │
│  Edge Functions     │
└─────────────────────┘
```

## Environment Variables

| Variable                    | Required | Description                                                        |
| --------------------------- | -------- | ------------------------------------------------------------------ |
| `LLM_SERVICE_URL`           | Yes      | URL of deployed vLLM instance                                      |
| `MODEL_NAME`                | No       | Model name (default: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16`) |
| `SUPABASE_URL`              | Yes      | Supabase base URL                                                  |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Supabase service role key for auth                                 |
