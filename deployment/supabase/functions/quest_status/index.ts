/**
 * Edge Function: quest_status
 *
 * Returns all active quests for a character, including current step progress
 * and quest/step definitions. Emits a quest.status event with the results.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { emitCharacterEvent, buildEventSource } from "../_shared/events.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

type JsonRecord = Record<string, unknown>;

interface QuestStepInfo {
  quest_id: string;
  step_id: string;
  step_index: number;
  name: string;
  description: string | null;
  target_value: number;
  current_value: number;
  completed: boolean;
  meta: JsonRecord;
  reward_credits: number | null;
  reward_claimed: boolean;
}

interface QuestInfo {
  quest_id: string;
  code: string;
  name: string;
  description: string | null;
  status: string;
  current_step_index: number;
  started_at: string;
  completed_at: string | null;
  meta: JsonRecord;
  current_step: QuestStepInfo | null;
  completed_steps: QuestStepInfo[];
}

Deno.serve(traced("quest_status", async (req, trace) => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: JsonRecord;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("quest_status.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: "ok" });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, "character_id");

    trace.setInput({ characterId, requestId });

    const sFetch = trace.span("fetch_quest_status");
    const result = await fetchQuestStatus(supabase, characterId);
    sFetch.end();

    const sEmit = trace.span("emit_event");
    const source = buildEventSource("quest_status", requestId);
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "quest.status",
      payload: { source, ...result },
      requestId,
    });
    sEmit.end();

    trace.setOutput({ request_id: requestId, quest_count: result.quests.length });
    return successResponse({ request_id: requestId });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error("quest_status.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));

async function fetchQuestStatus(
  supabase: SupabaseClient,
  characterId: string,
): Promise<{ quests: QuestInfo[] }> {
  // Get all player quests with their quest definitions
  const { data: playerQuests, error: pqError } = await supabase
    .from("player_quests")
    .select(
      `
      id,
      quest_id,
      status,
      current_step_index,
      started_at,
      completed_at,
      quest_definitions (
        code,
        name,
        description,
        meta
      )
    `,
    )
    .eq("player_id", characterId)
    .in("status", ["active", "completed"])
    .order("started_at", { ascending: true });

  if (pqError) {
    console.error("quest_status.player_quests", pqError);
    throw new Error("Failed to load player quests");
  }

  if (!playerQuests || playerQuests.length === 0) {
    return { quests: [] };
  }

  const playerQuestIds = playerQuests.map((pq) => pq.id);

  // Get all player quest steps with their step definitions
  const { data: playerSteps, error: psError } = await supabase
    .from("player_quest_steps")
    .select(
      `
      player_quest_id,
      step_id,
      current_value,
      completed_at,
      reward_claimed_at,
      quest_step_definitions (
        step_index,
        name,
        description,
        target_value,
        meta,
        reward_credits
      )
    `,
    )
    .in("player_quest_id", playerQuestIds);

  if (psError) {
    console.error("quest_status.player_steps", psError);
    throw new Error("Failed to load player quest steps");
  }

  // Group steps by player_quest_id
  const stepsByQuest = new Map<string, typeof playerSteps>();
  for (const step of playerSteps ?? []) {
    const existing = stepsByQuest.get(step.player_quest_id) ?? [];
    existing.push(step);
    stepsByQuest.set(step.player_quest_id, existing);
  }

  // Build response
  const quests: QuestInfo[] = [];

  for (const pq of playerQuests) {
    const def = pq.quest_definitions as unknown as {
      code: string;
      name: string;
      description: string | null;
      meta: JsonRecord;
    };

    if (!def) continue;

    const steps = stepsByQuest.get(pq.id) ?? [];

    const completedSteps: QuestStepInfo[] = [];
    let currentStep: QuestStepInfo | null = null;

    for (const step of steps) {
      const stepDef = step.quest_step_definitions as unknown as {
        step_index: number;
        name: string;
        description: string | null;
        target_value: number;
        meta: JsonRecord;
        reward_credits: number | null;
      };

      if (!stepDef) continue;

      const stepInfo: QuestStepInfo = {
        quest_id: pq.quest_id,
        step_id: step.step_id,
        step_index: stepDef.step_index,
        name: stepDef.name,
        description: stepDef.description,
        target_value: Number(stepDef.target_value),
        current_value: Number(step.current_value),
        completed: step.completed_at !== null,
        meta: stepDef.meta ?? {},
        reward_credits: stepDef.reward_credits,
        reward_claimed: step.reward_claimed_at !== null,
      };

      if (step.completed_at) {
        completedSteps.push(stepInfo);
      } else {
        currentStep = stepInfo;
      }
    }

    completedSteps.sort((a, b) => a.step_index - b.step_index);

    quests.push({
      quest_id: pq.quest_id,
      code: def.code,
      name: def.name,
      description: def.description,
      status: pq.status,
      current_step_index: pq.current_step_index,
      started_at: pq.started_at,
      completed_at: pq.completed_at,
      meta: def.meta ?? {},
      current_step: currentStep,
      completed_steps: completedSteps,
    });
  }

  return { quests };
}
