import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { buildEventSource, emitCharacterEvent } from '../_shared/events.ts';
import { parseJsonRequest, requireString, resolveRequestId, respondWithError } from '../_shared/request.ts';
import { computeCorpMemberRecipients } from '../_shared/visibility.ts';

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown>;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) return response;
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, 'character_id');
    const taskId = requireString(payload, 'task_id');

    let query = supabase
      .from('events')
      .select('id, character_id, actor_character_id, task_id, task_id_prefix')
      .eq('event_type', 'task.start')
      .order('timestamp', { ascending: false });

    const isShortId = taskId.length <= 12;
    if (isShortId) {
      query = query.ilike('task_id_prefix', `${taskId}%`);
    } else {
      query = query.eq('task_id', taskId);
    }

    const { data: taskStartEvents, error: queryError } = await query.limit(isShortId ? 2 : 1);

    if (queryError) {
      console.error('task_cancel.query_error', queryError);
      return errorResponse('Failed to validate task ownership', 500);
    }

    if (!taskStartEvents || taskStartEvents.length === 0) {
      return errorResponse(`Task ${taskId} not found`, 404);
    }

    if (isShortId && taskStartEvents.length > 1) {
      console.warn('task_cancel.short_id_ambiguous_latest_wins', {
        task_id_prefix: taskId,
        match_count: taskStartEvents.length,
      });
    }

    const taskRow = taskStartEvents[0];
    const taskOwnerCharacterId = taskRow.character_id as string | null;
    const actorCharacterId = taskRow.actor_character_id as string | null;
    const fullTaskId = taskRow.task_id as string | null;

    if (!taskOwnerCharacterId || !fullTaskId) {
      return errorResponse('Invalid task metadata', 500);
    }

    // Determine if this is a corp ship task by checking ship_instances.
    let taskCorpId: string | null = null;
    const { data: shipData, error: shipError } = await supabase
      .from('ship_instances')
      .select('owner_type, owner_corporation_id')
      .eq('ship_id', taskOwnerCharacterId)
      .maybeSingle();

    if (shipError) {
      console.error('task_cancel.ship_lookup_error', shipError);
      return errorResponse('Failed to validate task ownership', 500);
    }

    if (shipData?.owner_type === 'corporation') {
      taskCorpId = shipData.owner_corporation_id ?? null;
    }

    // Resolve requester corporation
    const { data: membership } = await supabase
      .from('corporation_members')
      .select('corp_id')
      .eq('character_id', characterId)
      .is('left_at', null)
      .maybeSingle();

    const requesterCorpId = membership?.corp_id ?? null;

    const isRequesterOwner = characterId === taskOwnerCharacterId;
    const isRequesterActor = actorCharacterId ? characterId === actorCharacterId : false;
    const isCorpShipTask = Boolean(taskCorpId);
    const isSameCorp = Boolean(taskCorpId && requesterCorpId && taskCorpId === requesterCorpId);

    // Authorization rules:
    // - Task owner or actor can cancel their own tasks
    // - Any corp member can cancel corp ship tasks
    if (!(isRequesterOwner || isRequesterActor || (isCorpShipTask && isSameCorp))) {
      return errorResponse('You do not have permission to cancel this task', 403);
    }

    let additionalRecipients: { characterId: string; reason: string }[] = [];
    if (taskCorpId) {
      additionalRecipients = await computeCorpMemberRecipients(
        supabase,
        [taskCorpId],
        [characterId, taskOwnerCharacterId],
      );
    }

    await emitCharacterEvent({
      supabase,
      characterId: taskOwnerCharacterId,
      eventType: 'task.cancel',
      payload: {
        source: buildEventSource('task_cancel', requestId),
        task_id: fullTaskId,
        cancelled_by: characterId,
      },
      senderId: characterId,
      actorCharacterId: characterId,
      requestId,
      taskId: fullTaskId,
      recipientReason: 'task_owner',
      scope: 'self',
      corpId: taskCorpId ?? undefined,
      additionalRecipients,
    });

    return successResponse({
      request_id: requestId,
      task_id: fullTaskId,
      message: 'Cancel event emitted',
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) return validationResponse;
    console.error('task_cancel.error', err);
    return errorResponse(err instanceof Error ? err.message : 'task cancel failed', 500);
  }
});
