/**
 * Edge Function: leaderboard_resources
 *
 * Returns all leaderboard data (wealth, territory, trading, exploration).
 * Supports event-scoped leaderboards via optional event_id parameter.
 * Implements caching: 5-minute TTL for global, 1-minute TTL for events.
 * Read-only operation - no admin password required.
 *
 * Query Parameters / JSON Body:
 *   - force_refresh: boolean (optional) - Force refresh of cached data
 *   - event_id: string (optional) - Scope leaderboard to event participants
 */

import { createServiceRoleClient } from "../_shared/client.ts";
import { traced } from "../_shared/weave.ts";

const GLOBAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EVENT_CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute

// CORS headers for public access from web clients
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-API-Token, apikey",
  "Access-Control-Max-Age": "86400",
};

function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

class LeaderboardError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "LeaderboardError";
    this.status = status;
  }
}

interface ParsedParams {
  forceRefresh: boolean;
  eventId: string | null;
}

async function parseParams(req: Request): Promise<ParsedParams> {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const forceRefreshParam = url.searchParams.get("force_refresh");
    const eventId = url.searchParams.get("event_id") || null;
    return {
      forceRefresh: forceRefreshParam === "true" || forceRefreshParam === "1",
      eventId,
    };
  }

  if (req.method !== "POST") {
    throw new LeaderboardError("Method not allowed", 405);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    throw new LeaderboardError("invalid JSON payload", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new LeaderboardError("invalid JSON payload", 400);
  }

  const p = payload as Record<string, unknown>;
  let forceRefresh = false;
  if (typeof p.force_refresh === "boolean") {
    forceRefresh = p.force_refresh;
  } else if (typeof p.force_refresh === "string") {
    forceRefresh = p.force_refresh === "true" || p.force_refresh === "1";
  }

  const eventId =
    typeof p.event_id === "string" && p.event_id.trim().length > 0
      ? p.event_id.trim()
      : null;

  return { forceRefresh, eventId };
}

const LEADERBOARD_SELECT = {
  wealth:
    "player_id:character_id, player_name:name, player_type, bank_credits, ship_credits, cargo_value, ships_owned, ship_value, total_wealth",
  territory:
    "player_id:character_id, player_name:name, player_type, sectors_controlled, total_fighters_deployed, total_toll_collected",
  trading:
    "player_id:character_id, player_name:name, player_type, total_trades, total_trade_volume, ports_visited",
  exploration:
    "player_id:character_id, player_name:name, player_type, sectors_visited, first_visit",
};

Deno.serve(traced("leaderboard_resources", async (req, trace) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Public endpoint used by both the web client (GET) and Python client (POST).
  if (!["GET", "POST"].includes(req.method)) {
    return corsResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const supabase = createServiceRoleClient();

  try {
    const { forceRefresh, eventId } = await parseParams(req);

    trace.setInput({ forceRefresh, eventId, method: req.method });

    // ── Event-scoped leaderboard ──
    if (eventId) {
      return await handleEventLeaderboard(supabase, trace, eventId, forceRefresh);
    }

    // ── Global leaderboard ──
    return await handleGlobalLeaderboard(supabase, trace, forceRefresh);
  } catch (err) {
    if (err instanceof LeaderboardError) {
      return corsResponse({ success: false, error: err.message }, err.status);
    }
    console.error("leaderboard_resources.unhandled", err);
    return corsResponse(
      { success: false, error: "internal server error" },
      500,
    );
  }
}));

async function handleEventLeaderboard(
  supabase: ReturnType<typeof createServiceRoleClient>,
  trace: any,
  eventId: string,
  forceRefresh: boolean,
): Promise<Response> {
  // Verify event exists and is visible
  const sEventCheck = trace.span("event_check");
  const { data: event, error: eventError } = await supabase
    .from("world_events")
    .select("event_id, title, frozen_results, ends_at, visible_until")
    .eq("event_id", eventId)
    .gt("visible_until", new Date().toISOString())
    .maybeSingle();

  if (eventError) {
    sEventCheck.end({ error: eventError.message });
    throw new LeaderboardError("Failed to check event", 500);
  }

  if (!event) {
    sEventCheck.end({ error: "Not found" });
    return corsResponse({ success: false, error: "Event not found or expired" }, 404);
  }
  sEventCheck.end({ event_id: event.event_id, has_frozen: !!event.frozen_results });

  // If frozen, return the snapshot directly
  if (event.frozen_results) {
    const frozen = event.frozen_results as Record<string, unknown>;
    trace.setOutput({ cached: false, frozen: true, event_id: eventId });
    return corsResponse({
      success: true,
      wealth: frozen.wealth ?? [],
      territory: frozen.territory ?? [],
      trading: frozen.trading ?? [],
      exploration: frozen.exploration ?? [],
      event_id: eventId,
      event_title: event.title,
      frozen: true,
    });
  }

  // Check event cache (1-min TTL)
  const sCacheCheck = trace.span("event_cache_check");
  const { data: cached, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("*")
    .eq("event_id", eventId)
    .maybeSingle();

  let shouldRefresh = forceRefresh;
  if (!cacheError && cached) {
    const cacheAge = Date.now() - new Date(cached.updated_at).getTime();
    shouldRefresh = shouldRefresh || cacheAge > EVENT_CACHE_TTL_MS;
  } else {
    shouldRefresh = true;
  }
  sCacheCheck.end({ shouldRefresh });

  if (!shouldRefresh && cached) {
    trace.setOutput({ cached: true, event_id: eventId });
    return corsResponse({
      success: true,
      wealth: cached.wealth ?? [],
      territory: cached.territory ?? [],
      trading: cached.trading ?? [],
      exploration: cached.exploration ?? [],
      event_id: eventId,
      event_title: event.title,
      frozen: false,
      cached: true,
      cache_age_ms: Date.now() - new Date(cached.updated_at).getTime(),
    });
  }

  // Fetch participant character_ids
  const sParticipants = trace.span("fetch_participants");
  const { data: participants, error: partError } = await supabase
    .from("world_event_participants")
    .select("character_id")
    .eq("event_id", eventId);

  if (partError) {
    sParticipants.end({ error: partError.message });
    throw new LeaderboardError("Failed to fetch event participants", 500);
  }

  const participantIds = (participants ?? []).map(
    (p: { character_id: string }) => p.character_id,
  );
  sParticipants.end({ count: participantIds.length });

  if (participantIds.length === 0) {
    trace.setOutput({ cached: false, event_id: eventId, empty: true });
    return corsResponse({
      success: true,
      wealth: [],
      territory: [],
      trading: [],
      exploration: [],
      event_id: eventId,
      event_title: event.title,
      frozen: false,
    });
  }

  // Query views filtered to participants
  const sQueryViews = trace.span("query_event_views");
  const [wealthResult, territoryResult, tradingResult, explorationResult] =
    await Promise.all([
      supabase
        .from("leaderboard_wealth")
        .select(LEADERBOARD_SELECT.wealth)
        .in("character_id", participantIds)
        .order("total_wealth", { ascending: false })
        .limit(100),
      supabase
        .from("leaderboard_territory")
        .select(LEADERBOARD_SELECT.territory)
        .in("character_id", participantIds)
        .order("sectors_controlled", { ascending: false })
        .limit(100),
      supabase
        .from("leaderboard_trading")
        .select(LEADERBOARD_SELECT.trading)
        .in("character_id", participantIds)
        .order("total_trade_volume", { ascending: false })
        .limit(100),
      supabase
        .from("leaderboard_exploration")
        .select(LEADERBOARD_SELECT.exploration)
        .in("character_id", participantIds)
        .order("sectors_visited", { ascending: false })
        .limit(100),
    ]);
  sQueryViews.end();

  for (const [name, result] of Object.entries({
    wealth: wealthResult,
    territory: territoryResult,
    trading: tradingResult,
    exploration: explorationResult,
  })) {
    if (result.error) {
      console.error(`leaderboard_resources.event_query.${name}`, result.error);
      throw new LeaderboardError(
        `Failed to query ${name} leaderboard for event`,
        500,
      );
    }
  }

  // Update event cache
  const sUpdateCache = trace.span("update_event_cache");
  await supabase.from("leaderboard_cache").upsert(
    {
      ...(cached ? { id: cached.id } : {}),
      event_id: eventId,
      wealth: wealthResult.data ?? [],
      territory: territoryResult.data ?? [],
      trading: tradingResult.data ?? [],
      exploration: explorationResult.data ?? [],
      updated_at: new Date().toISOString(),
    },
    { onConflict: cached ? "id" : "event_id" },
  );
  sUpdateCache.end();

  trace.setOutput({ cached: false, event_id: eventId });
  return corsResponse({
    success: true,
    wealth: wealthResult.data ?? [],
    territory: territoryResult.data ?? [],
    trading: tradingResult.data ?? [],
    exploration: explorationResult.data ?? [],
    event_id: eventId,
    event_title: event.title,
    frozen: false,
    cached: false,
  });
}

async function handleGlobalLeaderboard(
  supabase: ReturnType<typeof createServiceRoleClient>,
  trace: any,
  forceRefresh: boolean,
): Promise<Response> {
  // Check cache first (global row: event_id IS NULL, id = 1)
  const sCacheCheck = trace.span("cache_check");
  const { data: cached, error: cacheError } = await supabase
    .from("leaderboard_cache")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  let shouldRefresh = forceRefresh;

  if (!cacheError && cached) {
    const cacheAge = Date.now() - new Date(cached.updated_at).getTime();
    const isStale = cacheAge > GLOBAL_CACHE_TTL_MS;
    shouldRefresh = shouldRefresh || isStale;
  } else {
    shouldRefresh = true;
  }
  sCacheCheck.end();

  if (shouldRefresh) {
    console.log("leaderboard_resources.refreshing", {
      forceRefresh,
      cacheAge: cached
        ? Date.now() - new Date(cached.updated_at).getTime()
        : null,
    });

    // Query fresh data from views
    const sQueryViews = trace.span("query_leaderboard_views");
    const [wealthResult, territoryResult, tradingResult, explorationResult] =
      await Promise.all([
        supabase
          .from("leaderboard_wealth")
          .select(LEADERBOARD_SELECT.wealth)
          .order("total_wealth", { ascending: false })
          .limit(100),
        supabase
          .from("leaderboard_territory")
          .select(LEADERBOARD_SELECT.territory)
          .order("sectors_controlled", { ascending: false })
          .limit(100),
        supabase
          .from("leaderboard_trading")
          .select(LEADERBOARD_SELECT.trading)
          .order("total_trade_volume", { ascending: false })
          .limit(100),
        supabase
          .from("leaderboard_exploration")
          .select(LEADERBOARD_SELECT.exploration)
          .order("sectors_visited", { ascending: false })
          .limit(100),
      ]);
    sQueryViews.end();

    if (wealthResult.error) {
      console.error("leaderboard_resources.query.wealth", wealthResult.error);
      throw new LeaderboardError("Failed to query wealth leaderboard", 500);
    }

    if (territoryResult.error) {
      console.error(
        "leaderboard_resources.query.territory",
        territoryResult.error,
      );
      throw new LeaderboardError(
        "Failed to query territory leaderboard",
        500,
      );
    }

    if (tradingResult.error) {
      console.error(
        "leaderboard_resources.query.trading",
        tradingResult.error,
      );
      throw new LeaderboardError("Failed to query trading leaderboard", 500);
    }

    if (explorationResult.error) {
      console.error(
        "leaderboard_resources.query.exploration",
        explorationResult.error,
      );
      throw new LeaderboardError(
        "Failed to query exploration leaderboard",
        500,
      );
    }

    // Update cache
    const sUpdateCache = trace.span("update_cache");
    const { error: upsertError } = await supabase
      .from("leaderboard_cache")
      .upsert({
        id: 1,
        wealth: wealthResult.data ?? [],
        territory: territoryResult.data ?? [],
        trading: tradingResult.data ?? [],
        exploration: explorationResult.data ?? [],
        updated_at: new Date().toISOString(),
      });
    sUpdateCache.end();

    if (upsertError) {
      console.error("leaderboard_resources.cache.upsert", upsertError);
    }

    trace.setOutput({ cached: false, wealth_count: (wealthResult.data ?? []).length, territory_count: (territoryResult.data ?? []).length });
    return corsResponse({
      success: true,
      wealth: wealthResult.data ?? [],
      territory: territoryResult.data ?? [],
      trading: tradingResult.data ?? [],
      exploration: explorationResult.data ?? [],
      cached: false,
    });
  } else {
    // Return cached data
    trace.setOutput({ cached: true, cache_age_ms: Date.now() - new Date(cached.updated_at).getTime() });
    return corsResponse({
      success: true,
      wealth: cached.wealth ?? [],
      territory: cached.territory ?? [],
      trading: cached.trading ?? [],
      exploration: cached.exploration ?? [],
      cached: true,
      cache_age_ms: Date.now() - new Date(cached.updated_at).getTime(),
    });
  }
}
