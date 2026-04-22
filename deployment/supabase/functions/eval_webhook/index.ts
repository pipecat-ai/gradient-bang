import {
  validateApiToken,
  unauthorizedResponse,
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

const EVAL_ENABLED = Deno.env.get("EVAL_WEBHOOK_ENABLED") === "true";
const CEKURA_SECRET = Deno.env.get("CEKURA_WEBHOOK_SECRET") ?? "";

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
    // Fail-closed: disabled unless explicitly opted in
    if (!EVAL_ENABLED) {
      return errorResponse(
        "eval_webhook is disabled in this environment",
        403,
      );
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = await parseJsonRequest(req);
    } catch (err) {
      const response = respondWithError(err);
      if (response) return response;
      console.error("eval_webhook.parse", err);
      return errorResponse("invalid JSON payload", 400);
    }

    // Health check (API token auth)
    if (payload.healthcheck === true) {
      if (!validateApiToken(req)) return unauthorizedResponse();
      return successResponse({ status: "ok", eval_enabled: true });
    }

    // Seed all characters (API token auth)
    if (payload.action === "seed_all") {
      if (!validateApiToken(req)) return unauthorizedResponse();

      const requestId = resolveRequestId(payload);
      trace.setInput({ action: "seed_all", requestId });

      const results: Array<{ name: string; ok: boolean; error?: string }> = [];
      for (const seed of ALL_SEEDS) {
        const span = trace.span(`seed.${seed.name}`);
        try {
          await runSeed(seed.sql);
          results.push({ name: seed.name, ok: true });
          span.end();
          console.log(`eval_webhook.seed_all: ${seed.name} ok`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: seed.name, ok: false, error: msg });
          span.end();
          console.error(`eval_webhook.seed_all: ${seed.name} failed:`, msg);
        }
      }

      const allOk = results.every((r) => r.ok);
      trace.setOutput({ request_id: requestId, allOk, count: results.length });

      if (!allOk) {
        return errorResponse("some seeds failed", 500, { results });
      }
      return successResponse({
        request_id: requestId,
        seeded: results.length,
        results,
      });
    }

    // Cekura webhook (X-CEKURA-SECRET auth)
    const eventType = payload.event_type;
    if (eventType !== undefined) {
      const provided = req.headers.get("X-CEKURA-SECRET") ?? "";
      if (!CEKURA_SECRET || provided !== CEKURA_SECRET) {
        return errorResponse("invalid or missing X-CEKURA-SECRET", 401);
      }

      if (eventType !== "result.completed") {
        return errorResponse(`unknown event_type: ${eventType}`, 400);
      }

      const data =
        (payload.data as Record<string, unknown> | undefined) ?? {};
      const testProfileName = String(data.test_profile_name ?? "");
      if (!testProfileName) {
        return errorResponse("missing data.test_profile_name", 400);
      }

      const slug = getCharacterSlug(testProfileName);
      const seedSql = SEED_BY_SLUG[slug];
      if (!seedSql) {
        return errorResponse(`no seed for character: ${slug}`, 400);
      }

      trace.setInput({ event_type: eventType, slug, testProfileName });
      const span = trace.span(`reseed.${slug}`);

      try {
        console.log(`eval_webhook.reseed: ${slug}`);
        await runSeed(seedSql);
        span.end();
        console.log(`eval_webhook.reseed: ${slug} ok`);
        trace.setOutput({ slug, ok: true });
        return successResponse({ ok: true, slug });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        span.end();
        console.error(`eval_webhook.reseed: ${slug} failed:`, msg);
        return errorResponse(`seed failed for ${slug}: ${msg}`, 500);
      }
    }

    return errorResponse(
      "unrecognized request — expected healthcheck, action, or event_type",
      400,
    );
  }),
);
