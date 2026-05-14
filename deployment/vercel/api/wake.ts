/**
 * BYOA wake receiver — deployed to the operator's Vercel project. The wake
 * contract is defined in docs/byoa.md ("How wake works") and mirrored by the
 * local-dev daemon in src/gradientbang/byoa/serve.py.
 *
 * On every wake POST from wake_agent:
 *
 *   1. Verifies the Authorization bearer matches BYOA_WAKE_SECRET.
 *   2. Looks up the persistent sandbox for the wake's ship_id (one box per
 *      ship, named `byoa-<ship_id>`). If none exists, provisions a fresh
 *      persistent sandbox cloning the gradient-bang git repo and runs
 *      `uv sync` once.
 *   3. Spawns `uv run byoa` detached with the merged operator-env + wake-env,
 *      with stdout+stderr appended to ~/byoa.log inside the sandbox, then
 *      returns 202 with the sandbox name + cmd id. Wake is "done" the moment
 *      the harness is launched — task progress is observed via the game bus,
 *      not the wake response. Use GET /api/logs?ship_id=… to inspect
 *      ~/byoa.log when something silently misbehaves.
 *
 * Persistent sandboxes (beta in @vercel/sandbox@beta) auto-snapshot on stop,
 * so the second wake for the same ship skips clone + dep install and resumes
 * in seconds.
 */

import { Sandbox } from "@vercel/sandbox";

// First wake (clone + `uv sync`) can take 30-60s; subsequent wakes resume
// the persistent sandbox and finish in a few seconds. Hobby plan caps
// maxDuration at 60s; Pro at 800s. Bump as needed for first-wake headroom.
export const maxDuration = 300;

// ── Knobs ────────────────────────────────────────────────────────────

const DEFAULT_REPO_URL = "https://github.com/pipecat-ai/gradient-bang.git";
const DEFAULT_REPO_REVISION = "main";

// Sandbox session timeout. Each session resumes from the last snapshot;
// when this elapses the sandbox auto-stops and the next wake reboots a
// fresh session from the saved filesystem. Max 45 min on Hobby, 5 h on
// Pro/Enterprise.
const SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;

// Default expiration for the auto-snapshots a persistent sandbox takes
// when it stops. Set to keep idle ships warm across multi-week gaps; use
// 0 for "never expire" or shorten if you'd rather pay less storage.
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;

// Allowlist of operator project-env keys forwarded into the sandbox.
// Allowlist (not denylist) keeps unrelated Vercel system vars out of the
// harness env. wake_agent injects identity / per-session vars
// (BYOA_SHIP_ID, BYOA_CHARACTER_ID, BYOA_CHANNEL, BYOA_BUS_DATABASE_URL,
// BYOA_TASK_ID, BYOA_WAKE_REQUEST_ID) via the wake POST body's `env`
// field — those don't live in project env and are not listed here.
const OPERATOR_ENV_KEYS = [
  "BYOA_PROMPT",
  "BYOA_PROMPT_FILE",
  "TASK_LLM_PROVIDER",
  "TASK_LLM_MODEL",
  "TASK_LLM_THINKING_BUDGET",
  "GOOGLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "BYOA_TOOL_CALL_TIMEOUT_SECONDS",
  "BYOA_AGENT_IDLE_TEARDOWN_SECONDS",
] as const;

// ── Helpers ──────────────────────────────────────────────────────────

function pickOperatorEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OPERATOR_ENV_KEYS) {
    const value = process.env[key];
    if (value && value.length > 0) out[key] = value;
  }
  return out;
}

type WakePayload = {
  request_id?: string;
  ship_id: string;
  task_id: string;
  channel: string;
  env?: Record<string, string>;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getOrCreateSandbox(opts: {
  name: string;
  env: Record<string, string>;
}): Promise<{ sandbox: Sandbox; created: boolean }> {
  const repoUrl = (process.env.BYOA_REPO_URL ?? DEFAULT_REPO_URL).trim();
  const revision = (
    process.env.BYOA_REPO_REVISION ?? DEFAULT_REPO_REVISION
  ).trim();
  const githubToken = (process.env.GITHUB_TOKEN ?? "").trim();

  let created = false;
  const sandbox = await Sandbox.getOrCreate({
    name: opts.name,
    // `persistent: true` is the default in @vercel/sandbox@beta; pinned
    // here for clarity in case the default flips.
    persistent: true,
    snapshotExpiration: SNAPSHOT_EXPIRATION_MS,
    runtime: "python3.13",
    timeout: SANDBOX_TIMEOUT_MS,
    source: {
      type: "git",
      url: repoUrl,
      // The git source requires username/password fields. For public
      // repos any non-empty value works; setting a fine-grained PAT in
      // GITHUB_TOKEN unlocks private forks and avoids public rate limits.
      username: githubToken ? "x-access-token" : "anonymous",
      password: githubToken || "anonymous",
      revision,
      depth: 1,
    },
    env: opts.env,
    onCreate: async (sbx) => {
      created = true;
      // python3.13 runtime ships with `uv` preinstalled. Install deps from
      // the slim BYOA runtime pyproject so we don't pull bot/server-only
      // packages into the sandbox.
      const cp = await sbx.runCommand("cp", [
        "pyproject.byoa.toml",
        "pyproject.toml",
      ]);
      if (cp.exitCode !== 0) {
        throw new Error(`cp pyproject.byoa.toml failed: ${await cp.stderr()}`);
      }
      // The /vercel/runtimes/python python3.13 ships without the `_sqlite3`
      // C extension, which nltk imports eagerly at module-load time (pipecat
      // → nltk → panlex_lite → `import sqlite3`). Install a standalone
      // python-build-standalone Python via uv — those ship with the full
      // stdlib. UV_PYTHON_PREFERENCE=only-managed in the sandbox env (set
      // when Sandbox.getOrCreate ran above) ensures uv picks this one for
      // every subsequent `uv sync` / `uv run` call.
      const pyInstall = await sbx.runCommand("uv", [
        "python",
        "install",
        "3.13",
      ]);
      if (pyInstall.exitCode !== 0) {
        throw new Error(
          `uv python install failed: ${await pyInstall.stderr()}`,
        );
      }
      // Not `--frozen`: the checked-in `uv.lock` was generated from the
      // main `pyproject.toml` and references workspace members that don't
      // exist in `pyproject.byoa.toml`. Letting uv re-resolve on first
      // wake regenerates a BYOA-shaped lock; subsequent wakes resume the
      // sandbox snapshot and skip this step entirely.
      const sync = await sbx.runCommand("uv", ["sync"]);
      if (sync.exitCode !== 0) {
        throw new Error(`uv sync failed: ${await sync.stderr()}`);
      }
    },
  });
  return { sandbox, created };
}

// ── Handler ──────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  const wakeSecret = (process.env.BYOA_WAKE_SECRET ?? "").trim();
  if (!wakeSecret) {
    return json(500, {
      success: false,
      error: "BYOA_WAKE_SECRET not configured",
    });
  }
  if (req.headers.get("Authorization") !== `Bearer ${wakeSecret}`) {
    return json(401, { success: false, error: "unauthorized" });
  }

  let payload: WakePayload;
  try {
    payload = (await req.json()) as WakePayload;
  } catch (err) {
    return json(400, {
      success: false,
      error: "invalid_json",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const {
    ship_id,
    task_id,
    channel,
    env: wakeEnv = {},
    request_id,
  } = payload;
  if (!ship_id || !task_id || !channel) {
    return json(400, {
      success: false,
      error: "missing_required_fields",
    });
  }

  // Operator config from project env first, then per-session bits from the
  // wake POST. Wake bits win on overlap so BYOA_CHANNEL / BYOA_TASK_ID /
  // BYOA_BUS_DATABASE_URL flow through correctly even if the operator set
  // something stale in project env. `PYTHONUNBUFFERED=1` so harness output
  // hits ~/byoa.log line-by-line instead of in 4KB chunks — critical for
  // debugging detached runs via /api/logs. `UV_PYTHON_PREFERENCE=only-managed`
  // so every uv invocation (sync at provision time, `uv run byoa` per wake)
  // ignores `/vercel/runtimes/python` (which lacks the _sqlite3 C extension
  // nltk imports eagerly) and uses the python-build-standalone Python we
  // install in onCreate instead.
  const operatorEnv = pickOperatorEnv();
  const harnessEnv: Record<string, string> = {
    PYTHONUNBUFFERED: "1",
    UV_PYTHON_PREFERENCE: "only-managed",
    ...operatorEnv,
    ...wakeEnv,
  };
  // Fallback to the bundled prompt when the operator hasn't set one. Path is
  // relative to the cloned repo root (the sandbox cwd for `uv run byoa`).
  if (!operatorEnv.BYOA_PROMPT && !operatorEnv.BYOA_PROMPT_FILE) {
    harnessEnv.BYOA_PROMPT_FILE = "deployment/vercel/prompt.md";
  }

  const sandboxName = `byoa-${ship_id}`;
  let sandbox: Sandbox;
  let created: boolean;
  try {
    ({ sandbox, created } = await getOrCreateSandbox({
      name: sandboxName,
      env: harnessEnv,
    }));
  } catch (err) {
    return json(500, {
      success: false,
      error: "sandbox_provision_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // Wrap in a login shell so we can redirect stdout+stderr to a file
    // that survives the snapshot. Each wake prepends a banner line so
    // /api/logs can show distinct invocations. Use `>>` not `>` so we
    // keep history across wakes.
    const launchScript = [
      `printf '\\n--- wake %s %s task=%s ---\\n' "$(date -u +%FT%TZ)" "${request_id ?? ""}" "${task_id}" >> ~/byoa.log`,
      `exec uv run byoa >> ~/byoa.log 2>&1`,
    ].join(" ; ");
    const command = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", launchScript],
      env: harnessEnv,
      detached: true,
    });
    return json(202, {
      success: true,
      status: "accepted",
      sandbox_name: sandbox.name,
      cmd_id: command.cmdId,
      task_id,
      request_id: request_id ?? null,
      created,
    });
  } catch (err) {
    return json(500, {
      success: false,
      error: "harness_launch_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// Health check — useful for monitoring + Vercel deployment smoke tests.
// Does not touch the sandbox.
export async function GET(): Promise<Response> {
  return json(200, {
    status: "ok",
    wake_secret_configured: Boolean(process.env.BYOA_WAKE_SECRET),
  });
}
