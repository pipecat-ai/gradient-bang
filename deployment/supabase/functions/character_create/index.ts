/**
 * Admin Edge Function: character_create
 *
 * Creates a new character with custom ship and resource configuration.
 * Requires admin password for authorization.
 */

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
  RequestValidationError,
} from "../_shared/request.ts";
import {
  loadUniverseMeta,
  pickRandomFedspaceSector,
} from "../_shared/fedspace.ts";

const DEFAULT_START_SECTOR = 0;
const DEFAULT_SHIP_TYPE = "kestrel_courier";
const DEFAULT_CREDITS = 5000;
const DEFAULT_PLAYER_TYPE = "human";

interface ShipDefinitionRow {
  ship_type: string;
  warp_power_capacity: number;
  shields: number;
  fighters: number;
}

interface CharacterCreatePayload {
  name: string;
  player?: {
    credits?: number;
    player_type?: string;
  };
  ship?: {
    ship_type?: string;
    ship_name?: string;
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

class CharacterCreateError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "CharacterCreateError";
    this.status = status;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const supabase = createServiceRoleClient();
  let payload;

  try {
    payload = await parseJsonRequest(req);
  } catch (err) {
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("character_create.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  // Validate admin password
  const adminPassword = optionalString(payload, "admin_password");
  const isValid = await validateAdminSecret(adminPassword);
  if (!isValid) {
    await logAdminAction(supabase, {
      action: "character_create",
      payload,
      result: "error",
      error: "Invalid admin password",
    });
    return errorResponse("Invalid admin password", 403);
  }

  try {
    // Parse and validate request
    const name = requireString(payload, "name");
    const playerData =
      (payload.player as CharacterCreatePayload["player"]) ?? {};
    const shipData = (payload.ship as CharacterCreatePayload["ship"]) ?? {};

    // Extract player settings
    const credits = playerData.credits ?? DEFAULT_CREDITS;
    const playerType = playerData.player_type ?? DEFAULT_PLAYER_TYPE;

    // Extract ship settings
    const shipType = shipData.ship_type ?? DEFAULT_SHIP_TYPE;
    const shipNameRaw = shipData.ship_name;
    const shipNameTrimmed =
      typeof shipNameRaw === "string" ? shipNameRaw.trim() : "";
    const shipName = shipNameTrimmed ? shipNameTrimmed : null;
    const cargo = shipData.cargo ?? {};
    const cargoQf = cargo.quantum_foam ?? 0;
    const cargoRo = cargo.retro_organics ?? 0;
    const cargoNs = cargo.neuro_symbolics ?? 0;

    // Validate ship type exists
    const shipDefinition = await loadShipDefinition(supabase, shipType);
    if (!shipDefinition) {
      throw new CharacterCreateError(`Invalid ship type: ${shipType}`, 400);
    }

    // Use ship definition defaults if not provided
    const currentWarpPower =
      shipData.current_warp_power ?? shipDefinition.warp_power_capacity;
    const currentShields = shipData.current_shields ?? shipDefinition.shields;
    const currentFighters =
      shipData.current_fighters ?? shipDefinition.fighters;

    // Check name uniqueness
    const existingCharacter = await supabase
      .from("characters")
      .select("character_id")
      .eq("name", name)
      .maybeSingle();

    if (existingCharacter.error) {
      console.error("character_create.name_check", existingCharacter.error);
      throw new CharacterCreateError("Failed to check character name", 500);
    }

    if (existingCharacter.data) {
      throw new CharacterCreateError(
        `Character name "${name}" already exists`,
        409,
      );
    }

    if (shipName) {
      const existingShipName = await supabase
        .from("ship_instances")
        .select("ship_id")
        .eq("ship_name", shipName)
        .maybeSingle();
      if (existingShipName.error) {
        console.error(
          "character_create.ship_name_check",
          existingShipName.error,
        );
        throw new CharacterCreateError("Failed to check ship name", 500);
      }
      if (existingShipName.data) {
        throw new CharacterCreateError(
          `Ship name "${shipName}" already exists`,
          409,
        );
      }
    }

    // Create character (without ship reference first)
    const { data: character, error: characterError } = await supabase
      .from("characters")
      .insert({
        name,
        current_ship_id: null,
        map_knowledge: {
          sectors_visited: {},
          total_sectors_visited: 0,
        },
        is_npc: false,
      })
      .select("character_id")
      .single();

    if (characterError || !character) {
      console.error("character_create.character_insert", characterError);
      throw new CharacterCreateError("Failed to create character", 500);
    }

    const characterId = character.character_id;

    const universeMeta = await loadUniverseMeta(supabase);
    const startSector = pickRandomFedspaceSector(
      universeMeta,
      DEFAULT_START_SECTOR,
    );

    // Create ship for character
    const { data: ship, error: shipError } = await supabase
      .from("ship_instances")
      .insert({
        owner_id: characterId,
        owner_type: "character",
        owner_character_id: characterId,
        ship_type: shipType,
        ship_name: shipName,
        current_sector: startSector,
        credits,
        cargo_qf: cargoQf,
        cargo_ro: cargoRo,
        cargo_ns: cargoNs,
        current_warp_power: currentWarpPower,
        current_shields: currentShields,
        current_fighters: currentFighters,
      })
      .select("ship_id")
      .single();

    if (shipError || !ship) {
      console.error("character_create.ship_insert", shipError);
      // Clean up character if ship creation fails
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to create ship", 500);
    }

    // Update character with ship reference
    const { error: updateError } = await supabase
      .from("characters")
      .update({ current_ship_id: ship.ship_id })
      .eq("character_id", characterId);

    if (updateError) {
      console.error("character_create.character_update", updateError);
      // Clean up on failure
      await supabase
        .from("ship_instances")
        .delete()
        .eq("ship_id", ship.ship_id);
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to link ship to character", 500);
    }

    // Log successful creation
    await logAdminAction(supabase, {
      action: "character_create",
      admin_user: "admin",
      target_id: characterId,
      payload,
      result: "success",
    });

    // Return success response
    return successResponse({
      character_id: characterId,
      name,
      player: {
        credits,
        player_type: playerType,
      },
      ship: {
        ship_id: ship.ship_id,
        ship_type: shipType,
        ship_name: shipName,
        current_sector: startSector,
        current_warp_power: currentWarpPower,
        current_shields: currentShields,
        current_fighters: currentFighters,
        cargo: {
          quantum_foam: cargoQf,
          retro_organics: cargoRo,
          neuro_symbolics: cargoNs,
        },
      },
    });
  } catch (err) {
    if (err instanceof CharacterCreateError) {
      await logAdminAction(supabase, {
        action: "character_create",
        payload,
        result: "error",
        error: err.message,
      });
      return errorResponse(err.message, err.status);
    }
    if (err instanceof RequestValidationError) {
      await logAdminAction(supabase, {
        action: "character_create",
        payload,
        result: "error",
        error: err.message,
      });
      return errorResponse(err.message, err.status);
    }
    console.error("character_create.unhandled", err);
    await logAdminAction(supabase, {
      action: "character_create",
      payload,
      result: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("internal server error", 500);
  }
});

async function loadShipDefinition(
  supabase: ReturnType<typeof createServiceRoleClient>,
  shipType: string,
): Promise<ShipDefinitionRow | null> {
  const { data, error } = await supabase
    .from("ship_definitions")
    .select("ship_type, warp_power_capacity, shields, fighters")
    .eq("ship_type", shipType)
    .maybeSingle();

  if (error) {
    console.error("character_create.ship_definition", error);
    return null;
  }

  return data as ShipDefinitionRow | null;
}
