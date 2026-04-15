/**
 * Edge Function: leaderboard_session
 *
 * Session-aware leaderboard endpoint. Given a character_id, automatically
 * resolves whether to return event-scoped or global leaderboard data.
 *
 * If the character is in an active/visible event -> returns event-scoped data.
 * Otherwise -> returns global data.
 *
 * Same response shape as leaderboard_resources, plus event_id/event_title
 * when event-scoped.
 *
 * Query Parameters / JSON Body:
 *   - character_id: string (required) - The character to resolve scope for
 *   - force_refresh: boolean (optional) - Force refresh of cached data
 */

import { createServiceRoleClient } from "../_shared/client.ts";
import { traced } from "../_shared/weave.ts";

const GLOBAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EVENT_CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute

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

class SessionLeaderboardError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "SessionLeaderboardError";
    this.status = status;
  }
}

interface ParsedParams {
  characterId: string | null;
  forceRefresh: boolean;
}

function parseParams(req: Request): ParsedParams {
  const url = new URL(req.url);
  const characterId = url.searchParams.get("character_id") || null;
  const fr = url.searchParams.get("force_refresh");
  return {
    characterId,
    forceRefresh: fr === "true" || fr === "1",
  };
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

Deno.serve(traced("leaderboard_session", async (req, trace) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return corsResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const supabase = createServiceRoleClient();

  try {
    const { characterId, forceRefresh } = parseParams(req);

    trace.setInput({ characterId, forceRefresh });

    if (!characterId) {
      // No character_id -> return global leaderboard
      return await queryLeaderboard(supabase, trace, null, null, forceRefresh);
    }

    // Look up character's event membership
    const sEventLookup = trace.span("event_lookup");
    const { data: membership, error: memError } = await supabase
      .from("world_event_participants")
      .select(
        "event_id, world_events!inner(event_id, title, ends_at, visible_until, frozen_results)",
      )
      .eq("character_id", characterId)
      .maybeSingle();

    if (memError) {
      sEventLookup.end({ error: memError.message });
      // Fall through to global on error
      return await queryLeaderboard(supabase, trace, null, null, forceRefresh);
    }

    if (!membership) {
      sEventLookup.end({ result: "no_event" });
      return await queryLeaderboard(supabase, trace, null, null, forceRefresh);
    }

    const event = membership.world_events as any;
    const visibleUntil = new Date(event.visible_until);
    if (visibleUntil <= new Date()) {
      sEventLookup.end({ result: "event_expired" });
      return await queryLeaderboard(supabase, trace, null, null, forceRefresh);
    }

    sEventLookup.end({
      event_id: event.event_id,
      has_frozen: !!event.frozen_results,
    });

    return await queryLeaderboard(
      supabase,
      trace,
      event.event_id,
      event.title,
      forceRefresh,
      event.frozen_results,
    );
  } catch (err) {
    if (err instanceof SessionLeaderboardError) {
      return corsResponse({ success: false, error: err.message }, err.status);
    }
    console.error("leaderboard_session.unhandled", err);
    return corsResponse(
      { success: false, error: "internal server error" },
      500,
    );
  }
}));

async function queryLeaderboard(
  supabase: ReturnType<typeof createServiceRoleClient>,
  trace: any,
  eventId: string | null,
  eventTitle: string | null,
  forceRefresh: boolean,
  frozenResults?: any,
): Promise<Response> {
  // If frozen, return the snapshot directly
  if (eventId && frozenResults) {
    trace.setOutput({ cached: false, frozen: true, event_id: eventId });
    return corsResponse({
      success: true,
      wealth: frozenResults.wealth ?? [],
      territory: frozenResults.territory ?? [],
      trading: frozenResults.trading ?? [],
      exploration: frozenResults.exploration ?? [],
      event_id: eventId,
      event_title: eventTitle,
      frozen: true,
    });
  }

  const cacheTtl = eventId ? EVENT_CACHE_TTL_MS : GLOBAL_CACHE_TTL_MS;

  // Check cache
  const sCacheCheck = trace.span("cache_check");
  let cacheQuery = supabase.from("leaderboard_cache").select("*");
  if (eventId) {
    cacheQuery = cacheQuery.eq("event_id", eventId);
  } else {
    cacheQuery = cacheQuery.eq("id", 1);
  }
  const { data: cached, error: cacheError } = await cacheQuery.maybeSingle();

  let shouldRefresh = forceRefresh;
  if (!cacheError && cached) {
    const cacheAge = Date.now() - new Date(cached.updated_at).getTime();
    shouldRefresh = shouldRefresh || cacheAge > cacheTtl;
  } else {
    shouldRefresh = true;
  }
  sCacheCheck.end({ shouldRefresh, isEvent: !!eventId });

  if (!shouldRefresh && cached) {
    trace.setOutput({ cached: true, event_id: eventId });
    return corsResponse({
      success: true,
      wealth: cached.wealth ?? [],
      territory: cached.territory ?? [],
      trading: cached.trading ?? [],
      exploration: cached.exploration ?? [],
      ...(eventId
        ? { event_id: eventId, event_title: eventTitle, frozen: false }
        : {}),
      cached: true,
      cache_age_ms: Date.now() - new Date(cached.updated_at).getTime(),
    });
  }

  // For event-scoped queries, get participant IDs
  let participantIds: string[] | null = null;
  if (eventId) {
    const sParticipants = trace.span("fetch_participants");
    const { data: participants, error: partError } = await supabase
      .from("world_event_participants")
      .select("character_id")
      .eq("event_id", eventId);

    if (partError) {
      sParticipants.end({ error: partError.message });
      throw new SessionLeaderboardError(
        "Failed to fetch event participants",
        500,
      );
    }
    participantIds = (participants ?? []).map(
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
        event_title: eventTitle,
        frozen: false,
      });
    }
  }

  // Query views
  const sQueryViews = trace.span("query_views");
  const buildQuery = (
    view: string,
    select: string,
    orderCol: string,
  ) => {
    let q = supabase.from(view).select(select);
    if (participantIds) {
      q = q.in("character_id", participantIds);
    }
    return q.order(orderCol, { ascending: false }).limit(100);
  };

  const [wealthResult, territoryResult, tradingResult, explorationResult] =
    await Promise.all([
      buildQuery("leaderboard_wealth", LEADERBOARD_SELECT.wealth, "total_wealth"),
      buildQuery("leaderboard_territory", LEADERBOARD_SELECT.territory, "sectors_controlled"),
      buildQuery("leaderboard_trading", LEADERBOARD_SELECT.trading, "total_trade_volume"),
      buildQuery("leaderboard_exploration", LEADERBOARD_SELECT.exploration, "sectors_visited"),
    ]);
  sQueryViews.end();

  for (const [name, result] of Object.entries({
    wealth: wealthResult,
    territory: territoryResult,
    trading: tradingResult,
    exploration: explorationResult,
  })) {
    if (result.error) {
      console.error(`leaderboard_session.query.${name}`, result.error);
      throw new SessionLeaderboardError(
        `Failed to query ${name} leaderboard`,
        500,
      );
    }
  }

  // Update cache
  const sUpdateCache = trace.span("update_cache");
  if (eventId) {
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
  } else {
    await supabase.from("leaderboard_cache").upsert({
      id: 1,
      wealth: wealthResult.data ?? [],
      territory: territoryResult.data ?? [],
      trading: tradingResult.data ?? [],
      exploration: explorationResult.data ?? [],
      updated_at: new Date().toISOString(),
    });
  }
  sUpdateCache.end();

  trace.setOutput({ cached: false, event_id: eventId });
  return corsResponse({
    success: true,
    wealth: wealthResult.data ?? [],
    territory: territoryResult.data ?? [],
    trading: tradingResult.data ?? [],
    exploration: explorationResult.data ?? [],
    ...(eventId
      ? { event_id: eventId, event_title: eventTitle, frozen: false }
      : {}),
    cached: false,
  });
}
