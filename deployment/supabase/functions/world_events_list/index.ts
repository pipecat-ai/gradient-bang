/**
 * Edge Function: world_events_list
 *
 * Public GET endpoint returning all currently visible world events.
 * For each event, includes top 3 players per leaderboard category.
 * Does NOT include join codes (by design).
 */

import { createServiceRoleClient } from "../_shared/client.ts";
import { traced } from "../_shared/weave.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

const TOP_N = 3;

const LEADERBOARD_SELECT = {
  wealth:
    "player_id:character_id, player_name:name, player_type, total_wealth",
  trading:
    "player_id:character_id, player_name:name, player_type, total_trade_volume",
  exploration:
    "player_id:character_id, player_name:name, player_type, sectors_visited",
};

Deno.serve(traced("world_events_list", async (req, trace) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return corsResponse({ success: false, error: "Method not allowed" }, 405);
  }

  const supabase = createServiceRoleClient();

  try {
    // Fetch all visible events
    const sEvents = trace.span("fetch_events");
    const { data: events, error: eventsError } = await supabase
      .from("world_events")
      .select(
        "event_id, title, description, link_url, image_url, starts_at, ends_at, visible_until, frozen_results",
      )
      .gt("visible_until", new Date().toISOString())
      .order("starts_at", { ascending: false });

    if (eventsError) {
      sEvents.end({ error: eventsError.message });
      console.error("world_events_list.fetch", eventsError);
      return corsResponse(
        { success: false, error: "Failed to fetch events" },
        500,
      );
    }
    sEvents.end({ count: (events ?? []).length });

    if (!events || events.length === 0) {
      trace.setOutput({ count: 0 });
      return corsResponse({ success: true, events: [] });
    }

    // Get participant counts for all events
    const sParticipants = trace.span("fetch_participant_counts");
    const eventIds = events.map((e) => e.event_id);
    const { data: participantRows, error: partError } = await supabase
      .from("world_event_participants")
      .select("event_id, character_id")
      .in("event_id", eventIds);

    if (partError) {
      sParticipants.end({ error: partError.message });
      console.error("world_events_list.participants", partError);
    }

    // Build participant count and ID maps
    const participantCountMap = new Map<string, number>();
    const participantIdMap = new Map<string, string[]>();
    for (const row of participantRows ?? []) {
      const count = participantCountMap.get(row.event_id) ?? 0;
      participantCountMap.set(row.event_id, count + 1);
      const ids = participantIdMap.get(row.event_id) ?? [];
      ids.push(row.character_id);
      participantIdMap.set(row.event_id, ids);
    }
    sParticipants.end();

    // Build response for each event
    const sTopPlayers = trace.span("fetch_top_players");
    const result = [];

    for (const event of events) {
      const isEnded = new Date(event.ends_at) <= new Date();
      const participantCount =
        participantCountMap.get(event.event_id) ?? 0;

      let topPlayers: Record<string, unknown[]> = {
        wealth: [],
        trading: [],
        exploration: [],
      };

      if (event.frozen_results) {
        // Extract top N from frozen blob
        const frozen = event.frozen_results as Record<string, unknown[]>;
        topPlayers = {
          wealth: (frozen.wealth ?? []).slice(0, TOP_N),
          trading: (frozen.trading ?? []).slice(0, TOP_N),
          exploration: (frozen.exploration ?? []).slice(0, TOP_N),
        };
      } else {
        // Live event: query views filtered to participants
        const ids = participantIdMap.get(event.event_id) ?? [];
        if (ids.length > 0) {
          const [wealthRes, tradingRes, explorationRes] = await Promise.all([
            supabase
              .from("leaderboard_wealth")
              .select(LEADERBOARD_SELECT.wealth)
              .in("character_id", ids)
              .order("total_wealth", { ascending: false })
              .limit(TOP_N),
            supabase
              .from("leaderboard_trading")
              .select(LEADERBOARD_SELECT.trading)
              .in("character_id", ids)
              .order("total_trade_volume", { ascending: false })
              .limit(TOP_N),
            supabase
              .from("leaderboard_exploration")
              .select(LEADERBOARD_SELECT.exploration)
              .in("character_id", ids)
              .order("sectors_visited", { ascending: false })
              .limit(TOP_N),
          ]);

          topPlayers = {
            wealth: wealthRes.data ?? [],
            trading: tradingRes.data ?? [],
            exploration: explorationRes.data ?? [],
          };
        }
      }

      result.push({
        event_id: event.event_id,
        title: event.title,
        description: event.description,
        link_url: event.link_url,
        image_url: event.image_url,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        is_ended: isEnded,
        participant_count: participantCount,
        top_players: topPlayers,
      });
    }
    sTopPlayers.end();

    trace.setOutput({ count: result.length });
    return corsResponse({ success: true, events: result });
  } catch (err) {
    console.error("world_events_list.unhandled", err);
    return corsResponse(
      { success: false, error: "internal server error" },
      500,
    );
  }
}));
