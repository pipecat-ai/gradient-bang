# Eval

Voice agent evaluation using [Cekura](https://cekura.com).

## Overview

Cekura runs automated voice calls against the bot, simulating player interactions (e.g. navigating, trading, combat). After each call, Cekura sends a webhook event to our server so we can react to results — reset game state, log outcomes, etc.

The flow:

1. **Seed** the database with eval-specific characters (known starting states)
2. **Run evals** on Cekura — each eval calls the bot as a specific character
3. **Webhook fires** — Cekura POSTs `result.completed` to our webhook server
4. **Re-seed** the character to reset game state for the next run

## Directory structure

```
tests/eval/
├── README.md
└── webhook_server/
    ├── Dockerfile
    ├── main.py                    # FastAPI webhook server
    ├── .env                       # Environment variables
    ├── pyproject.toml
    ├── seed_eval_characters.sql   # Main seed (all characters)
    └── seeds/                     # Per-character seed scripts
        ├── alpha_sparrow.sql
        ├── beta_kestrel.sql
        ├── gamma_explorer.sql
        ├── delta_fleet.sql
        └── epsilon_corp.sql
```

## Webhook server

Simple FastAPI server that receives Cekura webhook events.

### Routes

| Method | Path              | Description                              |
|--------|-------------------|------------------------------------------|
| GET    | `/`               | Health check                             |
| POST   | `/handle_webhook` | Webhook handler (routes by `event_type`) |

### Environment variables

```bash
cp env.example .env
```

Set env var values:

- `X_CEKURA_SECRET` — shared secret for authenticating webhook requests
- `NGROK_DOMAIN` — ngrok subdomain for tunneling
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — service role key for database access
- `LOCAL_API_POSTGRES_URL` — PostgreSQL connection string for running seed scripts

### Prerequisites

The webhook server shells out to `psql` to run seed scripts. Install it locally:

```bash
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

(The Dockerfile installs `postgresql-client` automatically for deployed environments.)

### Run

```bash
cd tests/eval/webhook_server
uv run uvicorn main:app --reload --port 8883
```

### Tunnel with ngrok

```bash
ngrok http --subdomain="${NGROK_DOMAIN}" 8883
```

Use the ngrok forwarding URL as the webhook base URL in Cekura.

### Deploy to AWS (App Runner + ECR)

Requires the [AWS CLI](https://aws.amazon.com/cli/) with credentials configured.

**1. Create an ECR repository (one-time):**

```bash
aws ecr create-repository --repository-name gb-eval-webhook --region us-west-2
```

**2. Build and push the image:**

```bash
cd tests/eval/webhook_server

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=us-west-2
ECR_URI=$AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/gb-eval-webhook

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ECR_URI

docker build --platform linux/amd64 -t gb-eval-webhook .
docker tag gb-eval-webhook:latest $ECR_URI:latest
docker push $ECR_URI:latest
```

**3. Create the App Runner service (one-time):**

- Go to [AWS App Runner console](https://console.aws.amazon.com/apprunner)
- Source: **Container registry** → **Amazon ECR** → select `gb-eval-webhook:latest`
- Port: **8883**
- Environment variables: set `X_CEKURA_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `LOCAL_API_POSTGRES_URL`
- Create & deploy

**4. Get the webhook URL:**

App Runner assigns a URL like:

```
https://<service-id>.<region>.awsapprunner.com
```

Find it in the App Runner console under your service's **Default domain**. Set the Cekura webhook URL to:

```
https://<service-id>.<region>.awsapprunner.com/handle_webhook
```

**5. Subsequent deploys:**

After pushing a new image to ECR, trigger a deploy from the App Runner console or via CLI:

```bash
aws apprunner start-deployment --service-arn <your-service-arn> --region us-west-2
```

## SQL seed scripts

Each eval character has a deterministic starting state (ship type, credits, map knowledge, etc.) so evals produce repeatable results. The seed scripts create these characters and can be re-run to reset them to their starting state — every script tears down existing data before re-inserting.

### Characters

| Character            | Ship(s)                            | Notes                                    | Cekura Agent                  | Character ID                          |
|----------------------|------------------------------------|------------------------------------------|-------------------------------|---------------------------------------|
| Alpha Sparrow Eval   | sparrow_scout                      | Fresh starter character                  | gb-bot-eval-sparrow-scout     | a0000000-0000-4000-8000-000000000001  |
| Beta Kestrel Eval    | kestrel_courier                    | 10k ship credits, 5k megabank            | gb-bot-eval-kestrel-courier   | b0000000-0000-4000-8000-000000000002  |
| Gamma Explorer Eval  | parhelion_seeker                   | 40 sectors visited, well-explored map    | gb-bot-eval-gamma-explorer    | c0000000-0000-4000-8000-000000000003  |
| Delta Fleet Eval     | wayfarer_freighter, corsair_raider, kestrel_courier | Multi-ship owner, 50k megabank | gb-bot-eval-delta-fleet | d0000000-0000-4000-8000-000000000004 |
| Epsilon Corp Eval    | sparrow_scout + corp pike_frigate  | Corporation member with corp-owned ship  | gb-bot-eval-epsilon-corp      | e0000000-0000-4000-8000-000000000005  |

All characters are linked to a single eval user (`352373e1-...`).

### Usage

Seed **all** eval characters at once (full teardown + re-insert):

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seed_eval_characters.sql
```

Reset a **single** character back to its starting state:

```bash
psql $LOCAL_API_POSTGRES_URL -f tests/eval/webhook_server/seeds/alpha_sparrow.sql
```

The per-character scripts are useful after an eval run mutates game state — re-run the relevant seed to reset that character without touching the others.
