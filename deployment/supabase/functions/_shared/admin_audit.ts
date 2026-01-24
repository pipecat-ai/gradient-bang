/**
 * Admin Audit Logging
 *
 * Helper functions for logging all admin operations to the admin_actions table.
 */

import { SupabaseClient } from "@supabase/supabase-js";

export interface AdminActionLog {
  action: string;
  admin_user?: string;
  target_id?: string;
  payload?: any;
  result: "success" | "error";
  error?: string;
}

/**
 * Log an admin action to the admin_actions audit table.
 *
 * @param supabase Supabase client
 * @param log Admin action details
 */
export async function logAdminAction(
  supabase: SupabaseClient,
  log: AdminActionLog,
): Promise<void> {
  try {
    const { error } = await supabase.from("admin_actions").insert({
      action: log.action,
      admin_user: log.admin_user || "admin",
      target_id: log.target_id,
      payload: log.payload,
      result: log.result,
      error: log.error,
    });

    if (error) {
      console.error("admin_audit.log_failed", {
        action: log.action,
        error: error.message,
      });
    }
  } catch (err) {
    // Don't fail the request if audit logging fails
    console.error("admin_audit.log_exception", {
      action: log.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Wrapper function to execute an admin operation and log the result.
 *
 * @param supabase Supabase client
 * @param action Admin action name
 * @param operation Function to execute
 * @param payload Request payload (for audit trail)
 * @returns Operation result
 */
export async function withAdminAudit<T>(
  supabase: SupabaseClient,
  action: string,
  operation: () => Promise<T>,
  payload?: any,
): Promise<T> {
  try {
    const result = await operation();

    // Log success
    await logAdminAction(supabase, {
      action,
      payload,
      result: "success",
      target_id: (result as any)?.character_id || (result as any)?.id,
    });

    return result;
  } catch (error) {
    // Log failure
    await logAdminAction(supabase, {
      action,
      payload,
      result: "error",
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}
