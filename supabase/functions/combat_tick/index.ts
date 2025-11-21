import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, successResponse, errorResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { listDueCombats } from '../_shared/combat_state.ts';
import { resolveEncounterRound } from '../_shared/combat_resolution.ts';
import { parseJsonRequest, respondWithError } from '../_shared/request.ts';

const MAX_BATCH = Number(Deno.env.get('COMBAT_TICK_BATCH_SIZE') ?? '20');

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();
  let payload: Record<string, unknown> = {};
  if (req.headers.get('content-length')) {
    try {
      payload = await parseJsonRequest(req);
    } catch (err) {
      const response = respondWithError(err);
      if (response) {
        return response;
      }
      console.error('combat_tick.parse', err);
      return errorResponse('invalid JSON payload', 400);
    }
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }
  const nowIso = new Date().toISOString();

  try {
    const encounters = await listDueCombats(supabase, nowIso, MAX_BATCH);
    let resolved = 0;
    for (const encounter of encounters) {
      try {
        await resolveEncounterRound({
          supabase,
          encounter,
          requestId: `combat.tick:${encounter.combat_id}:${Date.now()}`,
          source: 'combat.tick',
        });
        resolved += 1;
      } catch (err) {
        console.error('combat_tick.resolve_failed', { combat_id: encounter.combat_id, error: err });
      }
    }

    return successResponse({
      status: 'ok',
      checked: encounters.length,
      resolved,
      timestamp: nowIso,
    });
  } catch (err) {
    console.error('combat_tick.error', err);
    return errorResponse('combat tick error', 500);
  }
});
