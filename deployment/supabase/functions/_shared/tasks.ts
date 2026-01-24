import type { SupabaseClient } from "@supabase/supabase-js";

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const START_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type TaskEventRow = {
  ship_id: string | null;
  character_id: string | null;
  task_id: string | null;
  event_type: string | null;
  inserted_at: string | null;
};

export async function fetchActiveTaskIdsByShip(
  supabase: SupabaseClient,
  shipIds: string[],
  activeWindowMs: number = ACTIVE_WINDOW_MS,
  startLookbackMs: number = START_LOOKBACK_MS,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  for (const shipId of shipIds) {
    result.set(shipId, null);
  }

  if (!shipIds.length) {
    return result;
  }

  const shipIdSet = new Set(shipIds);
  const startCutoffIso = new Date(Date.now() - startLookbackMs).toISOString();

  const { data: startShipRows, error: startShipError } = await supabase
    .from("events")
    .select("ship_id, character_id, task_id, event_type, inserted_at")
    .eq("event_type", "task.start")
    .eq("direction", "event_out")
    .gte("inserted_at", startCutoffIso)
    .in("ship_id", shipIds)
    .order("inserted_at", { ascending: false });

  if (startShipError) {
    console.error("tasks.active.lookup.ship_id", startShipError);
    throw new Error("Failed to load task status");
  }

  const { data: startCharacterRows, error: startCharacterError } =
    await supabase
      .from("events")
      .select("ship_id, character_id, task_id, event_type, inserted_at")
      .eq("event_type", "task.start")
      .eq("direction", "event_out")
      .gte("inserted_at", startCutoffIso)
      .in("character_id", shipIds)
      .order("inserted_at", { ascending: false });

  if (startCharacterError) {
    console.error("tasks.active.lookup.character_id", startCharacterError);
    throw new Error("Failed to load task status");
  }

  const combinedStarts = [
    ...(startShipRows ?? []),
    ...(startCharacterRows ?? []),
  ];
  combinedStarts.sort((a, b) => {
    const left = typeof a?.inserted_at === "string" ? a.inserted_at : "";
    const right = typeof b?.inserted_at === "string" ? b.inserted_at : "";
    if (left == right) return 0;
    return left > right ? -1 : 1;
  });

  const latestStartByShip = new Map<string, TaskEventRow>();
  for (const row of combinedStarts) {
    if (
      !row ||
      (typeof row.ship_id !== "string" && typeof row.character_id !== "string")
    ) {
      continue;
    }
    const shipKey =
      typeof row.ship_id === "string" && row.ship_id
        ? row.ship_id
        : typeof row.character_id === "string"
          ? row.character_id
          : null;
    if (!shipKey || !shipIdSet.has(shipKey)) {
      continue;
    }
    if (latestStartByShip.has(shipKey)) {
      continue;
    }
    if (typeof row.task_id !== "string" || !row.task_id) {
      continue;
    }
    latestStartByShip.set(shipKey, row as TaskEventRow);
  }

  const taskIds = Array.from(
    new Set(
      Array.from(latestStartByShip.values())
        .map((row) => row.task_id)
        .filter(
          (taskId): taskId is string =>
            typeof taskId === "string" && taskId.length > 0,
        ),
    ),
  );

  if (!taskIds.length) {
    return result;
  }

  const { data: taskRows, error: taskError } = await supabase
    .from("events")
    .select("task_id, event_type, inserted_at")
    .eq("direction", "event_out")
    .gte("inserted_at", startCutoffIso)
    .in("task_id", taskIds)
    .order("inserted_at", { ascending: false });

  if (taskError) {
    console.error("tasks.active.lookup.task_id", taskError);
    throw new Error("Failed to load task status");
  }

  const latestEventByTask = new Map<string, TaskEventRow>();
  for (const row of taskRows ?? []) {
    if (!row || typeof row.task_id !== "string" || !row.task_id) {
      continue;
    }
    if (latestEventByTask.has(row.task_id)) {
      continue;
    }
    latestEventByTask.set(row.task_id, row as TaskEventRow);
  }

  const now = Date.now();
  for (const [shipId, startEvent] of latestStartByShip) {
    const taskId = startEvent.task_id;
    if (!taskId) {
      continue;
    }
    const latestEvent = latestEventByTask.get(taskId);
    if (!latestEvent || typeof latestEvent.inserted_at !== "string") {
      continue;
    }
    const insertedAtMs = Date.parse(latestEvent.inserted_at);
    if (!Number.isFinite(insertedAtMs)) {
      continue;
    }
    if (latestEvent.event_type === "task.finish") {
      continue;
    }
    if (now - insertedAtMs > activeWindowMs) {
      continue;
    }
    result.set(shipId, taskId);
  }

  return result;
}
