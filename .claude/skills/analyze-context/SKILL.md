# Analyze Context

Analyzes a gameplay session context dump from Gradient Bang. Summarizes agent activity and, if the user reports a problem, identifies where it occurred and scans source code for the root cause.

## Parameters

- **context** (required): The gameplay session context dump (paste inline or provide a file path).
- **problem** (optional): A description of what went wrong during the session.

## Steps

### 1. Receive input

The user provides a context dump, either inline in the message or as a file path. If they provide a file path, read the file. If neither is provided, check whether there is a currently open file in the IDE (it will appear in the conversation context tagged as `ide_opened_file`). If there is, read that file and use it as the context dump. If there is no open file either, ask:

> "Please paste your context dump or provide a file path."

### 2. Check for a stated problem

- If the user described a problem (e.g. "the agent crashed", "it bought the wrong thing", "task agent got stuck"), proceed to the full analysis flow below.
- If no problem was mentioned, ask:

> "Did anything go wrong during this session, or do you just want a summary?"

  - If they say nothing went wrong (or just want a summary): produce **Summary only** (Step 3) and stop.
  - If they describe a problem: continue with Steps 4–5.

### 3. Summarize the session

Scan the full context dump and produce a **terse, factual summary**:

- What the VoiceAgent was instructed to do and what it did (high-level player intent + agent actions)
- What TaskAgent(s) were spawned, what they attempted, and whether they completed
- Any notable game events (combat, trades, movement, errors surfaced in messages)

Keep this section short — bullet points preferred, no padding.

### 4. Locate the issue in the context (only if a problem was stated)

Scan the context for evidence of the problem:

- Quote the specific message(s) where the issue appears (role, brief content excerpt, approximate position in the context)
- Note which agent produced it (VoiceAgent, TaskAgent, UIAgent, EventRelay, MainAgent)
- Note what preceded the failure (last successful action before the bad state)

### 5. Identify root cause in source code (only if a problem was stated)

Using the issue location and agent identified in Step 4, read the relevant source files:

- `src/gradientbang/pipecat_server/bot.py` — pipeline wiring, MainAgent
- `src/gradientbang/pipecat_server/subagents/voice_agent.py`
- `src/gradientbang/pipecat_server/subagents/task_agent.py`
- `src/gradientbang/pipecat_server/subagents/event_relay.py`
- `src/gradientbang/pipecat_server/subagents/ui_agent.py`
- `src/gradientbang/tools/` — tool schemas

Focus on:
- The code path that handles the event/tool/message where the failure occurred
- Any recent changes visible in the code that could explain the problem (mismatched parameters, missing attributes, wrong routing logic, incorrect tool schemas)

Cite file paths and line numbers for every suspect location.

### 6. Output

Produce the final report in exactly this format:

```
## Summary of session
<terse bullet-point summary of VoiceAgent and TaskAgent activity>

## Cited issue(s)
<quoted excerpt(s) from the context showing where the problem occurred, with agent attribution and context position>
<file:line references from source code identified as the likely cause>

## Potential fixes
<concrete, specific suggested code changes with file:line references>
```

If no problem was reported and the user confirmed they just want a summary, omit **Cited issue(s)** and **Potential fixes** entirely.

## Important notes

- Never speculate — only cite what is observable in the context dump or verifiable in source files.
- If you cannot locate the issue in source, say so explicitly rather than guessing.
- Keep the summary terse — this is a debugging aid, not a narrative.
- Tool schemas live in `src/gradientbang/tools/` and are shared across VoiceAgent, TaskAgent, and UIAgent — check there when a tool call looks malformed.
- **Never make any code changes.** This skill is read-only analysis only — do not edit, write, or modify any source files.
