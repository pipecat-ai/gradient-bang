import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Return the active task UUID per ship, or null if the ship is idle.
 *
 * Reads `ship_instances.current_task_id` directly — this column is the
 * source of truth for "this ship is currently running a task" and is
 * maintained atomically by the lock RPCs (acquire/release in
 * task_lifecycle, release_ship_task_lock / force_release_ship_task_lock
 * in task_cancel). Replaces the pre-Groundwork event-scanning path that
 * inferred active tasks from task.start without a matching task.finish.
 */
export async function fetchActiveTaskIdsByShip(
  supabase: SupabaseClient,
  shipIds: string[],
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  for (const shipId of shipIds) {
    result.set(shipId, null);
  }

  if (!shipIds.length) {
    return result;
  }

  const { data, error } = await supabase
    .from("ship_instances")
    .select("ship_id, current_task_id")
    .in("ship_id", shipIds);

  if (error) {
    console.error("tasks.active.lookup.column", error);
    throw new Error("Failed to load task status");
  }

  for (const row of data ?? []) {
    if (
      row &&
      typeof row.ship_id === "string" &&
      typeof row.current_task_id === "string"
    ) {
      result.set(row.ship_id, row.current_task_id);
    }
  }

  return result;
}
