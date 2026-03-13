/**
 * Admin Edge Function: reset_ports
 *
 * Resets all ports to their initial state from universe_config.
 * Requires admin password for authorization.
 */

import { serve } from "https://deno.land/std@0.197.0/http/server.ts";
import {
  validateAdminSecret,
  errorResponse,
  successResponse,
} from "../_shared/auth.ts";
import { createServiceRoleClient } from "../_shared/client.ts";
import { logAdminAction } from "../_shared/admin_audit.ts";
import {
  parseJsonRequest,
  optionalString,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

class ResetPortsError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "ResetPortsError";
    this.status = status;
  }
}

Deno.serve(traced("reset_ports", async (req, trace) => {
  const supabase = createServiceRoleClient();
  let payload;

  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("reset_ports.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  // Validate admin password
  const adminPassword = optionalString(payload, "admin_password");
  const isValid = await validateAdminSecret(adminPassword);
  if (!isValid) {
    await logAdminAction(supabase, {
      action: "reset_ports",
      payload,
      result: "error",
      error: "Invalid admin password",
    });
    return errorResponse("Invalid admin password", 403);
  }

  trace.setInput({ action: "reset_ports" });

  try {
    // Call the stored procedure to reset all ports
    const sRpc = trace.span("reset_all_ports_rpc");
    const { data: portsReset, error: resetError } =
      await supabase.rpc("reset_all_ports");
    sRpc.end();

    if (resetError) {
      console.error("reset_ports.rpc", resetError);
      throw new ResetPortsError(
        `Failed to reset ports: ${resetError.message}`,
        500,
      );
    }

    const portsResetCount = typeof portsReset === "number" ? portsReset : 0;

    // Log successful reset
    await logAdminAction(supabase, {
      action: "reset_ports",
      admin_user: "admin",
      payload,
      result: "success",
    });

    trace.setOutput({ ports_reset: portsResetCount });

    // Return success response
    return successResponse({
      message: `Reset ${portsResetCount} ports to initial state`,
      ports_reset: portsResetCount,
    });
  } catch (err) {
    if (err instanceof ResetPortsError) {
      await logAdminAction(supabase, {
        action: "reset_ports",
        payload,
        result: "error",
        error: err.message,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("reset_ports.unhandled", err);
    await logAdminAction(supabase, {
      action: "reset_ports",
      payload,
      result: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("internal server error", 500);
  }
}));
