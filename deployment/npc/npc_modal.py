"""Modal deployment for Gradient Bang NPC agents.

Spawns a TaskAgent that connects to the game via Supabase and uses
a self-hosted vLLM Nemotron instance for inference.

Usage:
    # Deploy
    uv run --group npc modal deploy deployment/npc/npc_modal.py

    # Run locally (calls Modal remote)
    uv run --group npc modal run deployment/npc/npc_modal.py --character-id npc-01

    # With a specific personality fragment
    uv run --group npc modal run deployment/npc/npc_modal.py --character-id npc-01 --fragment aggressive

    # Spawn from Python
    import modal
    NPC = modal.Cls.from_name("gb-npc", "NPC")
    NPC().run.spawn(character_id="npc-01", fragment="aggressive")
"""

from __future__ import annotations

import os
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


@app.cls(
    image=npc_image,
    secrets=[modal.Secret.from_name("gb-npc")],
    scaledown_window=15 * MINUTES,
    timeout=30 * MINUTES,
)
class NPC:
    """Warm-container NPC agent.

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
        self.model_name = os.environ.get("MODEL_NAME", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16")

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
        """Run an NPC agent for the given character.

        Args:
            character_id: Game character ID to control.
            fragment: Name of the personality fragment (e.g. "aggressive").
                      If None, a random fragment is chosen.
        """
        import random

        from loguru import logger
        from pipecat.services.openai.llm import OpenAILLMService

        from gradientbang.utils.base_llm_agent import LLMConfig
        from gradientbang.utils.supabase_client import AsyncGameClient
        from gradientbang.utils.task_agent import TaskAgent

        # -- Build NPC task prompt (base + fragment) ---------------------
        if fragment is None and self.fragments:
            fragment = random.choice(list(self.fragments.keys()))

        parts = [self.base_prompt] if self.base_prompt else []
        if fragment and fragment in self.fragments:
            parts.append(self.fragments[fragment])
        elif fragment and fragment not in self.fragments:
            logger.warning(
                f"Unknown fragment '{fragment}', available: {list(self.fragments.keys())}"
            )

        task_prompt = "\n\n".join(parts) if parts else "Explore the universe."

        logger.info(
            f"[NPC] spawning  character={character_id}  "
            f"fragment={fragment}  task_len={len(task_prompt)}"
        )

        # -- Custom LLM factory (points at our vLLM instance) ----------
        llm_url = self.llm_service_url
        model = self.model_name

        def make_llm():
            return OpenAILLMService(
                base_url=f"{llm_url.rstrip('/')}/v1",
                api_key="not-needed",
                model=model,
            )

        # -- Connect to game and run agent ------------------------------
        async with AsyncGameClient(
            character_id=character_id,
        ) as game_client:
            await game_client.pause_event_delivery()

            try:
                await game_client.join(character_id)
            except Exception as exc:
                logger.error(f"Failed to join as {character_id}: {exc}")
                return False

            logger.info(f"[NPC] joined as {character_id}")

            agent = TaskAgent(
                game_client=game_client,
                character_id=character_id,
                config=LLMConfig(model=model),
                llm_service_factory=make_llm,
            )

            success = await agent.run_task(task=task_prompt)

            if success:
                logger.info(f"[NPC] {character_id} task completed successfully")
            else:
                logger.warning(f"[NPC] {character_id} task did not complete")

            return success


# ---------------------------------------------------------------------------
# CLI entry point: modal run deployment/npc/npc_modal.py ...
# ---------------------------------------------------------------------------


@app.local_entrypoint()
def main(character_id: str, fragment: str = ""):
    npc = NPC()
    npc.run.remote(
        character_id=character_id,
        fragment=fragment if fragment else None,
    )
