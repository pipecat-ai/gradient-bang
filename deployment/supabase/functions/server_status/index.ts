/**
 * Public Edge Function: server_status
 *
 * Returns a browser-safe status snapshot for the login screen.
 * No EDGE_API_TOKEN required.
 */

import { getPublicServerStatusSnapshot } from "../_shared/server_status.ts";
import { traced } from "../_shared/weave.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

function corsJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(traced("server_status", async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return corsJsonResponse(
      { success: false, error: "Method not allowed" },
      405,
    );
  }

  return corsJsonResponse({
    success: true,
    ...getPublicServerStatusSnapshot(),
  });
}));
