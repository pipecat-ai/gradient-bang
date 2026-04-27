---
name: news-front-page
description: Generate a Gradient News & Observer newspaper front page for a time window. Pulls game events into a structured digest, writes ten illustrated story ledes (7 straight news + 2 gossip + 1 market box) into a markdown file, then renders a 2160x3840 newspaper front-page PNG. Usage `/news-front-page [duration]` (default `24h`; e.g. `1h`, `6h`, `7d`).
---

# Generate Newspaper Front Page

Produce a complete edition of *The Gradient News & Observer* for a requested time window: digest → markdown stories → image.

## Parameters

`/news-front-page [duration]`

- **duration** (optional, default `24h`): time window. Accepts `90m`, `1h`, `6h`, `24h`, `7d` — anything `news-digest --duration` understands.
- **env** (optional, default `cloud`): `cloud` → `.env.cloud`, `local` → `.env.supabase`. Production data lives in cloud; local is mostly empty unless the user is testing.
- **skip-image** (optional flag): only run steps 1–3, skip image rendering. Useful for iterating on copy.

If duration is missing, default to `24h` and proceed — do not ask.

## Output files

All under `artifacts/`. Use the digest's `end` timestamp formatted as `YYYYMMDD-HHMMSSZ` UTC for the stem, and `past-<duration>` as the suffix:

- Digest JSON: `artifacts/news-digest-<stem>-past-<duration>.json`
- Front-page Markdown: `artifacts/gradient-news-observer-front-page-<stem>-past-<duration>.md`
- Image PNG: the image script computes the path from the Markdown filename. The default renderer writes a regional composite under `artifacts/gradient-news-observer-regions/`.

## Steps

### 1. Generate the digest JSON

Run `news-digest` to pull events for the requested window into a structured JSON file. Use the entry-point script (registered in `pyproject.toml`):

```bash
uv run news-digest \
  --env-file .env.cloud \
  --duration <duration> \
  --format json \
  --output artifacts/news-digest-<stem>-past-<duration>.json
```

- The script connects read-only to Postgres, pulls all events in the window, dedupes recipient fan-out, and writes a JSON object with `global_stats`, `players`, `leaderboard_ranks`, `period_ranks`, and `warnings`.
- For a 24-hour window the JSON is large (multi-MB). Don't `cat` it. Use `python3 -c` or targeted `Read` calls.

### 2. Mine the digest for storylines

Read the JSON with small Python scripts (via `Bash`) to surface the angles. Useful queries:

- **Top by activity / wealth / trade volume / sectors visited / combat wins / messages / sessions.** Print rank tables with name + key counters for the top 15–25.
- **Notable garrison events.** For each player with `garrison_events`, show the lines containing `placed`, `collected`, `mode_changed`, or `disbanded` (these are the real deployments — the rest are passers-through).
- **Combat events.** For each player with `combat_wins > 0` or `destroyed_ships > 0`, dump the combat log; look for back-to-back attacks on garrisons, defeated targets, multi-round skirmishes, and named opponents.
- **All public chat.** Dedupe broadcasts and direct messages by sender+text and sort by timestamp. Broadcasts are the strongest signal for story angles — pilots announcing intent (toll lanes, recruitment, accusations, public notices of kills).
- **Ship purchases / sales / trade-ins.** Five-or-fewer transactions per day, easy to enumerate.
- **Corporation events.** `corporation.created` and `corporation.disbanded` counts; cross-reference with chat broadcasts that mention a corp name.
- **Leaderboard top 10** for wealth, trading, territory, exploration. Sort by `rank` ascending; show name + score.

You don't need TaskCreate for the mining — it's all read-only Python. Spawn a single `Explore` agent only if the JSON exceeds ~10MB and you want a focused report.

Pick **9 storylines** from what you find. Mix should match the structure below: 7 grounded news beats + 2 dishy gossip angles. Lean toward conflict, status changes, public statements, and surprising aggregates.

### 3. Write the front-page Markdown

Write to `artifacts/gradient-news-observer-front-page-<stem>-past-<duration>.md` using the structure below verbatim. The image generator's prompt template assumes this exact section count and ordering.

#### Structure (10 sections, in order)

| # | Type | Length | Section tag |
|---|---|---|---|
| 1 | Straight news (lead) | Two paragraphs | Story-specific newspaper section — see tagging guide below |
| 2 | Straight news | Two paragraphs | Story-specific newspaper section |
| 3 | Straight news | One short paragraph | Story-specific newspaper section |
| 4 | Straight news | One short paragraph | Story-specific newspaper section |
| 5 | Straight news | One short paragraph | Story-specific newspaper section |
| 6 | Straight news | One short paragraph | Story-specific newspaper section |
| 7 | Straight news | One short paragraph | Story-specific newspaper section |
| 8 | Gossip | 2–3 punchy sentences | Oblique, catty, insider-y tag |
| 9 | Gossip | 2–3 punchy sentences | Oblique, catty, insider-y tag |
| 10 | Market Update | Two markdown tables + footnote | Literally `*Market Update*` |

#### File template

```markdown
# THE GRADIENT NEWS & OBSERVER

**Front-Page Edition — <window length> ending <YYYY-MM-DD HH:MM> UTC**

*"All the news the void allows."*

---

## 1. <Headline>

*<Story-specific section tag — e.g. Combat Wire, Trade & Lanes, Open Channel>*

<Lede paragraph — the strongest single fact or scene.>

<Second paragraph — context, quoted broadcasts, supporting numbers.>

---

## 2. <Headline>

*<Story-specific section tag>*

<Two paragraphs, same shape as story 1.>

---

## 3–7. <Headlines>

*<Story-specific section tag — different per story>*

<One short paragraph each — three to five sentences.>

---

## 8. <Headline>

*<Oblique, catty, insider-y tag — e.g. Salvage Talk>*

<Two or three short, punchy sentences. Vary the opening — see persona guide.>

---

## 9. <Headline>

*<Different oblique, catty, insider-y tag — e.g. The Mega-Port Set>*

<Two or three short, punchy sentences. Different opening from story 8.>

---

## 10. Market Update — <Window> Galactic Index

*Market Update*

| Measure | Value |
| --- | ---: |
| Gross trade volume | $... |
| ... |

| Top of the Boards | Pilot | Score |
| --- | --- | ---: |
| Wealth (lifetime) | ... | ... |
| ... |

---

*All sector numbers used appear in the period's open broadcasts; private direct messages and non-public sector references have been withheld.*
```

The closing italic footnote is required — the image template renders it as a footnote.

### 4. Render the front-page image

Unless `skip-image` was passed, run:

```bash
uv run news-front-page-image \
  --front-page-md artifacts/gradient-news-observer-front-page-<stem>-past-<duration>.md
```

- Defaults to the `composited-regions` renderer, which generates each story region separately and composites them — better text fidelity than the older `one-shot` renderer.
- Defaults to linotype light mode (black ink on white paper, character/ship names bolded). To render the original dark mode (cyan and chartreuse on dark paper, names highlighted in cyan), append `--dark-mode`. Dark mode writes its output dir and composite filename with a `-dark` suffix to keep light and dark renders side by side.
- For comparison or quick iteration, append `--renderer one-shot` to render the whole page in a single image-edit call.
- The script writes the final PNG, per-region prompt text, region PNGs, and metadata JSON. Composited-regions output lives under `artifacts/gradient-news-observer-regions/<stem>/`; one-shot output lives under `artifacts/gradient-news-observer-images/`.
- Composited-regions takes several minutes (one image-edit call per region, run in sequence). One-shot finishes in 30–90 seconds. Stream stdout — both print final paths on success.
- If `OPENAI_API_KEY` isn't in the environment, the script reads it from `.env`.

### 5. Report

Print the three artifact paths (digest JSON, front-page Markdown, image PNG) and the headline of story 1 so the user can open the right files.

## Personas — write in these voices

### Straight news — *New York Times* house style

- Lede paragraph carries the strongest factual beat. Date, place, actor, action.
- Past tense. Third person. Active voice.
- Quote public broadcasts with attribution: *"…", the pilot declared on the open channel.*
- Numbers spelled out under ten in body prose, numerals for stats and credits ($12,533,985).
- No hype, no exclamation points, no scare quotes. The tone is measured even when the facts are dramatic.
- One non-headline-grabbing fact per story is welcome — context that situates the day.

### Gossip — dishy, varied openings

- 2–3 short, punchy sentences. No paragraphs.
- **Vary the opening every time.** "A little kestrel told this columnist…" is one option. Others:
  - "Word from the trading docks…"
  - "Overheard on the open channel at HH:MM UTC…"
  - "Whispers in the wardroom suggest…"
  - "One of your columnist's more reliable informants…"
  - "Spotted at a mega-port this cycle…"
  - "The rumor on the long-range channels…"
- First-person columnist voice ("your columnist," "this column") is fine and characterful.
- Wry, observational, never mean. Tease, don't accuse.

## Section tags

Each story carries a single italic line directly under its headline that names the newspaper section it belongs to. These tags are part of the look — they make the page feel like an actual newspaper instead of a numbered list of stories. Write a fresh tag for every story; never re-use one.

### Tags for straight news (stories 1–7)

Pick a section name that fits the story. Real-newspaper analogues are great when they're the obvious fit (Markets, Corporate Affairs, Cartography). Lean into the retro-space-game theme when there's room to be a little playful (Combat Wire, Trade & Lanes, Open Channel, Shipyard). Keep them short — two or three words, title-cased, no punctuation. A few worked examples for reference:

- A combat-heavy day with named pilots → **Combat Wire** (or **Hostilities**, **Casualty Desk**)
- A toll lane / mega-port / trade-route story → **Trade & Lanes** (or **Public Affairs** if it leans policy)
- An exchange of public broadcasts → **Open Channel** (or **Frontier Justice** if it's spicy)
- A new corporation, recruiting drive, member moves → **Corporate Affairs**
- An exploration / survey / probe record → **Cartography** (or **The Survey Desk**)
- Ship purchases, sales, trade-ins → **Shipyard** (or **Off the Lot**)
- Trade volume, port flow, leaderboard movement → **Markets** (or **The Ledger**)
- Chat broadcasts that read more like commentary than news → **Frontier Justice** (reserve **Open Channel** for the strongest broadcast-driven beat on the page)

If two stories would land on the same tag — adjacent or not — change one. Each tag must be unique on the page; visual rhythm and section variety depend on it. If a straight-news story and a gossip beat both spring from open-channel chatter, give the gossip the **Open-Channel Confidential** variant and keep the news as **Open Channel**.

### Tags for gossip (stories 8–9)

Oblique. Catty. Insider-y. The reader should feel they've stumbled into the back room of a yacht club. Two or three words, title-cased; "The X Set" / "On the X Beat" / "X Talk" patterns work. Worked examples:

- Wreckage / destroyed ships / escape pods → **Salvage Talk**, **From the Insurance Wing**, **Recovery Notes**
- Mega-port socialites, traders, anyone seen at the dock → **The Mega-Port Set**, **Concourse Whispers**, **Heard on the Promenade**
- Corp politics, recruitment, defections → **The Member Lounge**, **From the Boardroom Door**
- A pilot's unguarded chatter on the open channel → **Open-Channel Confidential**

The tag should hint at the gist of the gossip without naming it outright. If your tag basically restates the headline, it's too literal — make it more sideways.

### Tag for the market box (story 10)

Always literally `*Market Update*`. No variants. The image template expects this string.

## Privacy and content rules — non-negotiable

These constraints flow into the image prompt verbatim. Violating them in the markdown means a wrong front page.

- **Direct messages are private.** Never quote, paraphrase, or imply contents of any DM. Players cannot see other players' DMs in-game; the newspaper can't either. *Broadcasts are public — quote them freely.*
- **Sector numbers are restricted.** Use a sector number only if (a) it appears in a public broadcast inside the window, OR (b) it is a Federation Space sector (the meta-defined fedspace list, 200 sectors by default). When in doubt, omit the number and use a generic phrase like "the borderlands beyond Federation Space" or "a contested sector outside Fed."
- **No invented facts.** Headlines, ledes, quotes, percentages, ship classes, credit amounts, sector numbers — every readable claim must be grounded in the digest. If a stat is interesting but unverifiable, leave it out.
- **No fabricated player names.** Only use names that appear in `players[].name` or in the leaderboard ranks of the digest.
- **No invite codes** unless they were broadcast publicly.
- **Aggregate counts are always public.** Total sectors visited, total trade volume, ships destroyed, corporations created — all fair game for ledes and the market box.

## Story-mining heuristics

Strong story signals, in roughly decreasing order of front-page value:

1. **A public broadcast that announces intent** — toll lanes, recruitment, accusations, "public notice" kill claims, declarations of war. These almost always lead the page.
2. **An exchange of broadcasts between two pilots** — accusation + denial, ultimatum + response. Story 2 territory.
3. **A new corporation with a public manifesto** broadcast in the window.
4. **A combat day above baseline** — count `ship.destroyed` and `combat.ended`. Fourteen ship destructions is a lot; one is a footnote.
5. **A leaderboard sweep** — same name in #1 across multiple boards, or three sister ships in the top three of one board.
6. **A run of ship purchases** with a clear narrative (e.g., a pilot who lost a hull and re-bought).
7. **An autonomous-fleet survey record** — "468 sectors in 24 hours" is a clean explorer beat.
8. **Garrison drama in or near Fed Space.** Garrisons placed close to fedspace, especially if destroyed within hours, are reliable conflict copy.

Weak signals — generally skip:

- Quiet trading sessions with no anchoring narrative.
- Movement totals without a name attached.
- Errors, session counts, or other infra signals.

## Things this skill does NOT do

- **Does not edit code, deploy, or run migrations.** Read-only digest + write artifacts under `artifacts/`.
- **Does not commit anything.** The user reviews the markdown and image first.
- **Does not push the image anywhere.** It writes to disk; sharing is the user's call.
- **Does not invent storylines to pad to 9.** If the window is genuinely quiet (e.g., an off-hour 1h slice), say so plainly in the lede and reduce gossip items to one. Better a thin honest page than a fabricated one.
