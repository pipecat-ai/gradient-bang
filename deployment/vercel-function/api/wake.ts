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
 *      then returns 202 with the sandbox name + cmd id.
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

function isNotFoundError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const anyErr = err as { status?: number; code?: string };
    if (anyErr.status === 404) return true;
    if (anyErr.code === "not_found") return true;
  }
  return /not.?found/i.test(err instanceof Error ? err.message : String(err));
}

async function provisionSandbox(opts: {
  name: string;
  env: Record<string, string>;
}): Promise<Sandbox> {
  const repoUrl = (process.env.BYOA_REPO_URL ?? DEFAULT_REPO_URL).trim();
  const revision = (
    process.env.BYOA_REPO_REVISION ?? DEFAULT_REPO_REVISION
  ).trim();
  const githubToken = (process.env.GITHUB_TOKEN ?? "").trim();

  const sandbox = await Sandbox.create({
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
  });

  // python3.13 runtime ships with `uv` preinstalled. Install deps from the
  // slim BYOA runtime pyproject so we don't pull bot/server-only packages
  // into the sandbox.
  const cp = await sandbox.runCommand("cp", [
    "pyproject.byoa.toml",
    "pyproject.toml",
  ]);
  if (cp.exitCode !== 0) {
    throw new Error(`cp pyproject.byoa.toml failed: ${await cp.stderr()}`);
  }
  const sync = await sandbox.runCommand("uv", ["sync", "--frozen"]);
  if (sync.exitCode !== 0) {
    throw new Error(`uv sync failed: ${await sync.stderr()}`);
  }
  return sandbox;
}

async function getOrCreateSandbox(opts: {
  name: string;
  env: Record<string, string>;
}): Promise<{ sandbox: Sandbox; created: boolean }> {
  try {
    const sandbox = await Sandbox.get({ name: opts.name, resume: true });
    return { sandbox, created: false };
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    const sandbox = await provisionSandbox(opts);
    return { sandbox, created: true };
  }
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
  // something stale in project env.
  const harnessEnv: Record<string, string> = {
    ...pickOperatorEnv(),
    ...wakeEnv,
  };

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
    const command = await sandbox.runCommand({
      cmd: "uv",
      args: ["run", "byoa"],
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
