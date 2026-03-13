/**
 * Admin Edge Function: character_modify
 *
 * Modifies a character's properties including name, ship type, and ship resources.
 * Ship type changes create a new ship and delete the old one (approved decision).
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
  requireString,
  optionalString,
  optionalNumber,
  respondWithError,
} from "../_shared/request.ts";
import { traced } from "../_shared/weave.ts";

interface CharacterModifyPayload {
  name?: string;
  player?: {
    credits?: number;
  };
  ship?: {
    ship_type?: string;
    current_warp_power?: number;
    current_shields?: number;
    current_fighters?: number;
    cargo?: {
      quantum_foam?: number;
      retro_organics?: number;
      neuro_symbolics?: number;
    };
  };
}

interface ShipRow {
  ship_id: string;
  ship_type: string;
  ship_name: string | null;
  current_sector: number;
  credits: number;
  cargo_qf: number;
  cargo_ro: number;
  cargo_ns: number;
  current_warp_power: number;
  current_shields: number;
  current_fighters: number;
}

class CharacterModifyError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "CharacterModifyError";
    this.status = status;
  }
}

Deno.serve(traced("character_modify", async (req, trace) => {
  const supabase = createServiceRoleClient();
  let payload;

  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("character_modify.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  // Validate admin password
  const sAuth = trace.span("validate_admin");
  const adminPassword = optionalString(payload, "admin_password");
  const isValid = await validateAdminSecret(adminPassword);
  sAuth.end({ valid: isValid });
  if (!isValid) {
    await logAdminAction(supabase, {
      action: "character_modify",
      payload,
      result: "error",
      error: "Invalid admin password",
    });
    return errorResponse("Invalid admin password", 403);
  }

  try {
    const characterId = requireString(payload, "character_id");
    const modifyData = payload as CharacterModifyPayload;

    trace.setInput({ characterId, name: modifyData.name, shipType: modifyData.ship?.ship_type });

    // Verify character exists and get current ship
    const sLoadChar = trace.span("load_character", { characterId });
    const { data: character, error: checkError } = await supabase
      .from("characters")
      .select("character_id, name, current_ship_id")
      .eq("character_id", characterId)
      .maybeSingle();

    if (checkError) {
      sLoadChar.end({ error: checkError.message });
      console.error("character_modify.check", checkError);
      throw new CharacterModifyError(
        "Failed to check character existence",
        500,
      );
    }

    if (!character) {
      sLoadChar.end({ error: "not_found" });
      throw new CharacterModifyError("Character not found", 404);
    }

    if (!character.current_ship_id) {
      sLoadChar.end({ error: "no_ship" });
      throw new CharacterModifyError("Character has no ship", 500);
    }
    sLoadChar.end({ found: true });

    // Handle name change if provided
    if (modifyData.name && modifyData.name !== character.name) {
      const sNameChange = trace.span("name_change", { newName: modifyData.name });
      // Check name uniqueness
      const { data: existingName, error: nameCheckError } = await supabase
        .from("characters")
        .select("character_id")
        .eq("name", modifyData.name)
        .maybeSingle();

      if (nameCheckError) {
        sNameChange.end({ error: nameCheckError.message });
        console.error("character_modify.name_check", nameCheckError);
        throw new CharacterModifyError("Failed to check name uniqueness", 500);
      }

      if (existingName) {
        sNameChange.end({ error: "name_taken" });
        throw new CharacterModifyError(
          `Character name "${modifyData.name}" already exists`,
          409,
        );
      }

      // Update name
      const { error: nameUpdateError } = await supabase
        .from("characters")
        .update({ name: modifyData.name })
        .eq("character_id", characterId);

      if (nameUpdateError) {
        sNameChange.end({ error: nameUpdateError.message });
        console.error("character_modify.name_update", nameUpdateError);
        throw new CharacterModifyError("Failed to update character name", 500);
      }
      sNameChange.end({ success: true });
    }

    // Load current ship state
    const sLoadShip = trace.span("load_ship", { shipId: character.current_ship_id });
    const { data: currentShip, error: shipLoadError } = await supabase
      .from("ship_instances")
      .select("*")
      .eq("ship_id", character.current_ship_id)
      .single();

    if (shipLoadError || !currentShip) {
      sLoadShip.end({ error: shipLoadError?.message ?? "not_found" });
      console.error("character_modify.ship_load", shipLoadError);
      throw new CharacterModifyError("Failed to load current ship", 500);
    }
    sLoadShip.end({ found: true });

    const shipRow = currentShip as ShipRow;
    let newShipId = shipRow.ship_id;
    let shipTypeChanged = false;

    // Handle ship type change if provided
    if (
      modifyData.ship?.ship_type &&
      modifyData.ship.ship_type !== shipRow.ship_type
    ) {
      const sShipTypeChange = trace.span("ship_type_change", { newType: modifyData.ship.ship_type });
      const newShipType = modifyData.ship.ship_type;

      // Validate new ship type exists
      const { data: shipDef, error: shipDefError } = await supabase
        .from("ship_definitions")
        .select("ship_type")
        .eq("ship_type", newShipType)
        .maybeSingle();

      if (shipDefError || !shipDef) {
        sShipTypeChange.end({ error: "invalid_ship_type" });
        throw new CharacterModifyError(
          `Invalid ship type: ${newShipType}`,
          400,
        );
      }

      // Create new ship with new type, copying current state
      const { data: newShip, error: newShipError } = await supabase
        .from("ship_instances")
        .insert({
          owner_id: characterId,
          owner_type: "character",
          owner_character_id: characterId,
          ship_type: newShipType,
          ship_name: shipRow.ship_name,
          current_sector: shipRow.current_sector,
          credits: shipRow.credits,
          cargo_qf: shipRow.cargo_qf,
          cargo_ro: shipRow.cargo_ro,
          cargo_ns: shipRow.cargo_ns,
          current_warp_power: shipRow.current_warp_power,
          current_shields: shipRow.current_shields,
          current_fighters: shipRow.current_fighters,
        })
        .select("ship_id")
        .single();

      if (newShipError || !newShip) {
        sShipTypeChange.end({ error: newShipError?.message ?? "insert_failed" });
        console.error("character_modify.new_ship", newShipError);
        throw new CharacterModifyError("Failed to create new ship", 500);
      }

      newShipId = newShip.ship_id;

      // Update character to reference new ship
      const { error: updateCharError } = await supabase
        .from("characters")
        .update({ current_ship_id: newShipId })
        .eq("character_id", characterId);

      if (updateCharError) {
        console.error("character_modify.char_update", updateCharError);
        // Clean up new ship on failure
        await supabase.from("ship_instances").delete().eq("ship_id", newShipId);
        sShipTypeChange.end({ error: updateCharError.message });
        throw new CharacterModifyError(
          "Failed to update character ship reference",
          500,
        );
      }

      // Hard delete old ship (approved decision from plan)
      const { error: deleteOldError } = await supabase
        .from("ship_instances")
        .delete()
        .eq("ship_id", shipRow.ship_id);

      if (deleteOldError) {
        console.error("character_modify.delete_old_ship", deleteOldError);
        // Don't fail the whole operation if old ship deletion fails
        // The new ship is already active
      }

      shipTypeChanged = true;
      sShipTypeChange.end({ newShipId, success: true });
    }

    // Apply ship resource updates if provided
    const shipUpdates: Record<string, unknown> = {};

    if (modifyData.player?.credits !== undefined) {
      shipUpdates.credits = modifyData.player.credits;
    }

    if (modifyData.ship?.current_warp_power !== undefined) {
      shipUpdates.current_warp_power = modifyData.ship.current_warp_power;
    }

    if (modifyData.ship?.current_shields !== undefined) {
      shipUpdates.current_shields = modifyData.ship.current_shields;
    }

    if (modifyData.ship?.current_fighters !== undefined) {
      shipUpdates.current_fighters = modifyData.ship.current_fighters;
    }

    if (modifyData.ship?.cargo?.quantum_foam !== undefined) {
      shipUpdates.cargo_qf = modifyData.ship.cargo.quantum_foam;
    }

    if (modifyData.ship?.cargo?.retro_organics !== undefined) {
      shipUpdates.cargo_ro = modifyData.ship.cargo.retro_organics;
    }

    if (modifyData.ship?.cargo?.neuro_symbolics !== undefined) {
      shipUpdates.cargo_ns = modifyData.ship.cargo.neuro_symbolics;
    }

    if (Object.keys(shipUpdates).length > 0) {
      const sShipUpdate = trace.span("update_ship_resources", { fields: Object.keys(shipUpdates) });
      const { error: updateError } = await supabase
        .from("ship_instances")
        .update(shipUpdates)
        .eq("ship_id", newShipId);

      if (updateError) {
        sShipUpdate.end({ error: updateError.message });
        console.error("character_modify.ship_update", updateError);
        throw new CharacterModifyError("Failed to update ship resources", 500);
      }
      sShipUpdate.end({ success: true });
    }

    // Fetch updated data for response
    const sFetchUpdated = trace.span("fetch_updated_data");
    const { data: updatedChar, error: fetchCharError } = await supabase
      .from("characters")
      .select("character_id, name, current_ship_id")
      .eq("character_id", characterId)
      .single();

    const { data: updatedShip, error: fetchShipError } = await supabase
      .from("ship_instances")
      .select("*")
      .eq("ship_id", newShipId)
      .single();

    if (fetchCharError || fetchShipError || !updatedChar || !updatedShip) {
      sFetchUpdated.end({ error: "fetch_failed" });
      console.error("character_modify.fetch_updated", {
        fetchCharError,
        fetchShipError,
      });
      throw new CharacterModifyError("Failed to fetch updated data", 500);
    }
    sFetchUpdated.end({ success: true });

    const updatedShipRow = updatedShip as ShipRow;

    // Log successful modification
    await logAdminAction(supabase, {
      action: "character_modify",
      admin_user: "admin",
      target_id: characterId,
      payload,
      result: "success",
    });

    trace.setOutput({ character_id: characterId, name: updatedChar.name, ship_type_changed: shipTypeChanged });

    // Return success response
    return successResponse({
      character_id: characterId,
      name: updatedChar.name,
      player: {
        credits: updatedShipRow.credits,
      },
      ship: {
        ship_id: updatedShipRow.ship_id,
        ship_type: updatedShipRow.ship_type,
        ship_name: updatedShipRow.ship_name,
        current_sector: updatedShipRow.current_sector,
        current_warp_power: updatedShipRow.current_warp_power,
        current_shields: updatedShipRow.current_shields,
        current_fighters: updatedShipRow.current_fighters,
        cargo: {
          quantum_foam: updatedShipRow.cargo_qf,
          retro_organics: updatedShipRow.cargo_ro,
          neuro_symbolics: updatedShipRow.cargo_ns,
        },
      },
      ship_type_changed: shipTypeChanged,
    });
  } catch (err) {
    if (err instanceof CharacterModifyError) {
      await logAdminAction(supabase, {
        action: "character_modify",
        payload,
        result: "error",
        error: err.message,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("character_modify.unhandled", err);
    await logAdminAction(supabase, {
      action: "character_modify",
      payload,
      result: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("internal server error", 500);
  }
}));
