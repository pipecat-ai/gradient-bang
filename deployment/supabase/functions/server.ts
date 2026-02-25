/**
 * Unified local Deno HTTP server for all Gradient Bang edge functions.
 *
 * Monkey-patches Deno.serve() before dynamically importing each edge function
 * to capture its handler without starting 53 separate servers.
 *
 * Usage:
 *   deno run -A server.ts
 *
 * Environment:
 *   LOCAL_API_PORT  - Port to listen on (default: 54321)
 *   All standard edge function env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   POSTGRES_POOLER_URL, EDGE_API_TOKEN, etc.)
 */

const FUNCTION_NAMES = [
  "bank_transfer",
  "character_create",
  "character_delete",
  "character_info",
  "character_modify",
  "combat_action",
  "combat_collect_fighters",
  "combat_initiate",
  "combat_leave_fighters",
  "combat_set_garrison_mode",
  "combat_tick",
  "corporation_create",
  "corporation_info",
  "corporation_join",
  "corporation_kick",
  "corporation_leave",
  "corporation_list",
  "corporation_regenerate_invite_code",
  "dump_cargo",
  "event_query",
  "events_since",
  "join",
  "leaderboard_resources",
  "list_known_ports",
  "list_user_ships",
  "local_map_region",
  "login",
  "move",
  "my_corporation",
  "my_status",
  "path_with_region",
  "plot_course",
  "purchase_fighters",
  "quest_assign",
  "quest_status",
  "recharge_warp_power",
  "regenerate_ports",
  "register",
  "reset_ports",
  "salvage_collect",
  "send_message",
  "ship_purchase",
  "ship_rename",
  "start",
  "task_cancel",
  "task_lifecycle",
  "test_reset",
  "trade",
  "transfer_credits",
  "transfer_warp_power",
  "user_character_create",
  "user_character_list",
  "user_confirm",
];

// ---------------------------------------------------------------------------
// Phase 1: Capture handlers by monkey-patching Deno.serve
// ---------------------------------------------------------------------------

type Handler = (req: Request) => Promise<Response>;
const routes: Record<string, Handler> = {};
let currentFunctionName = "";

// Save the real Deno.serve so we can restore it later
const realServe = Deno.serve.bind(Deno);

// Replace Deno.serve with a stub that captures the handler
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (handlerOrOpts: any, maybeHandler?: any) => {
  const fn: Handler | undefined =
    typeof handlerOrOpts === "function" ? handlerOrOpts : maybeHandler;
  if (currentFunctionName && fn) {
    routes[currentFunctionName] = fn;
  }
  // Return a fake Deno.HttpServer to satisfy any callers
  return {
    finished: Promise.resolve(),
    ref() {},
    unref() {},
    shutdown() {
      return Promise.resolve();
    },
    addr: { port: 0, hostname: "localhost", transport: "tcp" as const },
  };
};

// Dynamically import each edge function — Deno.serve inside each module
// will call our stub, populating `routes`.
for (const name of FUNCTION_NAMES) {
  currentFunctionName = name;
  try {
    await import(`./${name}/index.ts`);
  } catch (err) {
    console.error(`[server] Failed to load function "${name}":`, err);
  }
}
currentFunctionName = "";

// Restore the real Deno.serve
// deno-lint-ignore no-explicit-any
(Deno as any).serve = realServe;

const loadedCount = Object.keys(routes).length;
console.log(
  `[server] Loaded ${loadedCount}/${FUNCTION_NAMES.length} functions`,
);
if (loadedCount < FUNCTION_NAMES.length) {
  const missing = FUNCTION_NAMES.filter((n) => !(n in routes));
  console.warn(`[server] Missing functions: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Phase 2: Start the actual unified HTTP server
// ---------------------------------------------------------------------------

const PORT = parseInt(Deno.env.get("LOCAL_API_PORT") ?? "54321", 10);

Deno.serve({ port: PORT }, async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Health check
  if (path === "/health" || path === "/") {
    return new Response(
      JSON.stringify({ status: "ok", functions: loadedCount }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // Extract function name from path.
  // Supports: /functions/v1/{name} and /{name}
  let functionName: string | undefined;
  const fv1Match = path.match(/^\/functions\/v1\/([^/?]+)/);
  if (fv1Match) {
    functionName = fv1Match[1];
  } else {
    const directMatch = path.match(/^\/([^/?]+)/);
    if (directMatch && directMatch[1] !== "health") {
      functionName = directMatch[1];
    }
  }

  if (!functionName) {
    return new Response(
      JSON.stringify({ success: false, error: "not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const handler = routes[functionName];
  if (!handler) {
    console.warn(`[server] Unknown function: ${functionName}`);
    return new Response(
      JSON.stringify({
        success: false,
        error: `unknown function: ${functionName}`,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    return await handler(req);
  } catch (err) {
    console.error(`[server] Unhandled error in ${functionName}:`, err);
    return new Response(
      JSON.stringify({ success: false, error: "internal server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

console.log(
  `[server] Local API server listening on port ${PORT} with ${loadedCount} functions`,
);
