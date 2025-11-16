/**
 * Admin Edge Function: character_delete
 *
 * Deletes a character and all associated data (ships, garrisons, combat participation).
 * Requires admin password for authorization.
 */

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { validateAdminSecret, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { logAdminAction } from '../_shared/admin_audit.ts';
import {
  parseJsonRequest,
  requireString,
  optionalString,
  respondWithError,
} from '../_shared/request.ts';

class CharacterDeleteError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'CharacterDeleteError';
    this.status = status;
  }
}

serve(async (req: Request): Promise<Response> => {
  const supabase = createServiceRoleClient();
  let payload;

  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error('character_delete.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  // Validate admin password
  const adminPassword = optionalString(payload, 'admin_password');
  const isValid = await validateAdminSecret(adminPassword);
  if (!isValid) {
    await logAdminAction(supabase, {
      action: 'character_delete',
      payload,
      result: 'error',
      error: 'Invalid admin password',
    });
    return errorResponse('Invalid admin password', 403);
  }

  try {
    const characterId = requireString(payload, 'character_id');

    // Check if character exists
    const { data: character, error: checkError } = await supabase
      .from('characters')
      .select('character_id, name')
      .eq('character_id', characterId)
      .maybeSingle();

    if (checkError) {
      console.error('character_delete.check', checkError);
      throw new CharacterDeleteError('Failed to check character existence', 500);
    }

    if (!character) {
      throw new CharacterDeleteError('Character not found', 404);
    }

    // Call the stored procedure to delete character and cascade
    const { data: deleteResult, error: deleteError } = await supabase
      .rpc('delete_character_cascade', { char_id: characterId });

    if (deleteError) {
      console.error('character_delete.cascade', deleteError);
      throw new CharacterDeleteError('Failed to delete character', 500);
    }

    // Extract counts from stored procedure result
    const shipsDeleted = deleteResult?.ships_deleted ?? 0;
    const garrisonsDeleted = deleteResult?.garrisons_deleted ?? 0;

    // Additional cleanup: Remove from corporations if member
    const { data: membership, error: membershipError } = await supabase
      .from('corporation_members')
      .select('corporation_id')
      .eq('character_id', characterId)
      .maybeSingle();

    if (!membershipError && membership) {
      const corporationId = membership.corporation_id;

      // Remove from corporation
      await supabase
        .from('corporation_members')
        .delete()
        .eq('character_id', characterId);

      // Check if this was the last member
      const { data: remainingMembers, error: countError } = await supabase
        .from('corporation_members')
        .select('character_id')
        .eq('corporation_id', corporationId);

      if (!countError && remainingMembers && remainingMembers.length === 0) {
        // Delete the empty corporation
        await supabase
          .from('corporations')
          .delete()
          .eq('corporation_id', corporationId);
      }
    }

    // Log successful deletion
    await logAdminAction(supabase, {
      action: 'character_delete',
      admin_user: 'admin',
      target_id: characterId,
      payload,
      result: 'success',
    });

    // Return success response
    return successResponse({
      character_id: characterId,
      deleted: true,
      ships_deleted: shipsDeleted,
      garrisons_deleted: garrisonsDeleted,
    });
  } catch (err) {
    if (err instanceof CharacterDeleteError) {
      await logAdminAction(supabase, {
        action: 'character_delete',
        payload,
        result: 'error',
        error: err.message,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('character_delete.unhandled', err);
    await logAdminAction(supabase, {
      action: 'character_delete',
      payload,
      result: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('internal server error', 500);
  }
});
