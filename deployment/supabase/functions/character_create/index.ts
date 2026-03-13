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
import { traced } from "../_shared/weave.ts";

const DEFAULT_START_SECTOR = 0;
const DEFAULT_SHIP_TYPE = "sparrow_scout";
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

Deno.serve(traced("character_create", async (req, trace) => {
  const supabase = createServiceRoleClient();
  let payload;

  const sParse = trace.span("parse_request");
  try {
    payload = await parseJsonRequest(req);
    sParse.end();
  } catch (err) {
    sParse.end({ error: err instanceof Error ? err.message : String(err) });
    const response = respondWithError(err);
    if (response) {
      return response;
    }
    console.error("character_create.parse", err);
    return errorResponse("invalid JSON payload", 400);
  }

  // Validate admin password
  const sAdminAuth = trace.span("admin_auth");
  const adminPassword = optionalString(payload, "admin_password");
  const isValid = await validateAdminSecret(adminPassword);
  if (!isValid) {
    sAdminAuth.end({ error: "Invalid admin password" });
    await logAdminAction(supabase, {
      action: "character_create",
      payload,
      result: "error",
      error: "Invalid admin password",
    });
    return errorResponse("Invalid admin password", 403);
  }
  sAdminAuth.end();

  try {
    // Parse and validate request
    const sValidate = trace.span("validate_input");
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
    sValidate.end({ name, shipType });

    trace.setInput({ name, shipType, shipName, playerType, credits });

    // Validate ship type exists
    const sShipDef = trace.span("load_ship_definition");
    const shipDefinition = await loadShipDefinition(supabase, shipType);
    if (!shipDefinition) {
      sShipDef.end({ error: `Invalid ship type: ${shipType}` });
      throw new CharacterCreateError(`Invalid ship type: ${shipType}`, 400);
    }
    sShipDef.end({ ship_type: shipType });

    // Use ship definition defaults if not provided
    const currentWarpPower =
      shipData.current_warp_power ?? shipDefinition.warp_power_capacity;
    const currentShields = shipData.current_shields ?? shipDefinition.shields;
    const currentFighters =
      shipData.current_fighters ?? shipDefinition.fighters;

    // Check name uniqueness
    const sNameCheck = trace.span("check_name_uniqueness");
    const existingCharacter = await supabase
      .from("characters")
      .select("character_id")
      .eq("name", name)
      .maybeSingle();

    if (existingCharacter.error) {
      sNameCheck.end({ error: existingCharacter.error.message });
      console.error("character_create.name_check", existingCharacter.error);
      throw new CharacterCreateError("Failed to check character name", 500);
    }

    if (existingCharacter.data) {
      sNameCheck.end({ error: "Name exists" });
      throw new CharacterCreateError(
        `Character name "${name}" already exists`,
        409,
      );
    }
    sNameCheck.end();

    if (shipName) {
      const sShipNameCheck = trace.span("check_ship_name_uniqueness");
      const existingShipName = await supabase
        .from("ship_instances")
        .select("ship_id")
        .eq("ship_name", shipName)
        .maybeSingle();
      if (existingShipName.error) {
        sShipNameCheck.end({ error: existingShipName.error.message });
        console.error(
          "character_create.ship_name_check",
          existingShipName.error,
        );
        throw new CharacterCreateError("Failed to check ship name", 500);
      }
      if (existingShipName.data) {
        sShipNameCheck.end({ error: "Ship name exists" });
        throw new CharacterCreateError(
          `Ship name "${shipName}" already exists`,
          409,
        );
      }
      sShipNameCheck.end();
    }

    // Create character (without ship reference first)
    const sCreateChar = trace.span("create_character");
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
      sCreateChar.end({ error: characterError?.message ?? "No data" });
      console.error("character_create.character_insert", characterError);
      throw new CharacterCreateError("Failed to create character", 500);
    }
    sCreateChar.end({ character_id: character.character_id });

    const characterId = character.character_id;

    const universeMeta = await loadUniverseMeta(supabase);
    const startSector = pickRandomFedspaceSector(
      universeMeta,
      DEFAULT_START_SECTOR,
    );

    // Create ship for character
    const sCreateShip = trace.span("create_ship");
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
      sCreateShip.end({ error: shipError?.message ?? "No data" });
      console.error("character_create.ship_insert", shipError);
      // Clean up character if ship creation fails
      await supabase
        .from("characters")
        .delete()
        .eq("character_id", characterId);
      throw new CharacterCreateError("Failed to create ship", 500);
    }
    sCreateShip.end({ ship_id: ship.ship_id });

    // Update character with ship reference
    const sLinkShip = trace.span("link_ship_to_character");
    const { error: updateError } = await supabase
      .from("characters")
      .update({ current_ship_id: ship.ship_id })
      .eq("character_id", characterId);

    if (updateError) {
      sLinkShip.end({ error: updateError.message });
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
    sLinkShip.end();

    // Assign quests marked as assign_on_creation (e.g. tutorial)
    const sQuests = trace.span("assign_quests");
    const { data: autoQuests } = await supabase
      .from("quest_definitions")
      .select("code")
      .eq("assign_on_creation", true)
      .eq("enabled", true);

    if (autoQuests) {
      for (const quest of autoQuests) {
        await supabase.rpc("assign_quest", {
          p_player_id: characterId,
          p_quest_code: quest.code,
        });
      }
    }
    sQuests.end({ count: autoQuests?.length ?? 0 });

    // Log successful creation
    const sAuditLog = trace.span("audit_log");
    await logAdminAction(supabase, {
      action: "character_create",
      admin_user: "admin",
      target_id: characterId,
      payload,
      result: "success",
    });
    sAuditLog.end();

    trace.setOutput({ character_id: characterId, name, ship_id: ship.ship_id });

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
}));

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
