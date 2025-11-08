import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { logEvent } from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';

console.log('join module loaded; EDGE_API_TOKEN present?', Boolean(Deno.env.get('EDGE_API_TOKEN')));

serve(async (req: Request): Promise<Response> => {
  console.log('join env token present', Boolean(Deno.env.get('EDGE_API_TOKEN')));
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  const supabase = createServiceRoleClient();

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({
      status: 'ok',
      token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')),
    });
  }

  const characterId = typeof payload.character_id === 'string' ? payload.character_id : null;
  if (!characterId) {
    return errorResponse('character_id is required', 400);
  }

  const { data: character, error: characterError } = await supabase
    .from('characters')
    .select('character_id,name,current_ship_id,map_knowledge,credits_in_megabank,last_active')
    .eq('character_id', characterId)
    .maybeSingle();

  if (characterError) {
    console.error('failed to load character', characterError);
    return errorResponse('failed to load character', 500);
  }

  if (!character) {
    return errorResponse('character not found', 404);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'join');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResponse('Too many join requests', 429);
    }
    console.error('rate limit check failed', err);
    return errorResponse('rate limit error', 500);
  }

  let ship: Record<string, unknown> | null = null;
  if (character.current_ship_id) {
    const { data: shipData, error: shipError } = await supabase
      .from('ship_instances')
      .select('*')
      .eq('ship_id', character.current_ship_id)
      .maybeSingle();

    if (shipError) {
      console.error('failed to load ship', shipError);
      return errorResponse('failed to load ship', 500);
    }
    ship = shipData;
  }

  try {
    await logEvent(supabase, {
      direction: 'event_out',
      event_type: 'session.join',
      character_id: characterId,
      payload: {
        character_id: characterId,
        ship_id: character.current_ship_id,
      },
    });
  } catch (err) {
    console.error('failed to log join event', err);
  }

  return successResponse({
    character,
    ship,
    message: 'Edge function scaffold for join completed',
  });
});
