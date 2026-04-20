---
name: bug-report
description: Triage a user-pasted bug report (from Discord, Slack, GitHub, etc.) about the Gradient Bang game. READ-ONLY — investigates the codebase and produces TWO things in one response: (1) a compact **bug summary** (verdict, why, fix, evidence with file:line citations) the user can keep for their records or paste into Notion, and (2) a separate **Discord reply** of only 1–2 friendly sentences at the very bottom that the user can paste straight back to the reporter in the Discord channel. This skill NEVER edits code, writes files in the project, deploys, runs migrations, or makes any system changes — the deliverable is always written output only. Usage `/bug-report <pasted report>`. Use this skill WHENEVER the user pastes or forwards a bug report, player complaint, or feedback message and wants to know "is this real?" or "help me triage this" — even if they don't explicitly say "triage".
---

# Triage Bug Report

Turn a raw, possibly-messy user report into a grounded verdict and a paste-ready summary for the team.

## Read-only — written output is the ONLY deliverable

This skill **never edits code or changes any state**. The user is triaging, not fixing. Specifically, do not:

- Edit, create, or delete any file in the repo (code, configs, prompts, migrations, tests — nothing)
- Run `git` commands that mutate state (commit, push, checkout, reset, stash pop, branch, etc.)
- Deploy, restart the bot, apply migrations, or touch Supabase
- Run tests, build scripts, or package installs
- Call any MCP tool that changes remote state (e.g., PR creation, issue posting, Slack/Discord messages)

The **only** write operation this skill performs is producing the triage summary as text in the chat. If you catch yourself about to write to a file in the project, stop — that's out of scope. If the user wants the fix implemented, they'll say so in a follow-up; this skill ends with the summary.

Read-only investigation is fine: Read, Grep, Glob, `Explore` subagents, `git log` / `git diff` / `git status`, etc.

## Why this exists

Bug reports from Discord/Slack/GitHub/email come in all shapes — some are real bugs, some are misunderstandings of game mechanics, some are feature requests dressed as bugs, some are noise. The goal of this skill is to save the user from having to manually dig through the codebase each time and to give their team a consistent, terse format.

## Input

The user pastes the report in the slash-command args (or in chat). It may be:
- A single message or a long thread
- Contain screenshots references, timestamps, usernames, emojis — leave those alone
- Be in broken English, all-lowercase, etc.

Don't "fix" the report. Just triage it.

## Step 1 — Extract the core claim

Read the report and distill it into **one sentence** stating what the reporter claims is happening. If the report mixes several complaints, pick the most concrete one and note the others for the "Related" field. If you genuinely can't extract a claim, skip to the `Needs more info` verdict.

## Step 2 — Investigate with parallel Explore agents

Spawn **2–3 `Explore` subagents in parallel** (single message, multiple tool calls) to ground-truth the claim against the codebase. Tailor each agent's focus to the report — good default splits:

- **Agent A — Server/DB**: relevant Supabase edge functions in `deployment/supabase/functions/` and shared queries in `_shared/pg_queries.ts`. Does the reported behavior match what the server actually does?
- **Agent B — Client/UI**: relevant React components in `client/app/src/`. Is the UI actually rendering what the reporter says it is (or isn't)?
- **Agent C — Bot / agents**: `src/gradientbang/pipecat_server/` if the report involves the voice agent or task agents.

Drop agents that clearly don't apply. For a report that's obviously UI-only, one Explore agent is fine — don't spawn agents just for symmetry.

Give each agent a focused prompt, the reporter's claim, and a word budget (~400 words). Ask specifically: *does the code behave the way the reporter describes, and if not, what does it actually do?*

## Step 3 — Decide the verdict

Pick exactly one:

- **Real bug** — the code does not do what it should, and the reporter's description is consistent with that gap. You can point at the specific file/line that's wrong or missing.
- **Not a bug** — the code behaves as intended. This is a misunderstanding of game mechanics, a UX complaint (feature request), or the reporter is mistaken about what happened.
- **Needs more info** — you can't tell from the code alone. Specify exactly what would resolve the ambiguity (repro steps, timestamp, character name, screenshot of a specific panel, etc.).

Err on the side of **Needs more info** over guessing. "I couldn't confirm this from the code" is more useful to the team than a wrong verdict.

## Step 4 — Produce the output (two parts)

Every response has **two clearly separated parts**:

1. **Bug summary** — starts with a **bold descriptive title** on its own line (so the whole block is self-identifying when pasted into Notion), then the grounded triage with file:line evidence.
2. **Discord reply** — a short 1–2 sentence message the user can paste straight back to the reporter in a Discord channel.

Both parts go in the same response. The Discord reply is always at the bottom, under a visible divider, so the user can copy just that part cleanly.

### Writing the title

The first line of the summary is **always a short descriptive bold title** — not the generic word "Bug summary". Treat it like a commit subject: under ~70 chars, starts with a noun phrase, names the actual problem. The user pastes this straight into Notion as the bug's heading.

- Good: `**Destroyed corp ships leak into fleet listings**`
- Good: `**Leaderboard hides players outside top 100**`
- Good: `**Top-bar icon buttons & zoom slider lack accessible names**`
- Bad: `**Bug summary**` (generic — doesn't identify which bug)
- Bad: `**A bug where the leaderboard doesn't show...**` (too long, not scannable)

### Formatting rules

- **No `#` / `##` / `###` headers anywhere.** Discord renders those as oversized banners, and the user's Notion works fine with bolded labels.
- **Plain markdown only**: `**bold**`, bullet hyphens, backticks for file paths.
- **No "Original report" quote-back.** The reporter already wrote it; repeating wastes space.
- Start the response directly with the **bold title** — no preamble, no "Here's what I found:", no generic "Bug summary" label.

### Template — ALWAYS use this exact structure

```
**<Short descriptive title of the bug>**

**Verdict:** <Real bug | Not a bug | Needs more info>
**Why:** <one short sentence — what the code actually does vs. what the reporter thinks>
**Fix:** <one short sentence — the proposed change, or "working as intended", or "need <X> first">

**Evidence:**
- `path/to/file.ts:123` — <what this line shows>
- `path/to/other.ts:45` — <what this shows> *(optional — skip if one bullet is enough)*

---

**Discord reply** *(paste this to the reporter)*
> <1–2 sentences, terse, addressed to the reporter. Give the verdict in plain English. No file paths, no jargon, no affirmations, no fix commitments.>
```

For **Needs more info**, replace the `Fix:` + `Evidence:` lines with:

```
**Ask the reporter for:** <short comma-separated list — e.g., "the sector, what they tried to sell, the error message, approx timestamp">
```

…and write the Discord reply as a short friendly request for those details.

### Discord reply — tone guide

Terse and human. Just state the outcome.

- **No affirmations.** Skip "good catch", "thanks for flagging", "really appreciate it", "absolutely right", etc. The reporter doesn't need to be thanked for reporting; they need an answer.
- **No hedging softeners.** Skip "just to confirm", "so it turns out", "looks like maybe". State what's true.
- **Acknowledge, don't commit to fixes.** Confirm whether the issue is real, but don't promise the fix will ship. Use "we'll look into it" / "we'll take a look" / "on our radar" — NOT "we'll add", "we'll fix it", "we're shipping a fix". The triage identifies the issue; whether/when it ships is the team's call, not this skill's.
- **One or two sentences, max.** If you can say it in one, do.
- **Plain English.** No file paths, no `aria-describedby`, no "the BFS caps at 100 hops" — translate technical findings into what the reporter experiences.
- **No emojis** unless the reporter's own message used them.

Think of it as a matter-of-fact note from a teammate, not a customer-service reply.

### Examples

**Real bug:**
```
**Leaderboard hides players outside top 100**

**Verdict:** Real bug
**Why:** Players outside the top 100 are simply absent from the leaderboard — no rank, no row, no indication they exist.
**Fix:** Pin the current player's row to the bottom of each category when they're outside the top 100.

**Evidence:**
- `deployment/supabase/functions/leaderboard_resources/index.ts:135` caps each category at 100 rows with no "me" row appended.
- `client/app/src/components/panels/LeaderboardPanel.tsx:199` already has the styling for the current player — it just has nothing to render when they're below the cutoff.

---

**Discord reply** *(paste this to the reporter)*
> Confirmed bug — the leaderboard only renders the top 100, so anyone below doesn't show up at all. We'll look into pinning your own row to the bottom so your real rank is visible.
```

**Not a bug:**
```
**Warp power "resets" after relogin**

**Verdict:** Not a bug
**Why:** Warp power is persisted in the DB and reloaded on login — the "disappearing" effect is the recharge timer resetting the display, not lost state.
**Fix:** Working as intended. Optional polish: clearer tooltip on the warp-power bar.

**Evidence:**
- `deployment/supabase/functions/login/index.ts` reloads `warp_power` from the `ships` table on every login.
- `deployment/supabase/functions/recharge_warp_power/index.ts` is the only path that mutates it.

---

**Discord reply** *(paste this to the reporter)*
> Not a bug — warp power persists across logins; what resets visually is the recharge animation, not the value.
```

**Needs more info:**
```
**"Trading is broken" — not enough detail to reproduce**

**Verdict:** Needs more info
**Why:** "Trading is broken" is too vague to ground-truth against the code — could be a specific port, a UI issue, or a price calc.

**Ask the reporter for:** the sector/port, what they tried to buy or sell, the exact error or unexpected result, and an approximate timestamp.

---

**Discord reply** *(paste this to the reporter)*
> Need a bit more to reproduce: which port, what you tried to buy or sell, and what the error or unexpected result was.
```

## Principles

- **Don't speculate.** If the code doesn't show it, say so. A `Needs more info` verdict with a clear ask is more useful than a confident guess.
- **Cite specific files and line numbers.** The user's team needs to be able to verify your verdict in seconds.
- **Always deliver both parts.** Bug summary on top for the user's records, Discord reply at the bottom for pasting to the reporter. Never skip one.
- **Discord reply is for the reporter, not the team.** Addressed to the person who filed the report. Terse, human, no jargon, no file paths, no affirmations ("good catch" / "thanks for flagging"), no hedging softeners, and **no fix commitments** ("we'll add X", "we'll fix it") — use "we'll look into it" / "on our radar" instead. Technical detail lives in the summary above.
- **No `##` headers.** Use bold labels instead — works in both Discord and Notion.
- **Written output is the only deliverable.** See the "Read-only" section at the top. No file edits, no deploys, no DB writes, no git mutations. If the triage reveals a clear fix, *describe* it in the `Fix:` line — don't apply it.
