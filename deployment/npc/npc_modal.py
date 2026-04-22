"""Modal deployment for Gradient Bang NPC agents.

Spawns a TaskAgent that connects to the game via Supabase and uses
a self-hosted vLLM Nemotron instance for inference. The NPC loops
between active (running TaskAgent) and idle (listening for events)
phases indefinitely until manually stopped.

Usage:
    # Deploy
    uv run --group npc modal deploy npc_modal.py

    # Run (blocks until complete)
    uv run --group npc modal run npc_modal.py --character-id npc-01

    # With a specific personality fragment
    uv run --group npc modal run npc_modal.py --character-id npc-01 --fragment aggressive

    # Spawn from Python (fire-and-forget)
    import modal
    NPC = modal.Cls.from_name("gb-npc", "NPC")
    NPC().run.spawn(character_id="npc-01", fragment="aggressive")

    # Status dashboard
    # After deploy, visit the URL printed for the `status` endpoint.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import modal
from dotenv import load_dotenv

# Resolve paths relative to this script (works regardless of cwd)
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent

# Load .env for local dev; on Modal the secrets are injected as env vars
load_dotenv(dotenv_path=SCRIPT_DIR / ".env")

MINUTES = 60  # seconds

# ---------------------------------------------------------------------------
# Wake-up events (pull NPC out of idle when any of these fire)
# ---------------------------------------------------------------------------

WAKE_EVENTS = [
    # Combat
    "combat.round_waiting",
    "combat.round_resolved",
    "combat.ended",
    "combat.action_accepted",
    # Chat
    "chat.message",
    # Sector changes
    "sector.update",
]

# ---------------------------------------------------------------------------
# NPC registry (shared across all containers via Modal Dict)
# ---------------------------------------------------------------------------

NPC_REGISTRY = modal.Dict.from_name("npc-registry", create_if_missing=True)


async def _reg_update(character_id: str, **updates) -> dict:
    """Read-modify-write a registry entry in the shared Modal Dict."""
    entry = await NPC_REGISTRY.get.aio(character_id, {})
    entry.update(updates)
    await NPC_REGISTRY.put.aio(character_id, entry)
    return entry


async def _reg_get_all() -> list[dict]:
    """Get all NPC entries from the shared registry."""
    entries = []
    async for key in NPC_REGISTRY.keys.aio():
        val = await NPC_REGISTRY.get.aio(key)
        if val is not None:
            entries.append(val)
    return entries


async def _reg_contains(character_id: str) -> bool:
    return await NPC_REGISTRY.contains.aio(character_id)

# ---------------------------------------------------------------------------
# Image
# ---------------------------------------------------------------------------

npc_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "pipecat-ai[openai]==0.0.101",
        "openai==1.99.5",
        "httpx>=0.27.0",
        "python-dotenv>=1.1.1",
        "loguru>=0.7.0",
        "rich>=13.0.0",
        "fastapi[standard]",
    )
    # Include the full gradientbang package (incl. .md prompt files)
    .add_local_dir(str(REPO_ROOT / "src" / "gradientbang"), remote_path="/root/gradientbang")
    # NPC personality prompts
    .add_local_dir(str(SCRIPT_DIR / "prompts"), remote_path="/app/npc_prompts")
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = modal.App("gb-npc")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_reactive_prompt(base_prompt: str, fragment_text: str, event: dict) -> str:
    """Build a task prompt that reacts to a wake-up event."""
    parts = []
    if base_prompt:
        parts.append(base_prompt)
    if fragment_text:
        parts.append(fragment_text)
    parts.append(
        "## Wake-up Event\n"
        "You were idle and the following event occurred:\n"
        f"```json\n{json.dumps(event, indent=2, default=str)}\n```\n\n"
        "React to this event appropriately using your tools. "
        "When you have finished reacting, call the `finished` tool."
    )
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# NPC class
# ---------------------------------------------------------------------------


@app.cls(
    image=npc_image,
    secrets=[modal.Secret.from_name("gb-npc")],
    scaledown_window=60 * MINUTES,  # stay warm; NPCs are long-lived
    timeout=24 * 60 * MINUTES,  # allow up to 24h runtime
)
class NPC:
    """Long-lived NPC agent that loops between active and idle phases.

    @modal.enter() runs once when the container starts. Prompt files and
    config are loaded into memory so subsequent .run() calls are instant.
    """

    @modal.enter()
    def setup(self):
        prompts_dir = Path("/app/npc_prompts")

        # Load base prompt
        base_path = prompts_dir / "base.md"
        self.base_prompt = (
            base_path.read_text(encoding="utf-8").strip() if base_path.exists() else ""
        )

        # Auto-discover fragment_*.md files
        self.fragments: dict[str, str] = {}
        for f in sorted(prompts_dir.glob("fragment_*.md")):
            name = f.stem.removeprefix("fragment_")
            text = f.read_text(encoding="utf-8").strip()
            if text:
                self.fragments[name] = text

        # Config from env
        self.llm_service_url = os.environ["LLM_SERVICE_URL"]
        self.model_name = os.environ.get(
            "MODEL_NAME", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"
        )

        fragment_names = ", ".join(self.fragments.keys()) or "(none)"
        print(
            f"[NPC] ready  model={self.model_name}  "
            f"fragments=[{fragment_names}]  "
            f"base_prompt_len={len(self.base_prompt)}"
        )

    # ------------------------------------------------------------------
    # Main entry point
    # ------------------------------------------------------------------

    @modal.method()
    async def run(self, character_id: str, fragment: str | None = None):
        """Run an NPC agent indefinitely for the given character.

        Loops between active (TaskAgent running) and idle (event-listening)
        phases until the container is stopped.

        Args:
            character_id: Game character ID to control.
            fragment: Name of the personality fragment (e.g. "aggressive").
                      If None, a random fragment is chosen.
        """
        import asyncio
        import random

        from loguru import logger
        from pipecat.services.openai.llm import OpenAILLMService

        from gradientbang.utils.base_llm_agent import LLMConfig
        from gradientbang.utils.supabase_client import AsyncGameClient
        from gradientbang.utils.task_agent import TaskAgent

        # -- Choose fragment -----------------------------------------------
        if fragment is None and self.fragments:
            fragment = random.choice(list(self.fragments.keys()))

        fragment_text = ""
        if fragment and fragment in self.fragments:
            fragment_text = self.fragments[fragment]
        elif fragment and fragment not in self.fragments:
            logger.warning(
                f"Unknown fragment '{fragment}', available: {list(self.fragments.keys())}"
            )

        # -- Build initial task prompt ------------------------------------
        parts = [self.base_prompt] if self.base_prompt else []
        if fragment_text:
            parts.append(fragment_text)
        task_prompt = "\n\n".join(parts) if parts else "Explore the universe."

        logger.info(
            f"[NPC] spawning  character={character_id}  "
            f"fragment={fragment}  task_len={len(task_prompt)}"
        )

        # -- Custom LLM factory -------------------------------------------
        llm_url = self.llm_service_url
        model = self.model_name

        def make_llm():
            return OpenAILLMService(
                base_url=f"{llm_url.rstrip('/')}/v1",
                api_key="not-needed",
                model=model,
            )

        # -- Register in NPC_REGISTRY -------------------------------------
        task_count = 0
        await _reg_update(
            character_id,
            character_id=character_id,
            fragment=fragment,
            state="starting",
            current_task=None,
            started_at=_now_iso(),
            last_state_change=_now_iso(),
            task_count=0,
            last_wake_event=None,
        )

        # -- Connect to game and loop -------------------------------------
        try:
            async with AsyncGameClient(
                character_id=character_id,
            ) as game_client:
                await game_client.pause_event_delivery()

                try:
                    await game_client.join(character_id)
                except Exception as exc:
                    logger.error(f"Failed to join as {character_id}: {exc}")
                    await NPC_REGISTRY.pop.aio(character_id, None)
                    return False

                logger.info(f"[NPC] joined as {character_id}")

                while True:
                    # ---- ACTIVE PHASE ----
                    task_count += 1
                    await _reg_update(
                        character_id,
                        state="active",
                        current_task=task_prompt[:120],
                        last_state_change=_now_iso(),
                        task_count=task_count,
                    )

                    logger.info(
                        f"[NPC] {character_id} active phase #{task_count}"
                    )

                    agent = TaskAgent(
                        game_client=game_client,
                        character_id=character_id,
                        config=LLMConfig(model=model),
                        llm_service_factory=make_llm,
                    )

                    success = await agent.run_task(task=task_prompt)

                    if success:
                        logger.info(f"[NPC] {character_id} task completed")
                    else:
                        logger.warning(f"[NPC] {character_id} task did not complete")

                    # ---- IDLE PHASE ----
                    await _reg_update(
                        character_id,
                        state="idle",
                        current_task=None,
                        last_state_change=_now_iso(),
                    )

                    logger.info(
                        f"[NPC] {character_id} entering idle, "
                        f"listening for: {WAKE_EVENTS}"
                    )

                    wake_event = asyncio.Event()
                    wake_context: dict[str, dict] = {}

                    async def on_wake(event_message: dict) -> None:
                        if not wake_event.is_set():
                            wake_context["event"] = event_message
                            wake_event.set()

                    # Register wake-up handlers
                    tokens = []
                    for evt_name in WAKE_EVENTS:
                        tokens.append(
                            game_client.add_event_handler(evt_name, on_wake)
                        )

                    # Wait until something interesting happens
                    await wake_event.wait()

                    # Clean up idle handlers
                    for token in tokens:
                        game_client.remove_event_handler(token)

                    wake_evt = wake_context.get("event", {})
                    wake_type = wake_evt.get("event_type", "unknown")
                    await _reg_update(character_id, last_wake_event=wake_type)

                    logger.info(
                        f"[NPC] {character_id} woke up: {wake_type}"
                    )

                    # Build reactive prompt for next active phase
                    task_prompt = _build_reactive_prompt(
                        self.base_prompt, fragment_text, wake_evt
                    )

        finally:
            await NPC_REGISTRY.pop.aio(character_id, None)
            logger.info(f"[NPC] {character_id} shut down")


# ---------------------------------------------------------------------------
# Status dashboard
# ---------------------------------------------------------------------------


async def _render_status_html() -> str:
    """Render the NPC registry as a simple HTML dashboard."""
    now = _now_iso()
    rows = ""
    for npc in sorted(await _reg_get_all(), key=lambda n: n.get("character_id", "")):
        state = npc["state"]
        state_class = {"active": "active", "idle": "idle"}.get(state, "starting")
        rows += f"""
        <tr>
            <td><code>{npc['character_id']}</code></td>
            <td>{npc.get('fragment') or '—'}</td>
            <td><span class="badge {state_class}">{state}</span></td>
            <td>{npc.get('current_task') or '—'}</td>
            <td>{npc.get('task_count', 0)}</td>
            <td>{npc.get('last_wake_event') or '—'}</td>
            <td>{npc.get('started_at', '—')}</td>
            <td>{npc.get('last_state_change', '—')}</td>
        </tr>"""

    if not rows:
        rows = '<tr><td colspan="8" style="text-align:center;color:#888;">No NPCs running on this container</td></tr>'

    # Build fragment options for the spawn form
    fragment_names = _get_fragment_names()
    fragment_options = '<option value="">Random</option>'
    for name in fragment_names:
        fragment_options += f'<option value="{name}">{name}</option>'

    return f"""<!DOCTYPE html>
<html>
<head>
    <title>Gradient Bang — NPC Status</title>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="10">
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
               background: #0a0a0a; color: #e0e0e0; padding: 2rem; }}
        h1 {{ font-size: 1.4rem; margin-bottom: 0.5rem; color: #fff; }}
        .meta {{ font-size: 0.8rem; color: #666; margin-bottom: 1.5rem; }}
        table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
        th {{ text-align: left; padding: 0.6rem 0.8rem; border-bottom: 2px solid #333;
             color: #888; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; }}
        td {{ padding: 0.6rem 0.8rem; border-bottom: 1px solid #1a1a1a; }}
        tr:hover td {{ background: #111; }}
        code {{ background: #1a1a1a; padding: 0.15rem 0.4rem; border-radius: 3px;
               font-size: 0.8rem; }}
        .badge {{ padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.7rem;
                 font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }}
        .badge.active {{ background: #0f3d0f; color: #4ade80; }}
        .badge.idle {{ background: #3d3d0f; color: #facc15; }}
        .badge.starting {{ background: #0f2d3d; color: #38bdf8; }}
        .spawn-form {{ margin-bottom: 2rem; padding: 1.2rem; background: #111;
                      border: 1px solid #222; border-radius: 8px; }}
        .spawn-form h2 {{ font-size: 0.9rem; margin-bottom: 0.8rem; color: #ccc; }}
        .spawn-form .fields {{ display: flex; gap: 0.6rem; align-items: flex-end; flex-wrap: wrap; }}
        .spawn-form label {{ display: block; font-size: 0.7rem; color: #888;
                           text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem; }}
        .spawn-form input, .spawn-form select {{
            background: #0a0a0a; border: 1px solid #333; color: #e0e0e0;
            padding: 0.5rem 0.7rem; border-radius: 4px; font-size: 0.85rem;
            font-family: inherit; }}
        .spawn-form input:focus, .spawn-form select:focus {{
            outline: none; border-color: #4ade80; }}
        .spawn-form input[type="text"] {{ width: 280px; }}
        .spawn-form button {{
            background: #166534; color: #fff; border: none; padding: 0.5rem 1.2rem;
            border-radius: 4px; font-size: 0.85rem; cursor: pointer; font-family: inherit;
            font-weight: 600; }}
        .spawn-form button:hover {{ background: #15803d; }}
        .spawn-form button:disabled {{ background: #333; color: #666; cursor: not-allowed; }}
        .spawn-msg {{ margin-top: 0.6rem; font-size: 0.8rem; }}
        .spawn-msg.ok {{ color: #4ade80; }}
        .spawn-msg.err {{ color: #f87171; }}
    </style>
</head>
<body>
    <h1>Gradient Bang — NPC Status</h1>
    <p class="meta">Container snapshot at {now} &middot; Auto-refreshes every 10s</p>

    <div class="spawn-form">
        <h2>Spawn NPC</h2>
        <div class="fields">
            <div>
                <label for="char-id">Character ID</label>
                <input type="text" id="char-id" placeholder="e.g. npc-01 or UUID" />
            </div>
            <div>
                <label for="frag">Fragment</label>
                <select id="frag">
                    {fragment_options}
                </select>
            </div>
            <div>
                <button id="spawn-btn" onclick="spawnNpc()">Spawn</button>
            </div>
        </div>
        <div id="spawn-msg" class="spawn-msg"></div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Character</th>
                <th>Fragment</th>
                <th>State</th>
                <th>Current Task</th>
                <th>Tasks Run</th>
                <th>Last Wake Event</th>
                <th>Started</th>
                <th>Last Change</th>
            </tr>
        </thead>
        <tbody>
            {rows}
        </tbody>
    </table>

    <script>
        async function spawnNpc() {{
            const charId = document.getElementById('char-id').value.trim();
            const frag = document.getElementById('frag').value;
            const btn = document.getElementById('spawn-btn');
            const msg = document.getElementById('spawn-msg');

            if (!charId) {{
                msg.textContent = 'Character ID is required';
                msg.className = 'spawn-msg err';
                return;
            }}

            btn.disabled = true;
            btn.textContent = 'Spawning...';
            msg.textContent = '';

            try {{
                const params = new URLSearchParams({{ character_id: charId }});
                if (frag) params.set('fragment', frag);
                const resp = await fetch('/spawn?' + params.toString());
                const text = await resp.text();
                let data;
                try {{ data = JSON.parse(text); }} catch {{ data = null; }}
                if (resp.ok) {{
                    msg.textContent = (data && data.message) || 'Spawned!';
                    msg.className = 'spawn-msg ok';
                    document.getElementById('char-id').value = '';
                }} else {{
                    let errMsg = 'Spawn failed (' + resp.status + ')';
                    if (data) {{
                        if (typeof data.detail === 'string') errMsg = data.detail;
                        else if (Array.isArray(data.detail)) errMsg = data.detail.map(d => d.msg || JSON.stringify(d)).join('; ');
                        else if (data.error) errMsg = data.error;
                        else errMsg = JSON.stringify(data);
                    }} else {{
                        errMsg = text || errMsg;
                    }}
                    msg.textContent = errMsg;
                    msg.className = 'spawn-msg err';
                }}
            }} catch (e) {{
                msg.textContent = 'Request failed: ' + e.message;
                msg.className = 'spawn-msg err';
            }} finally {{
                btn.disabled = false;
                btn.textContent = 'Spawn';
            }}
        }}

        document.getElementById('char-id').addEventListener('keydown', function(e) {{
            if (e.key === 'Enter') spawnNpc();
        }});
    </script>
</body>
</html>"""


def _get_fragment_names() -> list[str]:
    """Read available fragment names from the prompts dir."""
    prompts_dir = Path("/app/npc_prompts")
    if not prompts_dir.exists():
        # Local dev fallback
        prompts_dir = SCRIPT_DIR / "prompts"
    names = []
    for f in sorted(prompts_dir.glob("fragment_*.md")):
        names.append(f.stem.removeprefix("fragment_"))
    return names


@app.function(
    image=npc_image,
    secrets=[modal.Secret.from_name("gb-npc")],
    min_containers=1,
)
@modal.asgi_app()
def dashboard():
    """NPC status dashboard with spawn controls."""
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse, JSONResponse

    web_app = FastAPI()

    @web_app.get("/")
    async def index():
        return HTMLResponse(content=await _render_status_html())

    @web_app.get("/spawn")
    async def spawn(character_id: str, fragment: str = ""):
        character_id = character_id.strip()
        fragment = fragment.strip() or None

        if not character_id:
            return JSONResponse({"error": "character_id is required"}, status_code=400)

        if await _reg_contains(character_id):
            return JSONResponse(
                {"error": f"{character_id} is already running"}, status_code=409
            )

        npc = NPC()
        await npc.run.spawn.aio(character_id=character_id, fragment=fragment)

        frag_label = fragment or "random"
        return JSONResponse({"message": f"Spawned {character_id} (fragment={frag_label})"})

    return web_app


# ---------------------------------------------------------------------------
# CLI entry point: modal run npc_modal.py ...
# ---------------------------------------------------------------------------


@app.local_entrypoint()
def main(character_id: str, fragment: str = ""):
    npc = NPC()
    npc.run.remote(
        character_id=character_id,
        fragment=fragment if fragment else None,
    )
