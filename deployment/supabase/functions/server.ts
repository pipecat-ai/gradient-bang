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

// Auto-discover edge functions: any subdirectory containing index.ts
const SKIP = new Set(["_shared"]);
const serverDir = new URL(".", import.meta.url).pathname;
const functionNames: string[] = [];
for (const entry of Deno.readDirSync(serverDir)) {
  if (!entry.isDirectory || SKIP.has(entry.name) || entry.name.startsWith(".")) {
    continue;
  }
  try {
    Deno.statSync(`${serverDir}${entry.name}/index.ts`);
    functionNames.push(entry.name);
  } catch {
    // No index.ts in this directory, skip
  }
}
functionNames.sort();

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
for (const name of functionNames) {
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
  `[server] Loaded ${loadedCount}/${functionNames.length} functions`,
);
if (loadedCount < functionNames.length) {
  const missing = functionNames.filter((n) => !(n in routes));
  console.warn(`[server] Missing functions: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Phase 2: Start the actual unified HTTP server
// ---------------------------------------------------------------------------

const PORT = parseInt(Deno.env.get("LOCAL_API_PORT") ?? "54380", 10);

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
