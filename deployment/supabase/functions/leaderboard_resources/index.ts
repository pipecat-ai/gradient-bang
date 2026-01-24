/**
 * Edge Function: leaderboard_resources
 *
 * Returns all leaderboard data (wealth, territory, trading, exploration).
 * Implements caching with 5-minute expiration.
 * Read-only operation - no admin password required.
 *
 * Query Parameters:
 *   - force_refresh: boolean (optional) - Force refresh of cached data
 */

import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import { errorResponse, successResponse } from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class LeaderboardError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "LeaderboardError";
    this.status = status;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Only allow GET requests
  if (req.method !== "GET") {
    return errorResponse("Method not allowed", 405);
  }

  const supabase = createServiceRoleClient();

  try {
    // Parse query parameters
    const url = new URL(req.url);
    const forceRefreshParam = url.searchParams.get("force_refresh");
    const forceRefresh =
      forceRefreshParam === "true" || forceRefreshParam === "1";

    // Check cache first
    const { data: cached, error: cacheError } = await supabase
      .from("leaderboard_cache")
      .select("*")
      .eq("id", 1)
      .maybeSingle();

    let shouldRefresh = forceRefresh;

    if (!cacheError && cached) {
      const cacheAge = Date.now() - new Date(cached.updated_at).getTime();
      const isStale = cacheAge > CACHE_TTL_MS;
      shouldRefresh = shouldRefresh || isStale;
    } else {
      // No cache exists, need to refresh
      shouldRefresh = true;
    }

    if (shouldRefresh) {
      console.log("leaderboard_resources.refreshing", {
        forceRefresh,
        cacheAge: cached
          ? Date.now() - new Date(cached.updated_at).getTime()
          : null,
      });

      // Refresh materialized views
      const { error: refreshWealthError } = await supabase.rpc(
        "refresh_materialized_view",
        {
          view_name: "leaderboard_wealth",
        },
      );
      if (refreshWealthError) {
        console.error(
          "leaderboard_resources.refresh.wealth",
          refreshWealthError,
        );
      }

      const { error: refreshTerritoryError } = await supabase.rpc(
        "refresh_materialized_view",
        {
          view_name: "leaderboard_territory",
        },
      );
      if (refreshTerritoryError) {
        console.error(
          "leaderboard_resources.refresh.territory",
          refreshTerritoryError,
        );
      }

      const { error: refreshTradingError } = await supabase.rpc(
        "refresh_materialized_view",
        {
          view_name: "leaderboard_trading",
        },
      );
      if (refreshTradingError) {
        console.error(
          "leaderboard_resources.refresh.trading",
          refreshTradingError,
        );
      }

      const { error: refreshExplorationError } = await supabase.rpc(
        "refresh_materialized_view",
        {
          view_name: "leaderboard_exploration",
        },
      );
      if (refreshExplorationError) {
        console.error(
          "leaderboard_resources.refresh.exploration",
          refreshExplorationError,
        );
      }

      // Query fresh data from materialized views
      const [wealthResult, territoryResult, tradingResult, explorationResult] =
        await Promise.all([
          supabase
            .from("leaderboard_wealth")
            .select(
              "name, bank_credits, ship_credits, cargo_value, ships_owned, ship_value, total_wealth",
            )
            .order("total_wealth", { ascending: false })
            .limit(100),
          supabase
            .from("leaderboard_territory")
            .select(
              "name, sectors_controlled, total_fighters_deployed, total_toll_collected",
            )
            .order("sectors_controlled", { ascending: false })
            .limit(100),
          supabase
            .from("leaderboard_trading")
            .select("name, total_trades, total_trade_volume, ports_visited")
            .order("total_trade_volume", { ascending: false })
            .limit(100),
          supabase
            .from("leaderboard_exploration")
            .select("name, sectors_visited, first_visit")
            .order("sectors_visited", { ascending: false })
            .limit(100),
        ]);

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

      if (upsertError) {
        console.error("leaderboard_resources.cache.upsert", upsertError);
        // Don't fail if cache update fails, just return fresh data
      }

      return successResponse({
        wealth: wealthResult.data ?? [],
        territory: territoryResult.data ?? [],
        trading: tradingResult.data ?? [],
        exploration: explorationResult.data ?? [],
        cached: false,
      });
    } else {
      // Return cached data
      return successResponse({
        wealth: cached.wealth ?? [],
        territory: cached.territory ?? [],
        trading: cached.trading ?? [],
        exploration: cached.exploration ?? [],
        cached: true,
        cache_age_ms: Date.now() - new Date(cached.updated_at).getTime(),
      });
    }
  } catch (err) {
    if (err instanceof LeaderboardError) {
      return errorResponse(err.message, err.status);
    }
    console.error("leaderboard_resources.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});
