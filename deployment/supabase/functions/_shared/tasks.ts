import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server's best-effort guess at the active task per ship, derived from the
 * events table.
 *
 * There is no DB-persistent ship-task lock anymore — the bot's in-memory
 * `VoiceAgent._locked_ships` is the authoritative source of "ship is busy".
 * Server-side callers (UI list endpoints, ship_byoa_configure preconditions)
 * still want a hint, so we derive one from `task.start` events without a
 * matching `task.finish`/`task.cancel` inside a recent window. A bot crash
 * that drops `task.finish` makes a ship look busy until the window expires —
 * conservative but acceptable for hint-only consumers.
 */
const ACTIVE_TASK_WINDOW_MINUTES = 60;

export type ActiveShipTask = {
  task_id: string;
  actor_character_id: string | null;
};

type EventRow = {
  ship_id: string;
  task_id: string;
  inserted_at: string;
  actor_character_id: string | null;
};

async function scanActiveTasks(
  supabase: SupabaseClient,
  shipIds: string[],
): Promise<Map<string, ActiveShipTask>> {
  const result = new Map<string, ActiveShipTask>();
  if (!shipIds.length) return result;

  const cutoff = new Date(
    Date.now() - ACTIVE_TASK_WINDOW_MINUTES * 60_000,
  ).toISOString();

  const { data: starts, error: startsError } = await supabase
    .from("events")
    .select("ship_id, task_id, inserted_at, actor_character_id")
    .eq("event_type", "task.start")
    .in("ship_id", shipIds)
    .gt("inserted_at", cutoff)
    .order("inserted_at", { ascending: false });

  if (startsError) {
    console.error("tasks.active.lookup.starts", startsError);
    throw new Error("Failed to load task status");
  }

  const latestPerShip = new Map<string, EventRow>();
  for (const row of (starts ?? []) as EventRow[]) {
    if (
      typeof row.ship_id === "string" &&
      typeof row.task_id === "string" &&
      !latestPerShip.has(row.ship_id)
    ) {
      latestPerShip.set(row.ship_id, row);
    }
  }

  if (latestPerShip.size === 0) return result;

  const candidateTaskIds = Array.from(
    new Set(Array.from(latestPerShip.values()).map((r) => r.task_id)),
  );
  const { data: terminations, error: terminationsError } = await supabase
    .from("events")
    .select("task_id")
    .in("task_id", candidateTaskIds)
    .in("event_type", ["task.finish", "task.cancel"]);

  if (terminationsError) {
    console.error("tasks.active.lookup.terminations", terminationsError);
    throw new Error("Failed to load task status");
  }

  const terminated = new Set<string>(
    (terminations ?? [])
      .map((r) => (typeof r.task_id === "string" ? r.task_id : null))
      .filter((v): v is string => v !== null),
  );

  for (const [shipId, row] of latestPerShip.entries()) {
    if (!terminated.has(row.task_id)) {
      result.set(shipId, {
        task_id: row.task_id,
        actor_character_id: typeof row.actor_character_id === "string"
          ? row.actor_character_id
          : null,
      });
    }
  }

  return result;
}

/** Active task_id per ship, or null if idle. */
export async function fetchActiveTaskIdsByShip(
  supabase: SupabaseClient,
  shipIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  for (const shipId of shipIds) result.set(shipId, null);
  const active = await scanActiveTasks(supabase, shipIds);
  for (const [shipId, info] of active.entries()) {
    result.set(shipId, info.task_id);
  }
  return result;
}

/** Active task + actor per ship, or null if idle. */
export async function fetchActiveTasksByShip(
  supabase: SupabaseClient,
  shipIds: string[],
): Promise<Map<string, ActiveShipTask | null>> {
  const result = new Map<string, ActiveShipTask | null>();
  for (const shipId of shipIds) result.set(shipId, null);
  const active = await scanActiveTasks(supabase, shipIds);
  for (const [shipId, info] of active.entries()) {
    result.set(shipId, info);
  }
  return result;
}
