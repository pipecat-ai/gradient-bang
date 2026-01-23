import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import {
  buildEventSource,
  emitCharacterEvent,
} from '../_shared/events.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { computeCorpMemberRecipients } from '../_shared/visibility.ts';

/**
 * Task lifecycle event emitter.
 *
 * This edge function emits task.start and task.finish events for TaskAgent executions.
 * These events enable querying historical tasks and their associated events.
 *
 * Events emitted:
 * - task.start: When a task begins, includes task description
 * - task.finish: When a task completes, includes summary/result
 */
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
    if (response) {
      return response;
    }
    console.error('task_lifecycle.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);

  try {
    const characterId = requireString(payload, 'character_id');
    const taskId = requireString(payload, 'task_id');
    const eventType = requireString(payload, 'event_type');
    const taskDescription = optionalString(payload, 'task_description');
    const taskSummary = optionalString(payload, 'task_summary');
    const taskStatusRaw = optionalString(payload, 'task_status');
    const actorCharacterIdRaw = optionalString(payload, 'actor_character_id');
    const actorCharacterNameRaw = optionalString(payload, 'actor_character_name');
    const taskScopeRaw = optionalString(payload, 'task_scope');
    const shipIdRaw = optionalString(payload, 'ship_id');
    const shipNameRaw = optionalString(payload, 'ship_name');
    const shipTypeRaw = optionalString(payload, 'ship_type');

    // Validate event_type
    if (!['start', 'finish'].includes(eventType)) {
      return errorResponse("event_type must be 'start' or 'finish'", 400);
    }

    const eventName = eventType === 'start' ? 'task.start' : 'task.finish';

    // Build event payload
    const eventPayload: Record<string, unknown> = {
      source: buildEventSource('task_lifecycle', requestId),
      task_id: taskId,
      event_type: eventType,
    };

    const actorCharacterId = actorCharacterIdRaw ?? characterId;
    eventPayload.actor_character_id = actorCharacterId;

    if (actorCharacterNameRaw) {
      eventPayload.actor_character_name = actorCharacterNameRaw;
    } else {
      // Load actor name (best-effort)
      const { data: actorRow } = await supabase
        .from('characters')
        .select('name')
        .eq('character_id', actorCharacterId)
        .maybeSingle();
      if (actorRow?.name) {
        eventPayload.actor_character_name = actorRow.name;
      }
    }

    // Determine ship + task scope metadata
    let shipId: string | null = shipIdRaw ?? null;
    let shipName: string | null = shipNameRaw ?? null;
    let shipType: string | null = shipTypeRaw ?? null;
    let taskScope: 'player_ship' | 'corp_ship' = taskScopeRaw === 'corp_ship' ? 'corp_ship' : 'player_ship';
    let shipOwnerCorpId: string | null = null;

    // If characterId is a ship_id (corp ship control), this returns a row
    const needsShipLookup = !shipName || !shipType || taskScope === 'corp_ship' || !shipId;
    if (needsShipLookup) {
      // If characterId is a ship_id (corp ship control), this returns a row
      const { data: directShipRow } = await supabase
        .from('ship_instances')
        .select('ship_id, ship_name, ship_type, owner_type, owner_corporation_id')
        .eq('ship_id', characterId)
        .maybeSingle();

      if (directShipRow) {
        shipId = shipId ?? directShipRow.ship_id ?? null;
        shipName = shipName ?? directShipRow.ship_name ?? null;
        shipType = shipType ?? directShipRow.ship_type ?? null;
        if (directShipRow.owner_type === 'corporation') {
          taskScope = 'corp_ship';
          shipOwnerCorpId = directShipRow.owner_corporation_id ?? null;
        }
      } else if (!shipId) {
        // Otherwise, this is a personal task; resolve current_ship_id
        const { data: characterRow } = await supabase
          .from('characters')
          .select('current_ship_id')
          .eq('character_id', characterId)
          .maybeSingle();
        shipId = (characterRow?.current_ship_id as string | null) ?? null;
      }

      if (shipId && (!shipName || !shipType || taskScope === 'corp_ship')) {
        const { data: shipRow } = await supabase
          .from('ship_instances')
          .select('ship_id, ship_name, ship_type, owner_type, owner_corporation_id')
          .eq('ship_id', shipId)
          .maybeSingle();
        if (shipRow) {
          shipName = shipName ?? shipRow.ship_name ?? null;
          shipType = shipType ?? shipRow.ship_type ?? null;
          if (shipRow.owner_type === 'corporation') {
            taskScope = 'corp_ship';
            shipOwnerCorpId = shipRow.owner_corporation_id ?? null;
          }
        }
      }
    }

    eventPayload.task_scope = taskScope;
    if (shipId) eventPayload.ship_id = shipId;
    if (shipName) eventPayload.ship_name = shipName;
    if (shipType) eventPayload.ship_type = shipType;

    if (eventType === 'start' && taskDescription) {
      eventPayload.task_description = taskDescription;
    }

    if (eventType === 'finish') {
      const taskStatus = taskStatusRaw ?? 'completed';
      eventPayload.task_status = taskStatus;
      if (taskSummary) {
        eventPayload.task_summary = taskSummary;
      }
    }

    // Server-side corp lookup for visibility
    // First check corp membership
    const { data: membership } = await supabase
      .from('corporation_members')
      .select('corp_id')
      .eq('character_id', characterId)
      .is('left_at', null)
      .maybeSingle();

    let effectiveCorpId: string | null = membership?.corp_id ?? null;

    // Also check if this is a corp ship (for corp ships, character_id == ship_id)
    // Query ship_instances directly - simpler and avoids timing issues if pseudo-character is deleted
    if (!effectiveCorpId) {
      const { data: shipData } = await supabase
        .from('ship_instances')
        .select('owner_type, owner_corporation_id')
        .eq('ship_id', characterId)
        .maybeSingle();

      if (shipData?.owner_type === 'corporation') {
        effectiveCorpId = shipData.owner_corporation_id ?? null;
      }
    }

    if (!effectiveCorpId && shipOwnerCorpId) {
      effectiveCorpId = shipOwnerCorpId;
    }

    // Get corp member recipients if in a corp
    let additionalRecipients: { characterId: string; reason: string }[] = [];
    if (effectiveCorpId) {
      additionalRecipients = await computeCorpMemberRecipients(
        supabase,
        [effectiveCorpId],
        [characterId], // exclude the acting character
      );
    }

    // Emit the task lifecycle event
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: eventName,
      payload: eventPayload,
      senderId: characterId,
      actorCharacterId: actorCharacterId ?? undefined,
      requestId,
      taskId,
      shipId: shipId ?? undefined,
      recipientReason: 'task_owner',
      scope: 'self',
      additionalRecipients, // Corp members added here
    });

    return successResponse({
      request_id: requestId,
      task_id: taskId,
      event_type: eventType,
    });
  } catch (err) {
    const validationResponse = respondWithError(err);
    if (validationResponse) {
      return validationResponse;
    }
    console.error('task_lifecycle.error', err);
    const detail = err instanceof Error ? err.message : 'task lifecycle event failed';
    return errorResponse(detail, 500);
  }
});
