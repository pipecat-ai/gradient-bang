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

    if (eventType === 'start' && taskDescription) {
      eventPayload.task_description = taskDescription;
    }

    if (eventType === 'finish' && taskSummary) {
      eventPayload.task_summary = taskSummary;
    }

    // Emit the task lifecycle event
    await emitCharacterEvent({
      supabase,
      characterId,
      eventType: eventName,
      payload: eventPayload,
      senderId: characterId,
      requestId,
      taskId,
      recipientReason: 'task_owner',
      scope: 'self',
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
