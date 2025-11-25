/**
 * Admin Edge Function: regenerate_ports
 *
 * Regenerates port stock by a fraction of max capacity.
 * Sell ports gain stock, buy ports lose stock (gain buying capacity).
 * Requires admin password for authorization.
 */

import { serve } from 'https://deno.land/std@0.197.0/http/server.ts';
import { validateAdminSecret, errorResponse, successResponse } from '../_shared/auth.ts';
import { createServiceRoleClient } from '../_shared/client.ts';
import { logAdminAction } from '../_shared/admin_audit.ts';
import {
  parseJsonRequest,
  optionalString,
  optionalNumber,
  respondWithError,
} from '../_shared/request.ts';

const DEFAULT_FRACTION = 0.25;

class RegeneratePortsError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'RegeneratePortsError';
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
    console.error('regenerate_ports.parse', err);
    return errorResponse('invalid JSON payload', 400);
  }

  // Validate admin password
  const adminPassword = optionalString(payload, 'admin_password');
  const isValid = await validateAdminSecret(adminPassword);
  if (!isValid) {
    await logAdminAction(supabase, {
      action: 'regenerate_ports',
      payload,
      result: 'error',
      error: 'Invalid admin password',
    });
    return errorResponse('Invalid admin password', 403);
  }

  try {
    // Get fraction parameter (default 0.25)
    const fraction = optionalNumber(payload, 'fraction') ?? DEFAULT_FRACTION;

    // Validate fraction range
    if (fraction < 0.0 || fraction > 1.0) {
      throw new RegeneratePortsError(
        'Fraction must be between 0.0 and 1.0',
        400
      );
    }

    // Call the stored procedure to regenerate ports
    const { data: portsRegenerated, error: regenError } = await supabase
      .rpc('regenerate_ports', { fraction });

    if (regenError) {
      console.error('regenerate_ports.rpc', regenError);
      throw new RegeneratePortsError(
        `Failed to regenerate ports: ${regenError.message}`,
        500
      );
    }

    const portsRegeneratedCount = typeof portsRegenerated === 'number' ? portsRegenerated : 0;
    const fractionPercent = (fraction * 100).toFixed(1);

    // Log successful regeneration
    await logAdminAction(supabase, {
      action: 'regenerate_ports',
      admin_user: 'admin',
      payload,
      result: 'success',
    });

    // Return success response
    return successResponse({
      message: `Regenerated ${portsRegeneratedCount} ports with ${fractionPercent}% of max capacity`,
      ports_regenerated: portsRegeneratedCount,
      fraction,
    });
  } catch (err) {
    if (err instanceof RegeneratePortsError) {
      await logAdminAction(supabase, {
        action: 'regenerate_ports',
        payload,
        result: 'error',
        error: err.message,
      });
      return errorResponse(err.message, err.status);
    }
    console.error('regenerate_ports.unhandled', err);
    await logAdminAction(supabase, {
      action: 'regenerate_ports',
      payload,
      result: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('internal server error', 500);
  }
});
