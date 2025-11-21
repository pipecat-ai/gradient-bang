import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

import { validateApiToken, unauthorizedResponse, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import {
  buildEventSource,
  recordEventWithRecipients,
} from '../_shared/events.ts';
import { enforceRateLimit, RateLimitError } from '../_shared/rate_limiting.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  optionalBoolean,
  resolveRequestId,
  respondWithError,
} from '../_shared/request.ts';
import { loadCharacter } from '../_shared/status.ts';
import { ensureActorAuthorization, ActorAuthorizationError } from '../_shared/actors.ts';
import type { EventRecipientSnapshot } from '../_shared/visibility.ts';

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
    console.error('send_message.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  if (payload.healthcheck === true) {
    return successResponse({ status: 'ok', token_present: Boolean(Deno.env.get('EDGE_API_TOKEN')) });
  }

  const requestId = resolveRequestId(payload);
  const characterId = requireString(payload, 'character_id');
  const msgType = optionalString(payload, 'type') ?? 'broadcast';
  const content = optionalString(payload, 'content') ?? '';
  const toName = optionalString(payload, 'to_name');
  const actorCharacterId = optionalString(payload, 'actor_character_id');
  const adminOverride = optionalBoolean(payload, 'admin_override') ?? false;

  // Validate message type
  if (!['broadcast', 'direct'].includes(msgType)) {
    return errorResponse('Invalid message type (must be broadcast or direct)', 400);
  }

  // Validate content
  if (!content || content.trim().length === 0) {
    return errorResponse('Empty content', 400);
  }
  if (content.length > 512) {
    return errorResponse('Content too long (max 512)', 400);
  }

  // Validate direct message requirements
  if (msgType === 'direct' && !toName) {
    return errorResponse('Missing to_name for direct message', 400);
  }

  try {
    await enforceRateLimit(supabase, characterId, 'send_message');
  } catch (err) {
    if (err instanceof RateLimitError) {
      return errorResponse('Too many requests', 429);
    }
    console.error('send_message.rate_limit', err);
    return errorResponse('rate limit error', 500);
  }

  try {
    return await handleSendMessage({
      supabase,
      requestId,
      characterId,
      msgType,
      content,
      toName,
      actorCharacterId,
      adminOverride,
    });
  } catch (err) {
    if (err instanceof ActorAuthorizationError) {
      return errorResponse(err.message, err.status);
    }
    console.error('send_message.error', err);
    const status = err instanceof Error && 'status' in err ? Number((err as Error & { status?: number }).status) : 500;
    const detail = err instanceof Error ? err.message : 'send message failed';
    return errorResponse(detail, status);
  }
});

async function handleSendMessage(params: {
  supabase: ReturnType<typeof createServiceRoleClient>;
  requestId: string;
  characterId: string;
  msgType: string;
  content: string;
  toName: string | null;
  actorCharacterId: string | null;
  adminOverride: boolean;
}): Promise<Response> {
  const {
    supabase,
    requestId,
    characterId,
    msgType,
    content,
    toName,
    actorCharacterId,
    adminOverride,
  } = params;

  // Load sender character and ship for actor authorization
  const sender = await loadCharacter(supabase, characterId);

  // Load ship for corporation ship authorization
  let ship = null;
  if (sender.current_ship_id) {
    const { data: shipData } = await supabase
      .from('ship_instances')
      .select('*')
      .eq('ship_id', sender.current_ship_id)
      .maybeSingle();
    ship = shipData;
  }

  await ensureActorAuthorization({
    supabase,
    ship,
    actorCharacterId,
    adminOverride,
    targetCharacterId: characterId,
  });

  // Look up sender's display name
  const senderName = sender.name;

  // For direct messages, look up recipient's character ID from display name
  let toCharacterId: string | null = null;
  if (msgType === 'direct' && toName) {
    const { data: recipientData, error: recipientError } = await supabase
      .from('characters')
      .select('character_id')
      .eq('name', toName)
      .maybeSingle();

    if (recipientError) {
      console.error('send_message.recipient_lookup', recipientError);
      const err = new Error('Failed to look up recipient') as Error & { status?: number };
      err.status = 500;
      throw err;
    }

    if (!recipientData) {
      const err = new Error(`Character '${toName}' not found`) as Error & { status?: number };
      err.status = 404;
      throw err;
    }

    toCharacterId = recipientData.character_id;
  }

  // Build message record (mimicking legacy MessageStore.append)
  const timestamp = new Date().toISOString();
  const messageId = `${Date.now()}-${characterId.substring(0, 8)}`;

  // Public message record (excludes internal character IDs)
  const publicRecord = {
    id: messageId,
    from_name: senderName,
    type: msgType,
    content,
    to_name: msgType === 'direct' ? toName : null,
    timestamp,
  };

  // Determine recipients for event filtering
  let recipients: EventRecipientSnapshot[] = [];
  let scope: 'broadcast' | 'direct' = 'broadcast';

  if (msgType === 'direct' && toCharacterId) {
    // Direct message: only sender and recipient
    recipients = [
      { characterId, reason: 'sender' },
      { characterId: toCharacterId, reason: 'recipient' },
    ];
    scope = 'direct';
  }
  // For broadcast, recipients array stays empty but broadcast flag is set below

  // Emit chat.message event
  await recordEventWithRecipients({
    supabase,
    eventType: 'chat.message',
    scope,
    payload: publicRecord,
    requestId,
    senderId: characterId,
    actorCharacterId: characterId,
    recipients,
    broadcast: msgType === 'broadcast',
  });

  return successResponse({ id: messageId });
}
