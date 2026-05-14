/**
 * One-shot sandbox diagnostic. Runs a few non-mutating shell commands
 * inside the persistent sandbox for a ship_id and returns their output.
 * Use this when /api/logs shows the harness silent — `ps` tells us if
 * `uv run byoa` is still alive, `pgrep -af python` confirms its pid, and
 * a directory listing of ~/.config + the log tail lets us correlate.
 *
 * Disposable — once we've debugged this, delete the file.
 *
 *   GET /api/diag?ship_id=<uuid>
 *   Authorization: Bearer <BYOA_WAKE_SECRET>
 */

import { Sandbox } from "@vercel/sandbox";

export const maxDuration = 60;

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const wakeSecret = (process.env.BYOA_WAKE_SECRET ?? "").trim();
  if (!wakeSecret) return text(500, "BYOA_WAKE_SECRET not configured\n");
  if (req.headers.get("Authorization") !== `Bearer ${wakeSecret}`) {
    return text(401, "unauthorized\n");
  }

  const url = new URL(req.url);
  const shipId = (url.searchParams.get("ship_id") ?? "").trim();
  if (!shipId) return text(400, "missing ship_id\n");

  const sandboxName = `byoa-${shipId}`;
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  } catch (err) {
    return text(404, `no sandbox ${sandboxName}: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const probes: Array<[string, string]> = [
    ["ps -ef", "ps -ef"],
    ["pgrep -af python|byoa|uv", "pgrep -af 'python|byoa|uv' || true"],
    ["env | grep BYOA", "env | grep -E '^BYOA_|^PYTHON' || true"],
    ["which python", "which python python3 || true"],
    ["uv python list", "uv python list || true"],
    ["tail -n 50 ~/byoa.log", "tail -n 50 ~/byoa.log 2>/dev/null || echo '(no log)'"],
  ];

  const sections: string[] = [];
  for (const [label, cmd] of probes) {
    const result = await sandbox.runCommand("bash", ["-lc", cmd]);
    const out = await result.stdout();
    sections.push(`=== ${label} (exit=${result.exitCode}) ===\n${out}`);
  }
  return text(200, sections.join("\n"));
}
