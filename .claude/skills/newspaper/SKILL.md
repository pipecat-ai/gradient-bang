---
name: newspaper
description: Generate Gradient News & Observer assets (banners, front pages, prompt experiments) by dispatching to the right newspaper script. Usage `/newspaper <asset-type> [args]` where asset-type is `banner`, `front-page`, or `prompt-experiment`.
---

# Newspaper Asset Generator

Single entry point for all *Gradient News & Observer* image assets. Routes to the underlying script based on the asset type.

## Usage

`/newspaper <asset-type> [args]`

Asset types:

- `banner` — single wide masthead-style banner (e.g. CALL TO ARMS recruiting header). Handled below.
- `front-page` — full ten-section newspaper front page from real game events. Hands off to **[`/news-front-page`](../news-front-page/SKILL.md)** — invoke that skill directly instead.
- `prompt-experiment` — sweep prompt variants for front-page rendering. Calls `news-front-page-prompt-experiment` (see [src/gradientbang/newspaper/scripts/prompt_experiment.py](../../../src/gradientbang/newspaper/scripts/prompt_experiment.py) for flags).

If the user passes an unrecognized asset type, list the three options above and stop — do not guess.

## All output goes under `artifacts/`

`artifacts/` is gitignored. Both copy markdown and rendered PNGs live there. Subdirectories per asset type:

- `artifacts/banners/`
- `artifacts/gradient-news-observer-regions/` (front-page composited)
- `artifacts/gradient-news-observer-images/` (front-page one-shot)

## Banner workflow

A banner is a single wide image with one dramatic headline + short body + call-to-action. Used for recruiting drives, special-edition broadsides, channel headers, etc.

### Step 1 — gather copy from the user

Required inputs:

- **Headline** (largest type — e.g. `CALL TO ARMS`)
- **Subhead** (one line — e.g. `Pilots Wanted to Test the Combat Rework`)
- **Body** (1–3 short sentences setting the stakes)
- **Call to action** (e.g. `Join the test → #gradient-bang`)

Optional:

- **Kicker** (small caps line above the headline; defaults to `THE GRADIENT NEWS & OBSERVER · SPECIAL EDITION`)
- **Slug** (short filename stem, kebab-case; defaults to a slugified headline)

If the user's prompt only gives you a topic ("call to arms for combat rework"), draft kicker/headline/subhead/body/CTA yourself in the newspaper's voice and confirm with the user before rendering — image-edit calls take ~2 minutes and cost real money.

### Step 2 — write the copy markdown

Write to `artifacts/banners/<slug>.md` using this exact structure (each line on its own line, blank lines between blocks). Every visible word in the file is rendered verbatim — no extra hidden formatting.

```
<KICKER>

<HEADLINE>

<Subhead>

<Body sentences.>

<Call to action>
```

Keep total visible word count under ~50 — banners get cramped fast. If body runs long, trim it.

### Step 3 — render

```bash
set -a && source .env.bot && set +a
uv run news-banner --copy-file artifacts/banners/<slug>.md
```

- Sources `.env.bot` because that's where `OPENAI_API_KEY` lives in this repo (the script also auto-loads it from `.env` if present).
- Defaults to `2048x1024` (clean 2:1 banner). For wider Discord-banner shapes, append `--size 2880x1024`. Both dims must be multiples of 16; max edge 3840; max ratio 3:1.
- Defaults to the masthead reference. For a busier full-page-style aesthetic, append `--reference src/gradientbang/newspaper/assets/references/full-page-style-fri-sat-pt.png`.
- Render takes ~120–150s. Stream stdout — the script prints the final PNG path on success.
- Pass `--force` to overwrite an existing PNG with the same name.

### Step 4 — show the result

Read the generated PNG so the image is visible in chat, then summarize with the artifact path. The user reviews and either accepts, edits the markdown and re-renders, or asks for a fresh take (image-edit isn't deterministic — same input can produce a different layout).

## Front-page workflow

Don't replicate the front-page logic here. Tell the user:

> Front pages are a different animal — they pull real game events into a structured digest, then render a 2160×3840 ten-story page. Use `/news-front-page [duration]` (e.g. `/news-front-page 24h`).

If they explicitly want to re-render an existing markdown front page without regenerating the digest, they can call `news-front-page-image --front-page-md <path>` directly.

## Prompt-experiment workflow

This is a power-user tool for sweeping prompt variants. Run with `--help` first to surface the flags, then construct the right command for the user's question:

```bash
uv run news-front-page-prompt-experiment --help
```

## Rules

- **Always confirm copy before spending an image-edit call.** Each one costs and takes ~2 min. Cheap to iterate on markdown, expensive to iterate on images.
- **Only edit `artifacts/`** for copy and outputs. Don't write under `src/` for one-off banners.
- **Don't invent new script entry points.** If the user wants something the existing scripts don't support (e.g. a different aspect or new layout), discuss the trade-off before adding code.
- **Don't commit anything.** The user reviews artifacts and decides what to share.
