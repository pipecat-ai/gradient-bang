### simple server to handle Cekura webhook events


import os
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from supabase import Client, create_client

load_dotenv()

SEEDS_DIR = Path(__file__).parent / "seeds"
POSTGRES_URL = os.environ["LOCAL_API_POSTGRES_URL"]

supabase: Client = create_client(
    os.environ["SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
)


def run_seed(seed_file: Path) -> tuple[bool, str]:
    """Execute a single seed .sql file via psql. Returns (ok, stdout_or_stderr)."""
    result = subprocess.run(
        ["psql", POSTGRES_URL, "-f", str(seed_file)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False, result.stderr
    return True, result.stdout


@asynccontextmanager
async def lifespan(app: FastAPI):
    """On startup, load every seed file in seeds/ so eval characters exist
    before the first webhook fires."""
    seed_files = sorted(SEEDS_DIR.glob("*.sql"))
    print(f"_____main.py * startup seeding {len(seed_files)} character(s)")
    for seed_file in seed_files:
        ok, output = run_seed(seed_file)
        if ok:
            print(f"_____main.py * seeded {seed_file.name} ok")
        else:
            print(f"_____main.py * seed {seed_file.name} failed: {output}")
    yield


app = FastAPI(lifespan=lifespan)


async def verify_cekura_secret(x_cekura_secret: str = Header(...)):
    expected = os.environ.get("X_CEKURA_SECRET")
    if not expected or x_cekura_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing X-CEKURA-SECRET")


@app.get("/")
async def health(request: Request):
    print(f"_____main.py * up and running")
    return {"status": "up and running"}


@app.post("/handle_webhook", dependencies=[Depends(verify_cekura_secret)])
async def handle_webhook(request: Request):
    payload = await request.json()
    print(f"_____main.py * handle_webhook payload: {payload}")
    event_type = payload.get("event_type")

    match event_type:
        case "result.completed":
            try:
                agent_name = payload.get("data", {}).get("agent_name", "")
                print(f"_____main.py * agent_name: {agent_name}")
                ## heads up: this is brittle; assumes we are desciplined in naming agents
                ## "gb-bot-eval-" + <character name>
                # gb-bot-eval-alpha-sparrow -> alpha_sparrow
                prefix = "gb-bot-eval-"
                if not agent_name.startswith(prefix):
                    return {"error": f"unexpected agent_name: {agent_name}"}, 400

                character_slug = agent_name[len(prefix) :].replace("-", "_")
                seed_file = SEEDS_DIR / f"{character_slug}.sql"

                if not seed_file.exists():
                    return {"error": f"no seed file for: {character_slug}"}, 400

                print(f"_____main.py * re-seeding character: {character_slug}")
                ok, output = run_seed(seed_file)
                if not ok:
                    print(f"_____main.py * seed failed: {output}")
                    return {"error": f"seed failed: {output}"}, 400

                print(f"_____main.py * seed ok: {output}")
            except Exception as e:
                print(f"_____main.py * general 'result.completed' error: {e}")
                return {"error": f"general 'result.completed' error: {e}"}, 400
        case _:
            return {"error": f"unknown event_type: {event_type}"}, 400

    return {"ok": True}
