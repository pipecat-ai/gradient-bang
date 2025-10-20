SIMPLE_TUI(1)                   Gradient Bang Manual                  SIMPLE_TUI(1)
====================================================================

NAME
----
simple_tui - interactive terminal client for the Gradient Bang game server

SYNOPSIS
--------
*simple_tui* [*sector*]

*uv run -m npc.simple_tui* [*-h*] [*--character* *ID*] [*--server* *URL*]
[*--verbose*] [*--log-file* *PATH*] [*--log-level* *LEVEL*]
[*--max-iterations* *N*] [*--thinking-budget* *TOKENS*]
[*--idle-timeout* *SECONDS*] [*--task* *TEXT*]...
[*--stdin-tasks*] [*--headless*]

DESCRIPTION
-----------
*simple_tui* starts the Textual user interface for piloting a Gradient Bang
character.  The UI combines structured event feeds, combat helpers, and task
automation backed by the Pipecat-powered *TaskAgent*.  When *--headless* is not
set, the application renders an interactive terminal dashboard with:

* a status bar summarising ship resources and combat state,
* a scrolling event log fed by server broadcasts and TaskAgent output, and
* a command prompt for task requests or combat actions.

In headless mode the client bypasses Textual and executes scripted tasks using
the same TaskAgent.  Output is written to the configured log target and the
process exits with status 0 on success.

The visible log area offers two views: the default *Events* panel for SEND/RECV
traffic and task updates, and a *Logs* panel capturing stderr/loguru output.
Press *Ctrl+T* at any time to toggle between them.

POSITIONAL ARGUMENTS
--------------------
*sector*
:   Optional numeric sector to move to immediately after joining.

OPTIONS
-------
*-h*, *--help*
:   Display a summary of options and exit.

*--character* *ID*
:   Character identifier.  Defaults to the value of `NPC_CHARACTER_ID`.

*--server* *URL*
:   Game server base URL.  Defaults to `http://localhost:8000`.

*--verbose*
:   Promote console logging to DEBUG for troubleshooting.

*--log-file* *PATH*
:   Append textual log lines to *PATH*.  When omitted, logs are written to
    `simple_tui.log` in the current directory.

*--log-level* *LEVEL*
:   Minimum log level recognised by the UI log.  Accepts the Loguru levels
    TRACE, DEBUG, INFO, SUCCESS, WARNING, ERROR, or CRITICAL.  Defaults to the
    value of `NPC_LOG_LEVEL` or INFO.

*--max-iterations* *N*
:   Maximum TaskAgent reasoning turns per task (default: 25 or
    `NPC_MAX_ITERATIONS`).

*--thinking-budget* *TOKENS*
:   Optional reasoning token budget forwarded to the TaskAgent.

*--idle-timeout* *SECONDS*
:   Abort TaskAgent inference if the LLM pipeline is idle for the specified
    number of seconds.

*--task* *TEXT*
:   Queue a task instruction to run immediately after startup.  May be repeated
    to enqueue multiple tasks.

*--stdin-tasks*
:   Read newline-delimited task instructions from standard input and append
    them to the startup queue.

*--headless*
:   Skip the Textual UI and execute the queued tasks in sequence using the
    programmatic runner.  The process exits with status 1 if any task fails.

ENVIRONMENT
-----------
`NPC_CHARACTER_ID`
:   Character identifier fallback when *--character* is omitted.

`NPC_LOG_LEVEL`
:   Default log level for both the UI buffer and optional log file.

`NPC_MAX_ITERATIONS`
:   Default upper bound for TaskAgent reasoning turns.

`NPC_THINKING_BUDGET`
:   Default value for *--thinking-budget*.

`NPC_IDLE_TIMEOUT`
:   Default value for *--idle-timeout*.

`GOOGLE_API_KEY`
:   Required for TaskAgent access to Google Generative AI models.

FILES
-----
`simple_tui.log`
:   Default log file capturing UI output and redirected stderr traffic.

EXIT STATUS
-----------
0
:   All requested tasks completed successfully.

1
:   Initialisation failed or at least one task failed/cancelled.

EXAMPLES
--------
```
# Launch the interactive UI controlling codex-1.
uv run -m npc.simple_tui --character codex-1

# Run two scripted tasks without the Textual dashboard and log to a custom file.
uv run -m npc.simple_tui --headless --character codex-1 \
    --task "scan the local sector" --task "plot course to 420" \
    --log-file /tmp/simple_tui.log

# Pipe tasks over STDIN and cap the TaskAgent to 10 reasoning turns per task.
printf 'survey nearby ports\nreport cargo status\n' | \
    uv run -m npc.simple_tui --stdin-tasks --max-iterations 10 \
    --character codex-1 --headless
```

SEE ALSO
--------
`npc.run_npc`(1), `npc.run_experimental_task`(1)
