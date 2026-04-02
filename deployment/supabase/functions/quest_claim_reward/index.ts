/**
 * Edge Function: quest_claim_reward
 *
 * Claims a step reward for a completed quest step. Validates ownership,
 * step completion, and idempotency, then grants credits to the player's
 * active ship via the claim_quest_step_reward() SQL function.
 */

import {
  validateApiToken,
  unauthorizedResponse,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import {
  parseJsonRequest,
  requireString,
  resolveRequestId,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

Deno.serve(traced("quest_claim_reward", async (req, trace) => {
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
    console.error("quest_claim_reward.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: "ok" });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, "character_id");
    const questId = requireString(payload, "quest_id");
    const stepId = requireString(payload, "step_id");

    trace.setInput({ characterId, questId, stepId, requestId });

    const sClaim = trace.span("claim_quest_step_reward_rpc");
    const { data, error: rpcError } = await supabase.rpc(
      "claim_quest_step_reward",
      {
        p_player_id: characterId,
        p_quest_id: questId,
        p_step_id: stepId,
      },
    );
    sClaim.end();

    if (rpcError) {
      console.error("quest_claim_reward.rpc", rpcError);
      return errorResponse("Failed to claim reward", 500);
    }

    const result = data as Record<string, unknown>;
    trace.setOutput({ request_id: requestId, ...result });

    return successResponse({ request_id: requestId, ...result });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error("quest_claim_reward.unhandled", err);
    return errorResponse("internal server error", 500);
  }
}));
