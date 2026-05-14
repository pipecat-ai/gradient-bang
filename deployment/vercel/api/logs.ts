/**
 * BYOA log viewer — companion to wake.ts. Returns the tail of the BYOA
 * harness log file (`~/byoa.log`) from the persistent sandbox for a
 * given ship_id. The harness command in wake.ts redirects stdout+stderr
 * to that file, so this endpoint is the only way to see what the
 * detached `uv run byoa` is doing.
 *
 * GET /api/logs?ship_id=<uuid>&lines=<N>
 *   Authorization: Bearer <BYOA_WAKE_SECRET>
 *
 * Response: text/plain log tail (200), or JSON error (4xx/5xx).
 */

import { Sandbox } from "@vercel/sandbox";

export const maxDuration = 30;

const DEFAULT_LINES = 500;
const MAX_LINES = 5000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const wakeSecret = (process.env.BYOA_WAKE_SECRET ?? "").trim();
  if (!wakeSecret) {
    return json(500, { error: "BYOA_WAKE_SECRET not configured" });
  }
  if (req.headers.get("Authorization") !== `Bearer ${wakeSecret}`) {
    return json(401, { error: "unauthorized" });
  }

  const url = new URL(req.url);
  const shipId = url.searchParams.get("ship_id");
  if (!shipId) return json(400, { error: "missing ship_id" });

  const requestedLines = Number(url.searchParams.get("lines") ?? DEFAULT_LINES);
  const lines = Math.max(
    1,
    Math.min(MAX_LINES, Number.isFinite(requestedLines) ? requestedLines : DEFAULT_LINES),
  );

  const sandboxName = `byoa-${shipId}`;
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ name: sandboxName, resume: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      (err as { response?: { status?: number } })?.response?.status === 404
        ? 404
        : 500;
    return json(status, {
      error: status === 404 ? "sandbox_not_found" : "sandbox_lookup_failed",
      sandbox_name: sandboxName,
      detail: msg,
    });
  }

  const result = await sandbox.runCommand("bash", [
    "-lc",
    `tail -n ${lines} ~/byoa.log 2>/dev/null || echo "(no log yet)"`,
  ]);
  const stdout = await result.stdout();
  return new Response(stdout, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
