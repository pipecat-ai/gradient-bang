/**
 * Edge Function: quest_assign
 *
 * Assigns a quest to a character by quest code. Calls the assign_quest()
 * SQL function, then triggers a quest.status event so the client receives
 * the updated quest list.
 */

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

Deno.serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("quest_assign.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: "ok" });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, "character_id");
    const questCode = requireString(payload, "quest_code");

    // Assign the quest via the SQL function
    const { data: playerQuestId, error: rpcError } = await supabase.rpc(
      "assign_quest",
      {
        p_player_id: characterId,
        p_quest_code: questCode,
      },
    );

    if (rpcError) {
      console.error("quest_assign.rpc", rpcError);
      return errorResponse("Failed to assign quest", 500);
    }

    if (!playerQuestId) {
      // Already assigned or quest not found
      return successResponse({
        request_id: requestId,
        assigned: false,
        reason: "Quest already assigned or not found",
      });
    }

    // Trigger a quest.status event so the client gets the updated list
    const source = buildEventSource("quest_assign", requestId);

    // Fetch and emit the full quest status
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
      console.error("quest_assign.status_fetch", pqError);
      // Assignment succeeded but status fetch failed — still report success
      return successResponse({
        request_id: requestId,
        assigned: true,
        player_quest_id: playerQuestId,
      });
    }

    const playerQuestIds = (playerQuests ?? []).map((pq) => pq.id);

    const { data: playerSteps } = await supabase
      .from("player_quest_steps")
      .select(
        `
        player_quest_id,
        step_id,
        current_value,
        completed_at,
        quest_step_definitions (
          step_index,
          name,
          description,
          target_value,
          meta
        )
      `,
      )
      .in("player_quest_id", playerQuestIds);

    // Group steps by player_quest_id
    type StepRow = (typeof playerSteps extends (infer T)[] | null ? T : never);
    const stepsByQuest = new Map<string, StepRow[]>();
    for (const step of playerSteps ?? []) {
      const existing = stepsByQuest.get(step.player_quest_id) ?? [];
      existing.push(step);
      stepsByQuest.set(step.player_quest_id, existing);
    }

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

    const quests: QuestInfo[] = [];

    for (const pq of playerQuests ?? []) {
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

    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: "quest.status",
      payload: { source, quests },
      requestId,
    });

    return successResponse({
      request_id: requestId,
      assigned: true,
      player_quest_id: playerQuestId,
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error("quest_assign.unhandled", err);
    return errorResponse("internal server error", 500);
  }
});
