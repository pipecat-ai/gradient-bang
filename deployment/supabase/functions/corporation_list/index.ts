import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, successResponse, errorResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  optionalString,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';

class CorporationListError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CorporationListError';
    this.status = status;
  }
}

serve(async (req: Request): Promise<Response> => {
  if (!validateApiToken(req)) {
    return unauthorizedResponse();
  }

  let payload;
  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('corporation_list.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const supabase = createServiceRoleClient();
  const requestId = resolveRequestId(payload);
  const characterId = optionalString(payload, 'character_id');

  if (characterId) {
    try {
      await enforceRateLimit(supabase, characterId, 'corporation_list');
    } catch (err) {
      if (err instanceof RateLimitError) {
        return errorResponse('Too many corporation requests', 429);
      }
      console.error('corporation_list.rate_limit', err);
      return errorResponse('rate limit error', 500);
    }
  }

  try {
    const corporations = await loadCorporationSummaries(supabase);
    return successResponse({ corporations, request_id: requestId });
  } catch (err) {
    if (err instanceof CorporationListError) {
      return errorResponse(err.message, err.status);
    }
    console.error('corporation_list.unhandled', err);
    return errorResponse('internal server error', 500);
  }
});

async function loadCorporationSummaries(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<Array<Record<string, unknown>>> {
  const { data: corps, error } = await supabase
    .from('corporations')
    .select('corp_id, name, founded');
  if (error) {
    console.error('corporation_list.corporations', error);
    throw new CorporationListError('Failed to load corporations', 500);
  }

  const { data: memberships, error: memberError } = await supabase
    .from('corporation_members')
    .select('corp_id, left_at')
    .is('left_at', null);
  if (memberError) {
    console.error('corporation_list.memberships', memberError);
    throw new CorporationListError('Failed to load corporation memberships', 500);
  }

  const counts = new Map<string, number>();
  for (const row of memberships ?? []) {
    if (row?.corp_id) {
      counts.set(row.corp_id, (counts.get(row.corp_id) ?? 0) + 1);
    }
  }

  const summaries = (corps ?? [])
    .filter((corp): corp is { corp_id: string; name: string; founded: string } => typeof corp?.corp_id === 'string')
    .map((corp) => ({
      corp_id: corp.corp_id,
      name: corp.name,
      founded: corp.founded,
      member_count: counts.get(corp.corp_id) ?? 0,
    }));

  summaries.sort((a, b) => {
    const diff = (b.member_count as number) - (a.member_count as number);
    if (diff !== 0) {
      return diff;
    }
    const left = typeof a.name === 'string' ? a.name : '';
    const right = typeof b.name === 'string' ? b.name : '';
    return left.localeCompare(right);
  });

  return summaries;
}
