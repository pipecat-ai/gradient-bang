import {
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import {
  parseJsonRequest,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";
import { acquirePgClient } from "../_shared/pg.ts";
import { SEED_BY_SLUG, ALL_SEEDS } from "./seeds/registry.ts";

// heads up; this is brittle
// EVAL_ENABLED
const EVAL_ENABLED = Deno.env.get("EVAL_WEBHOOK_ENABLED") === "true";
const EDGE_API_TOKEN = Deno.env.get("EDGE_API_TOKEN") ?? "";

// Supabase's edge-runtime log viewer is inconsistent across console.* calls
// (console.log sometimes buffered, console.error sometimes suppressed by the
// traced() wrapper, etc.). Emit to ALL three channels so at least one lands:
//   1. console.log  (stdout)
//   2. console.error (stderr via console)
//   3. raw Deno.stderr.writeSync (bypasses any console hook / buffering)
const _stderrEncoder = new TextEncoder();
function _emitLog(line: string): void {
  try {
    console.log(line);
  } catch (_) { /* ignore */ }
  try {
    Deno.stderr.writeSync(_stderrEncoder.encode(line + "\n"));
  } catch (_) { /* ignore */ }
}

function _emitError(line: string): void {
  try {
    console.error(line);
  } catch (_) { /* ignore */ }
  try {
    Deno.stderr.writeSync(_stderrEncoder.encode(line + "\n"));
  } catch (_) { /* ignore */ }
}

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra
    ? `[eval_webhook] ${msg} ${JSON.stringify(extra)}`
    : `[eval_webhook] ${msg}`;
  _emitLog(line);
}

function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err ?? "");
  _emitError(`[eval_webhook] ERROR ${msg}${detail ? ` -- ${detail}` : ""}`);
}

// Startup trace — runs once when the isolate boots. Confirms deployment.
log("boot", {
  eval_enabled: EVAL_ENABLED,
  has_edge_api_token: Boolean(EDGE_API_TOKEN),
});

// the value we are looking for is EDGE_API_TOKEN
// the _key_ is X-CEKURA-SECRET, because this is coming from
// Cekura's webhook event service
function validateCekuraSecret(req: Request): boolean {
  const provided = req.headers.get("X-CEKURA-SECRET") ?? "";
  return Boolean(EDGE_API_TOKEN) && provided === EDGE_API_TOKEN;
}

function getCharacterSlug(name: string): string {
  return name.split(/\s+/).slice(0, 2).join("_").toLowerCase();
}

async function runSeed(sql: string): Promise<void> {
  const client = await acquirePgClient();
  try {
    await client.queryObject(sql);
  } finally {
    client.release();
  }
}

Deno.serve(
  traced("eval_webhook", async (req, trace) => {
    log("request", {
      method: req.method,
      url: req.url,
      has_secret_header: req.headers.has("X-CEKURA-SECRET"),
    });

    // Fail-closed: disabled unless explicitly opted in
    if (!EVAL_ENABLED) {
      logError("reject because this function is disabled;");
      return errorResponse(
        "eval_webhook is disabled in this environment",
        403,
      );
    }

    // All requests require X-CEKURA-SECRET
    if (!validateCekuraSecret(req)) {
      logError("reject auth");
      return errorResponse("invalid or missing X-CEKURA-SECRET", 401);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = await parseJsonRequest(req);
    } catch (err) {
      const response = respondWithError(err);
      if (response) return response;
      logError("parse", err);
      return errorResponse("invalid JSON payload", 400);
    }

    // Health check
    if (payload.healthcheck === true) {
      log("healthcheck ok");
      return successResponse({ status: "ok", eval_enabled: true });
    }

    // Seed all characters
    if (payload.action === "seed_all") {
      const requestId = resolveRequestId(payload);
      trace.setInput({ action: "seed_all", requestId });
      log("seed_all start", { request_id: requestId });

      const results: Array<{ name: string; ok: boolean; error?: string }> = [];
      for (const seed of ALL_SEEDS) {
        const span = trace.span(`seed.${seed.name}`);
        try {
          await runSeed(seed.sql);
          results.push({ name: seed.name, ok: true });
          span.end();
          log(`seed_all ${seed.name} ok`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: seed.name, ok: false, error: msg });
          span.end();
          logError(`seed_all ${seed.name}`, err);
        }
      }

      const allOk = results.every((r) => r.ok);
      trace.setOutput({ request_id: requestId, allOk, count: results.length });
      log("seed_all done", {
        request_id: requestId,
        ok: allOk,
        count: results.length,
      });

      if (!allOk) {
        return errorResponse("some seeds failed", 500, { results });
      }
      return successResponse({
        request_id: requestId,
        seeded: results.length,
        results,
      });
    }

    // Cekura webhook
    const eventType = payload.event_type;
    if (eventType !== undefined) {
      if (eventType !== "result.completed") {
        logError("unknown event_type", { event_type: String(eventType) });
        return errorResponse(`unknown event_type: ${eventType}`, 400);
      }

      const data =
        (payload.data as Record<string, unknown> | undefined) ?? {};
      const runs =
        (data.runs as Record<string, Record<string, unknown>> | undefined) ??
          {};
      const runEntries = Object.values(runs);
      const firstRun = runEntries[0] ?? {};
      const testProfileName = String(firstRun.test_profile_name ?? "");
      if (!testProfileName) {
        logError("missing test_profile_name", { run_count: runEntries.length });
        return errorResponse(
          "missing data.runs[*].test_profile_name",
          400,
        );
      }
      if (runEntries.length > 1) {
        log("multiple runs, using first run for test_profile_name", {
          run_count: runEntries.length,
          using: testProfileName,
        });
      }

      const slug = getCharacterSlug(testProfileName);
      const seedSql = SEED_BY_SLUG[slug];
      if (!seedSql) {
        logError("no seed for character", { slug, test_profile_name: testProfileName });
        return errorResponse(`no seed for character: ${slug}`, 400);
      }

      trace.setInput({ event_type: eventType, slug, testProfileName });
      const span = trace.span(`reseed.${slug}`);

      try {
        log("reseed start", { slug, test_profile_name: testProfileName });
        await runSeed(seedSql);
        span.end();
        log("reseed ok", { slug });
        trace.setOutput({ slug, ok: true });
        return successResponse({ ok: true, slug });
      } catch (err) {
        span.end();
        logError(`reseed ${slug}`, err);
        const msg = err instanceof Error ? err.message : String(err);
        return errorResponse(`seed failed for ${slug}: ${msg}`, 500);
      }
    }

    logError("unrecognized request");
    return errorResponse(
      "unrecognized request — expected healthcheck, action, or event_type",
      400,
    );
  }),
);
