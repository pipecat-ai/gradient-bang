import type { SupabaseClient } from "@supabase/supabase-js";
import type { ShipRow } from "./status.ts";

export class ActorAuthorizationError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ActorAuthorizationError";
    this.status = status;
  }
}

export async function ensureActorAuthorization({
  supabase,
  ship,
  actorCharacterId,
  adminOverride,
  targetCharacterId,
  requireActorForCorporationShip = true,
}: {
  supabase: SupabaseClient;
  ship: ShipRow | null; // Allow null for operations that don't involve ships (e.g., messaging)
  actorCharacterId: string | null;
  adminOverride: boolean;
  targetCharacterId?: string | null;
  requireActorForCorporationShip?: boolean;
}): Promise<void> {
  if (adminOverride) {
    return;
  }

  // If no ship provided, only validate actor matches target (for non-ship operations like messaging)
  if (!ship) {
    if (
      actorCharacterId &&
      targetCharacterId &&
      actorCharacterId !== targetCharacterId
    ) {
      throw new ActorAuthorizationError(
        "actor_character_id must match character_id unless admin_override is true",
        403,
      );
    }
    return;
  }

  const resolvedTargetId =
    targetCharacterId ??
    ship.owner_character_id ??
    ship.owner_id ??
    ship.ship_id;

  if (ship.owner_type === "corporation") {
    if (requireActorForCorporationShip && !actorCharacterId) {
      throw new ActorAuthorizationError(
        "actor_character_id is required when controlling a corporation ship",
        400,
      );
    }
    if (!ship.owner_corporation_id) {
      throw new ActorAuthorizationError(
        "Corporation ship is missing ownership data",
        403,
      );
    }
    if (!actorCharacterId) {
      return;
    }
    const allowed = await ensureActorCanControlShip(
      supabase,
      actorCharacterId,
      ship,
    );
    if (!allowed) {
      throw new ActorAuthorizationError(
        "Actor is not authorized to control this corporation ship",
        403,
      );
    }
    return;
  }

  if (actorCharacterId && actorCharacterId !== resolvedTargetId) {
    throw new ActorAuthorizationError(
      "actor_character_id must match character_id unless admin_override is true",
      403,
    );
  }
}

export async function ensureActorCanControlShip(
  supabase: SupabaseClient,
  actorId: string,
  ship: ShipRow,
): Promise<boolean> {
  if (ship.owner_type !== "corporation" || !ship.owner_corporation_id) {
    return false;
  }
  const { data, error } = await supabase
    .from("corporation_members")
    .select("character_id")
    .eq("corp_id", ship.owner_corporation_id)
    .eq("character_id", actorId)
    .is("left_at", null)
    .maybeSingle();
  if (error) {
    console.error("actors.ensure_control", error);
    throw new Error("Failed to verify actor permissions");
  }
  return Boolean(data);
}
